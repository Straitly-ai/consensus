import { createHash } from "node:crypto";
import { env } from "../lib/env.ts";
import { logger } from "../lib/log.ts";
import { isoFromEpoch } from "../lib/types.ts";
import { meterStore, newMeter, type Meter } from "../lib/meter.ts";
import { Semaphore, sleep, within } from "./limit.ts";
import { collectReddit, fetchRedditProfiles, fetchSubredditInfo } from "./reddit.ts";
import { collectX } from "./x.ts";
import { buildThemes } from "./themes.ts";
import { countIssues, reconcileThemes } from "./counts.ts";
import { PICKS_CHUNK, isRealPick, otherPicks, planPicks, tallyPicks, type PostPick } from "./picks.ts";
import {
  SORT_BATCH,
  optionsModel,
  reasonsModel,
  sampleForOptions,
  sortBatch,
  sortModel,
  splitOther,
  deepenOther,
  OffTopicError,
  writeOptions,
  writeOptionsFromQuestion,
  writeReason,
  type Label,
  type Option,
} from "./sort.ts";
import { INTENTS, type Author, type Intent, type Poll, type PollOption, type Post, type RawPost, type SearchRequest, type V3Event, type V3Source } from "./types.ts";

const log = logger("v3");

/** Netlify cuts streams at 60s; every stage is bounded so `done` always lands before that. */
const OPTIONS_AT_MS = Number(process.env.OPTIONS_AT_MS ?? 6_500);
const SORT_DEADLINE_MS = Number(process.env.SORT_DEADLINE_MS ?? 40_000);
const SPLIT_LATEST_MS = 36_000;
/** Second Other pass runs only when Other is still above this share, and never starts after this point. */
const DEEPEN_OTHER_SHARE = Number(process.env.DEEPEN_OTHER_SHARE ?? 0.3);
const DEEPEN_LATEST_MS = 40_000;
const FINISH_BY_MS = Number(process.env.FINISH_BY_MS ?? 52_000);
const POLL_EVERY_MS = 700;
/** Options backed by fewer opinions (or a smaller share) than this are folded into Other in the final poll. */
const MIN_OPTION_COUNT = 2;
const MIN_OPTION_SHARE = 0.03;
const MIN_OPTION_SHARE_LONG_TAIL = 0.012;
/** Shared by every search on this function instance. */
const llmGate = new Semaphore(env.llmConcurrency);
/** KAN-408 pick tally ("best X" only): its own gate so it never delays the sorter or the first poll. */
const picksGate = new Semaphore(Number(process.env.PICKS_CONCURRENCY ?? Math.min(60, env.llmConcurrency)));
const PICKS_WAIT_MS = Number(process.env.PICKS_WAIT_MS ?? 5_000);
/** Most posts each source may send to the sorter; past this, extra posts cost money but barely move the poll. */
const POOL_CAP: Record<V3Source, number> = { reddit: Number(process.env.POOL_CAP_REDDIT ?? 3500), x: Number(process.env.POOL_CAP_X ?? 4500) };
/** Replies this short ("this", "lol", "+1") almost never carry a stance the sorter can use. */
const MIN_WORDS = 3;

export const OTHER_ID = "other";

export function searchId(req: Pick<SearchRequest, "query" | "since" | "until" | "sources">): string {
  const key = [req.query.trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, ""), req.since ?? "", req.until ?? "", [...req.sources].sort().join(",")].join("|");
  return createHash("sha256").update(key).digest("base64url").slice(0, 16);
}

/** Async queue: producers push events from callbacks, the generator yields them in order. */
class Channel<T> {
  private items: T[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  push(item: T) {
    if (this.closed) return;
    this.items.push(item);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) yield this.items.shift()!;
      else if (this.closed) return;
      else await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface OptionState extends Option {
  id: string;
}

const engagement = (p: RawPost) => 1 + Math.log1p(Math.max(0, p.score));
/** Newer answers rank higher inside an option: half weight after about 18 months, never below 0.35. */
const recency = (p: RawPost) => (p.created_utc ? Math.max(0.35, Math.pow(0.5, (Date.now() / 1000 - p.created_utc) / (548 * 86_400))) : 0.6);
const X_MAX_WEIGHT_RATIO = 2 / 3; // X at most 40% of the engagement-weighted poll when Reddit is present.

/**
 * KAN-410 relevance, 0..1: directness (sorter strength; strength-1 votes were right only 27% of the time) 45%,
 * agreement of the three sort models 25%, recency 15% (inside the date filter when there is one, else an 18-month
 * half-life), engagement 15% (log-damped, saturating near 1k likes/upvotes).
 */
const DIRECT: Record<number, number> = { 3: 1, 2: 0.7, 1: 0.25, 0: 0 };
export function relevanceOf(p: RawPost, l: { strength: number; agree?: number }, window: { sinceEpoch: number; untilEpoch: number }, now = Date.now() / 1000): number {
  const direct = DIRECT[l.strength] ?? 0;
  const agree = l.agree ?? 0.6;
  let fresh = 0.5;
  if (p.created_utc) {
    const end = Math.min(now, window.untilEpoch);
    fresh = window.sinceEpoch > 0 && end > window.sinceEpoch ? 0.3 + 0.7 * Math.max(0, Math.min(1, (p.created_utc - window.sinceEpoch) / (end - window.sinceEpoch))) : Math.pow(0.5, Math.max(0, now - p.created_utc) / (548 * 86_400));
  }
  const eng = Math.min(1, Math.log1p(Math.max(0, p.score)) / Math.log1p(1000));
  return Math.round((0.45 * direct + 0.25 * agree + 0.15 * fresh + 0.15 * eng) * 1000) / 1000;
}

export function runV3(req: SearchRequest): AsyncGenerator<V3Event> {
  const out = new Channel<V3Event>();
  const m = newMeter();
  meterStore.run(m, () => {
    pipeline(req, m, (e) => out.push(e))
      .catch((e) => {
        log.error("search failed", { error: String(e), stack: (e as Error)?.stack });
        out.push({ event: "error", data: { message: "Something went wrong while building this poll. Please try again.", detail: String(e).slice(0, 300) } });
      })
      .finally(() => out.close());
  });
  return out[Symbol.asyncIterator]();
}

async function pipeline(req: SearchRequest, m: Meter, emit: (e: V3Event) => void) {
  const t0 = Date.now();
  const elapsed = () => Date.now() - t0;
  const abort = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, abort.signal]) : abort.signal;
  const timing: Record<string, number> = {};
  const mark = (k: string) => (timing[k] ??= elapsed());

  const sinceEpoch = req.since ? Date.parse(`${req.since}T00:00:00Z`) / 1000 : 0;
  const untilEpoch = req.until ? Date.parse(`${req.until}T00:00:00Z`) / 1000 + 86_400 : Number.POSITIVE_INFINITY;
  const window = { since: req.since, until: req.until, sinceEpoch, untilEpoch };
  const id = searchId(req);
  emit({ event: "meta", data: { id, query: req.query, since: req.since ?? null, until: req.until ?? null, sources: req.sources, cached: false, started_at: new Date(t0).toISOString() } });

  // ------------------------------------------------------------ pool
  const pool: RawPost[] = [];
  /** Eval only (DUMP_POOL=<dir>): when each post joined the pool, so a replay can rebuild the options-time pool. */
  const arrivedAt = new Map<string, number>();
  const ids = new Set<string>();
  const texts = new Set<string>();
  const perAuthor = new Map<string, number>();
  const threads = new Set<string>();
  const dropped = { duplicate: 0, author_cap: 0, prefiltered: 0 };
  const perSource: Record<V3Source, number> = { reddit: 0, x: 0 };
  let pending: RawPost[] = [];
  let kickSort: () => void = () => {};

  /** Dedupe by id and by text (copy-paste bots), cap any one author at 5% of the pool (min 3, as in the backtest). */
  const ingest = (posts: RawPost[]) => {
    for (const p of posts) {
      if (ids.has(p.id)) continue;
      ids.add(p.id);
      // Thread openers stay (they give the sorter context); everything else needs a few real words.
      if (perSource[p.source] >= POOL_CAP[p.source] || (p.kind !== "opener" && p.text.split(/\s+/).filter((w) => /\w/.test(w)).length < MIN_WORDS)) {
        dropped.prefiltered++;
        continue;
      }
      // Near-duplicates: same words once mentions, links and numbers are stripped (copy-paste bots, quote spam).
      const key = `${p.source}:${p.text.toLowerCase().replace(/@\w+|https?:\/\/\S+|\d+/g, " ").replace(/\W+/g, " ").trim().slice(0, 120)}`;
      if (p.text.length > 30 && texts.has(key)) {
        dropped.duplicate++;
        continue;
      }
      texts.add(key);
      const a = p.author.handle;
      if (a && a !== "[deleted]") {
        const n = (perAuthor.get(`${p.source}:${a}`) ?? 0) + 1;
        if (n > Math.max(3, Math.floor(pool.length * 0.05))) {
          dropped.author_cap++;
          continue;
        }
        perAuthor.set(`${p.source}:${a}`, n);
      }
      if (p.thread_url) threads.add(p.thread_url);
      pool.push(p);
      arrivedAt.set(p.id, elapsed());
      perSource[p.source]++;
      pending.push(p);
    }
    kickSort();
  };

  const want = (s: V3Source) => req.sources.includes(s);
  let redditDone = !want("reddit");
  let xDone = !want("x");
  let redditInfo: Awaited<ReturnType<typeof collectReddit>> | null = null;
  let xInfo: Awaited<ReturnType<typeof collectX>> | null = null;

  const redditTask = want("reddit")
    ? collectReddit(req.query, window, (t) => ingest(t.posts), () => mark("reddit_search"), signal)
        .then((r) => (redditInfo = r))
        .catch((e) => log.error("reddit failed", { error: String(e) }))
        .finally(() => {
          redditDone = true;
          mark("reddit_done");
          kickSort();
        })
    : Promise.resolve();
  const xTask = want("x")
    ? collectX(req.query, window, ingest, signal)
        .then((r) => (xInfo = r))
        .catch((e) => log.error("x failed", { error: String(e) }))
        .finally(() => {
          xDone = true;
          mark("x_done");
          kickSort();
        })
    : Promise.resolve();
  const collecting = () => !(redditDone && xDone);

  // ------------------------------------------------------------ progress ticker
  let stage = "searching";
  let sortedCount = 0;
  const progress = () =>
    emit({
      event: "progress",
      data: {
        stage,
        elapsed_ms: elapsed(),
        reddit: { threads: threads.size, posts: pool.filter((p) => p.source === "reddit").length, done: redditDone },
        x: { posts: pool.filter((p) => p.source === "x").length, done: xDone },
        sorted: sortedCount,
        pool: pool.length,
      },
    });
  const ticker = setInterval(progress, 1_000);

  try {
    // ---------------------------------------------------------- buckets
    // Written from a spread of real posts once enough has arrived (more posts = better buckets, later = slower poll).
    while (true) {
      const t = elapsed();
      const comments = pool.filter((p) => p.kind !== "opener").length;
      if (!collecting() || (t >= OPTIONS_AT_MS && comments >= 80) || (t >= OPTIONS_AT_MS + 3_000 && comments >= 25) || t >= 15_000 || threads.size >= 12) break;
      await sleep(150);
    }
    stage = "writing_options";
    progress();
    mark("options_start");
    let base: Option[] = [];
    // Leads are only meaningful when people buy the thing asked about; unknown counts as purchasable.
    let purchasable = true;
    let qtype: string | undefined;
    const sample = sampleForOptions(pool);
    const sampleIds = sample.map((p) => p.id);
    try {
      if (sample.length >= 10) {
        const w = await writeOptions(req.query, sample, signal);
        if (w.purchasable === false) purchasable = false;
        qtype = w.qtype;
        base = w;
      } else base = await writeOptionsFromQuestion(req.query, signal);
    } catch (e) {
      // Every question gets a poll: an "off-topic" sample (often an early, narrow or ambiguous one) is not a reason to stop.
      // Options are written from the question instead and the sorter still drops posts that are not about it.
      log.warn(e instanceof OffTopicError ? "sample judged off-topic; writing options from the question" : "options failed, retrying from the question", { error: String(e), pool: pool.length });
      timing.options_fallback = 1;
      base = await writeOptionsFromQuestion(req.query, signal).catch(() => []);
      if (!base.length) base = await writeOptionsFromQuestion(req.query, signal).catch(() => []);
    }
    if (!base.length) base = genericOptions(req.query);
    const options: OptionState[] = base.map((o, i) => ({ ...o, id: `o${i}` }));
    const other: OptionState = { id: OTHER_ID, title: "Other", description: "Opinions that fit none of the options above." };
    mark("options_done");
    const planEvent = () => ({ event: "plan" as const, data: { options: [...options, other].map(({ id, title, description }) => ({ id, title, description, is_other: id === OTHER_ID })) } });
    emit(planEvent());
    const liveBase = options.map(({ title, description }) => ({ title, description }));

    // ---------------------------------------------------------- sorting
    stage = "sorting";
    const labels = new Map<string, Label & { option: string | null }>();
    const unsorted: RawPost[] = [];
    const shown = new Map<string, Post>();
    // Eval only (DEBUG_POOL=1): a sample of what the sorter threw away, so a judge can measure missed opinions.
    const debugPool = process.env.DEBUG_POOL === "1";
    const discarded: { id: string; source: string; bucket: string; text: string; thread: string | null; community: string | null }[] = [];
    let removed = 0;
    let noStance = 0;
    let lastPoll = 0;
    const optionFor = (l: Label): string | null => (typeof l.bucket === "number" ? options[l.bucket]!.id : l.bucket === "other" ? OTHER_ID : null);
    const toPost = (p: RawPost, l: Label & { option: string | null }): Post => {
      const { created_utc, parent_text: _parent, ...rest } = p;
      // rank = how strongly it answers (strength) x engagement x recency.
      return { ...rest, created_at: isoFromEpoch(created_utc), option: l.option, strength: l.strength, intent: l.intent, rank: Math.round(l.strength * engagement(p) * recency(p) * 100) / 100, relevance: relevanceOf(p, l, window) };
    };

    const snapshot = (final: boolean): Poll => {
      const all = [...options, other];
      const stat = new Map(all.map((o) => [o.id, { count: 0, reddit: 0, x: 0, intents: Object.fromEntries(INTENTS.map((i) => [i, 0])) as Record<Intent, number>, w: { reddit: 0, x: 0 } }]));
      const leads = Object.fromEntries(INTENTS.map((i) => [i, 0])) as Record<Intent, number>;
      let leadTotal = 0;
      const opinionsBy = { reddit: 0, x: 0 };
      for (const post of shown.values()) {
        if (post.intent) {
          leads[post.intent]++;
          leadTotal++;
        }
        const s = post.option ? stat.get(post.option) : undefined;
        if (!s) continue;
        s.count++;
        s[post.source]++;
        opinionsBy[post.source]++;
        if (post.intent) s.intents[post.intent]++;
        s.w[post.source] += 1 + Math.log1p(Math.max(0, post.score));
      }
      const total = [...stat.values()].reduce((a, s) => a + s.count, 0);
      const wr = [...stat.values()].reduce((a, s) => a + s.w.reddit, 0);
      const wx = [...stat.values()].reduce((a, s) => a + s.w.x, 0);
      const xScale = wr > 0 && wx > wr * X_MAX_WEIGHT_RATIO ? (wr * X_MAX_WEIGHT_RATIO) / wx : 1;
      const wTotal = wr + wx * xScale;
      const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
      const rows: PollOption[] = all.map((o, index) => {
        const s = stat.get(o.id)!;
        return {
          id: o.id,
          index,
          title: o.title,
          description: o.description,
          is_other: o.id === OTHER_ID,
          count: s.count,
          percent: pct(s.count, total),
          weighted_percent: pct(s.w.reddit + s.w.x * xScale, wTotal),
          by_source: { reddit: s.reddit, x: s.x },
          intents: s.intents,
          leads: Object.values(s.intents).reduce((a, b) => a + b, 0),
        };
      });
      // Real options by size; Other always last.
      rows.sort((a, b) => Number(a.is_other) - Number(b.is_other) || b.count - a.count);
      const xKept = pool.filter((p) => p.source === "x").length;
      const redditPosts = pool.length - xKept;
      const xFetched = Math.max(xKept, Number((xInfo as any)?.raw ?? 0));
      return {
        final,
        total_opinions: total,
        options: rows,
        sources: {
          reddit: { threads: threads.size, opinions: opinionsBy.reddit },
          x: { posts: xKept, opinions: opinionsBy.x },
        },
        scanned: { total: redditPosts + xFetched, reddit_threads: threads.size, reddit_posts: redditPosts, x_fetched: xFetched, x_kept: xKept },
        leads: { total: leadTotal, ...leads },
        pool: { collected: pool.length, sorted: sortedCount, unsorted: unsorted.length, removed_spam: removed, no_stance: noStance, duplicates: dropped.duplicate, author_capped: dropped.author_cap, prefiltered: dropped.prefiltered },
      };
    };
    const maybePoll = (force = false) => {
      if (!force && Date.now() - lastPoll < POLL_EVERY_MS) return;
      lastPoll = Date.now();
      emit({ event: "poll", data: snapshot(false) });
    };

    const inflight = new Set<Promise<void>>();
    const sortDeadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, SORT_DEADLINE_MS - elapsed()))]);
    // KAN-408: on "best X" questions every opinion's named pick(s) are written down while sorting goes on.
    const tallyOn = qtype === "best_x" && process.env.PICKS !== "0";
    const pickOf = new Map<string, PostPick>();
    let pickQueue: RawPost[] = [];
    const pickJobs = new Set<Promise<void>>();
    const tallyTitles = options.map((o) => o.title);
    const flushPicks = (all = false) => {
      while (pickQueue.length >= PICKS_CHUNK || (all && pickQueue.length)) {
        const chunk = pickQueue.splice(0, PICKS_CHUNK);
        const job = picksGate
          .run(() => tallyPicks(req.query, tallyTitles, chunk, signal))
          .then((got) => chunk.forEach((p, i) => got[i] && pickOf.set(p.id, got[i]!)))
          .finally(() => pickJobs.delete(job));
        pickJobs.add(job);
      }
    };
    const runBatch = (batch: RawPost[]) => {
      const job = llmGate
        .run(() => (sortDeadline.aborted ? Promise.resolve(new Array(batch.length)) : sortBatch(req.query, options, batch, sortDeadline)))
        .then((got) => {
          const fresh: Post[] = [];
          batch.forEach((p, i) => {
            const g = got[i];
            const l = g && !purchasable && g.intent ? { ...g, intent: null } : g;
            if (!l) {
              unsorted.push(p);
              return;
            }
            sortedCount++;
            const lab = { ...l, option: optionFor(l) };
            labels.set(p.id, lab);
            if (debugPool && !lab.option && discarded.length < 4000)
              discarded.push({ id: p.id, source: p.source, bucket: String(l.bucket), text: p.text.slice(0, 500), thread: p.thread_title, community: p.community });
            if (l.bucket === "drop") removed++;
            else if (!lab.option && !l.intent) noStance++;
            else {
              const post = toPost(p, lab);
              shown.set(p.id, post);
              fresh.push(post);
              if (tallyOn && lab.option) pickQueue.push(p);
            }
          });
          if (tallyOn) flushPicks();
          if (fresh.length) emit({ event: "posts", data: { posts: fresh } });
          if (!timing.first_poll && shown.size >= 5) {
            mark("first_poll");
            maybePoll(true);
          } else maybePoll();
        })
        .finally(() => inflight.delete(job));
      inflight.add(job);
    };
    // Full batches go out as soon as they fill; leftovers are flushed when collection ends or after a short lull.
    let lull: NodeJS.Timeout | undefined;
    kickSort = () => {
      while (pending.length >= SORT_BATCH) runBatch(pending.splice(0, SORT_BATCH));
      clearTimeout(lull);
      if (pending.length) lull = setTimeout(() => pending.length && runBatch(pending.splice(0, pending.length)), collecting() ? 1_200 : 0);
    };
    kickSort();

    await within(Promise.all([redditTask, xTask]), SORT_DEADLINE_MS - elapsed(), undefined);
    if (collecting()) {
      log.warn("collection still running at the sort deadline; finishing with what is in");
      abort.abort();
    }
    kickSort();
    clearTimeout(lull);
    if (pending.length) runBatch(pending.splice(0, pending.length));
    while (inflight.size) await Promise.all([...inflight]);
    mark("sort_done");

    // Lead avatars and subreddit icons only need the sorted posts, so they load while buckets are refined.
    const EXTRAS_MS = 6_000;
    // KAN-422: leads first, then the top-ranked visible Reddit authors taken round-robin across options.
    const visibleReddit = [...shown.values()].filter((p) => p.source === "reddit" && p.author.handle !== "[deleted]");
    const byOption = new Map<string, Post[]>();
    for (const p of visibleReddit) if (p.option) (byOption.get(p.option) ?? byOption.set(p.option, []).get(p.option)!).push(p);
    const lanes = [...byOption.values()].map((l) => l.sort((a, b) => b.rank - a.rank));
    const ordered: Post[] = visibleReddit.filter((p) => p.intent);
    for (let i = 0; lanes.some((l) => i < l.length); i++) for (const l of lanes) { const p = l[i]; if (p) ordered.push(p); }
    const leadHandles = [...new Set(ordered.map((p) => p.author.handle))].slice(0, Number(process.env.R_PROFILE_MAX ?? 200));
    const profileJob = leadHandles.length
      ? fetchRedditProfiles(leadHandles, EXTRAS_MS).then((profiles) => {
          if (Object.keys(profiles).length) emit({ event: "authors", data: { source: "reddit", profiles } });
        })
      : Promise.resolve();
    const subs = [...new Set([...shown.values()].filter((p) => p.source === "reddit" && p.community).map((p) => p.community!))].slice(0, 40);
    const subJob = subs.length
      ? fetchSubredditInfo(subs, EXTRAS_MS).then((communities) => {
          if (Object.keys(communities).length) emit({ event: "communities", data: { communities } });
        })
      : Promise.resolve();

    // ---------------------------------------------------------- refine buckets
    stage = "refining";
    const optionPosts = (oid: string) => [...shown.values()].filter((p) => p.option === oid);
    const reassigned: Post[] = [];
    // KAN-408: "best X" options re-selected from the pick tally (top picks by real support across all posts).
    let planned = false;
    let otherPickCount: number | undefined;
    if (tallyOn) {
      flushPicks(true);
      await within(Promise.all([...pickJobs]), Math.min(PICKS_WAIT_MS, Math.max(1_500, FINISH_BY_MS - 14_000 - elapsed())), undefined);
      const opinionPosts = [...shown.values()].filter((p) => p.option);
      timing.picks_tallied = opinionPosts.filter((p) => pickOf.has(p.id)).length;
      mark("picks_done");
      if (opinionPosts.length >= 40 && timing.picks_tallied >= opinionPosts.length * 0.7) {
        const plan = planPicks(req.query, options, opinionPosts.map((p) => ({ id: p.id, option: p.option!, pick: pickOf.get(p.id) })));
        // New ids keep a free colour slot (the UI colours by the id's number mod 8) and never reuse an old id.
        const usedSlots = new Set(plan.keep.map((id) => (parseInt(id.replace(/\D/g, ""), 10) || 0) % 8));
        const newIds = plan.added.map(() => {
          let s = 0;
          while (usedSlots.has(s) && s < 8) s++;
          usedSlots.add(s);
          return `o${8 + s}p`;
        });
        const kept = options.filter((o) => plan.keep.includes(o.id)).sort((a, b) => plan.keep.indexOf(a.id) - plan.keep.indexOf(b.id));
        options.splice(0, options.length, ...kept, ...plan.added.map((o, j) => ({ ...o, id: newIds[j]! })));
        for (const [id, to] of plan.assign) {
          const post = shown.get(id);
          if (!post) continue;
          if (to === null) {
            if (pickOf.get(id)?.code === "W") removed++;
            else noStance++;
          }
          post.option = to === null ? null : to.startsWith("new:") ? newIds[Number(to.slice(4))]! : to;
          reassigned.push(post);
        }
        planned = true;
        Object.assign(timing, { picks_mode: plan.mode === "kinds" ? 2 : 1, picks_added: plan.added.length, picks_moved: plan.assign.size, picks_dropped_wrong_place: plan.stats.dropped_wrong_place, picks_dropped_non_answer: plan.stats.dropped_non_answer, picks_coverage: plan.stats.pick_coverage, kinds_coverage: plan.stats.kind_coverage });
      }
    }
    const otherPosts = optionPosts(OTHER_ID);
    const opinionTotal = [...shown.values()].filter((p) => p.option).length;
    if (!planned && otherPosts.length >= Math.max(8, opinionTotal * 0.1) && elapsed() < SPLIT_LATEST_MS && options.length < 8) {
      const ordered = otherPosts.sort((a, b) => b.rank - a.rank);
      const byId = new Map(pool.map((r) => [r.id, r]));
      const split = await within(splitOther(req.query, options, ordered.map((p) => byId.get(p.id)!), signal), Math.max(4_000, Math.min(8_000, FINISH_BY_MS - 8_000 - elapsed())), { added: [], assign: new Map<number, number>() });
      const targets = [...options.map((o) => o.id)];
      for (const o of split.added) {
        const opt = { ...o, id: `o${options.length}` };
        options.push(opt);
        targets.push(opt.id);
      }
      split.assign.forEach((to, i) => {
        const post = ordered[i];
        if (post && targets[to]) {
          post.option = targets[to]!;
          reassigned.push(post);
        }
      });
      timing.split_moved = reassigned.length;
      timing.split_added = split.added.length;
      mark("split_done");
    }
    // Long-tail "best X" answers: if Other is still over 30%, one more pass adds concrete picks (bounded to ~6s).
    const otherNow = optionPosts(OTHER_ID);
    const opinionsMid = [...shown.values()].filter((p) => p.option).length;
    timing.other_pct_before_deepen = opinionsMid ? Math.round((otherNow.length / opinionsMid) * 1000) / 10 : 0;
    if (!planned && opinionsMid >= 40 && otherNow.length > opinionsMid * DEEPEN_OTHER_SHARE && elapsed() < DEEPEN_LATEST_MS) {
      const ordered = otherNow.sort((a, b) => b.rank - a.rank);
      const byId = new Map(pool.map((r) => [r.id, r]));
      const t0 = elapsed();
      const deep = await within(deepenOther(req.query, options, ordered.map((p) => byId.get(p.id)!), signal), 8_000, { added: [], assign: new Map<number, number>() });
      const targets = options.map((o) => o.id);
      for (const o of deep.added) {
        const opt = { ...o, id: `o${options.length}d` };
        options.push(opt);
        targets.push(opt.id);
      }
      let moved = 0;
      deep.assign.forEach((to, i) => {
        const post = ordered[i];
        if (post && targets[to]) {
          post.option = targets[to]!;
          reassigned.push(post);
          moved++;
        }
      });
      timing.deepen_ms = elapsed() - t0;
      timing.deepen_added = deep.added.length;
      timing.deepen_moved = moved;
      timing.other_pct_after_deepen = Math.round((optionPosts(OTHER_ID).length / opinionsMid) * 1000) / 10;
    }
    // Options too small to show are folded into Other.
    const folded: { title: string; count: number }[] = [];
    const opinionsNow = [...shown.values()].filter((p) => p.option).length;
    // Long-tail "best X" polls: real picks each hold 1-3%, so a 3% floor would hide them all inside Other.
    const otherShare = opinionsNow ? optionPosts(OTHER_ID).length / opinionsNow : 0;
    const longTail = otherShare > 0.25 || options.length > 6;
    const minShare = longTail ? MIN_OPTION_SHARE_LONG_TAIL : MIN_OPTION_SHARE;
    // Thin pools (sparse round 4, "best vc for b2b saas": 9 opinions spread over 7 options) would fold every option
    // away and leave a poll that is only Other; the two biggest options with 2+ votes always stay.
    const passes = (o: (typeof options)[number]) => optionPosts(o.id).length >= Math.max(longTail ? 5 : MIN_OPTION_COUNT, Math.ceil(opinionsNow * minShare));
    const keepAlways = new Set(
      (options.some(passes) ? [] : [...options])
        .sort((a, b) => optionPosts(b.id).length - optionPosts(a.id).length)
        .filter((o) => optionPosts(o.id).length >= 2)
        .slice(0, 2)
        .map((o) => o.id),
    );
    for (const o of [...options]) {
      const ps = optionPosts(o.id);
      if (keepAlways.has(o.id) || passes(o)) continue;
      options.splice(options.indexOf(o), 1);
      if (ps.length >= 3) folded.push({ title: o.title, count: ps.length });
      for (const p of ps) {
        p.option = OTHER_ID;
        reassigned.push(p);
      }
    }
    // At most 6 real options on screen: the smallest beyond that go to Other.
    const MAX_SHOWN = longTail ? 8 : 6;
    if (options.length > MAX_SHOWN) {
      const bySize = [...options].sort((a, b) => optionPosts(b.id).length - optionPosts(a.id).length);
      for (const o of bySize.slice(MAX_SHOWN)) {
        options.splice(options.indexOf(o), 1);
        if (optionPosts(o.id).length >= 3) folded.push({ title: o.title, count: optionPosts(o.id).length });
        for (const p of optionPosts(o.id)) {
          p.option = OTHER_ID;
          reassigned.push(p);
        }
      }
    }
    if (!options.length) log.warn("no option kept 2+ opinions");
    emit(planEvent());
    if (reassigned.length) emit({ event: "posts", data: { posts: reassigned, updated: true } });
    const finalPoll = snapshot(true);
    if (planned) {
      // Named picks still inside Other (including folded options' posts), aliases merged.
      const names = optionPosts(OTHER_ID).flatMap((p) => {
        const k = pickOf.get(p.id);
        return isRealPick(req.query, k) ? [k.picks[0]!] : [];
      });
      const left = otherPicks(req.query, names);
      if (left.breakdown.length) finalPoll.other_breakdown = left.breakdown;
      otherPickCount = left.distinct;
      if (otherPickCount) finalPoll.other_picks = otherPickCount;
    } else if (folded.length) finalPoll.other_breakdown = folded.sort((a, b) => b.count - a.count).slice(0, 8);
    // KAN-422 follow-up: options added or refilled during refine missed the first profile pass; cover each final
    // option's top 10 Reddit authors (usually a few dozen new handles, mostly cached), in parallel with the summaries.
    const asked = new Set(leadHandles);
    const lateHandles = [
      ...new Set(
        [...options.map((o) => o.id), OTHER_ID].flatMap((oid) =>
          optionPosts(oid)
            .filter((p) => p.source === "reddit" && p.author.handle !== "[deleted]")
            .sort((a, b) => b.rank - a.rank)
            .slice(0, 10)
            .map((p) => p.author.handle),
        ),
      ),
    ].filter((h) => !asked.has(h));
    const lateProfileJob = lateHandles.length
      ? fetchRedditProfiles(lateHandles, 2_500).then((profiles) => {
          if (Object.keys(profiles).length) emit({ event: "authors", data: { source: "reddit", profiles } });
        })
      : Promise.resolve();
    timing.late_profiles = lateHandles.length;
    // KAN-409: the final poll must equal what is listed; any drift is logged (and counted in done.count_issues).
    const pollIssues = countIssues(finalPoll, shown.values());
    if (pollIssues.length) log.warn("poll count mismatch", { query: req.query, issues: pollIssues.slice(0, 10) });
    emit({ event: "poll", data: finalPoll });
    mark("final_poll");

    // ---------------------------------------------------------- reasons + lead profiles, in parallel
    stage = "writing_reasons";
    // Summaries for every option run at once; each streams as soon as it is written.
    const budget = Math.min(8_000, FINISH_BY_MS - elapsed());
    const reasonJobs = [...options, other].map(async (o) => {
      const ps = optionPosts(o.id).sort((a, b) => b.rank - a.rank);
      // Strongest takes first, both sources represented.
      const mix = [...ps.filter((p) => p.source === "reddit").slice(0, 28), ...ps.filter((p) => p.source === "x").slice(0, 12)];
      const r = await within(writeReason(req.query, o, mix.map((p) => ({ ...p, created_utc: null })), signal), budget, null);
      if (r) emit({ event: "reasons", data: r });
    });
    // Detailed, overlapping themes run alongside the summaries under the same budget.
    let themeCount = 0;
    let themeIssues = 0;
    const themeJob = process.env.THEMES === "0"
      ? Promise.resolve()
      : buildThemes(req.query, [...options, other].map(({ id, title }) => ({ id, title })), [...shown.values()].filter((p) => p.option), budget, signal)
          .then((themes) => {
            // Counts are rebuilt from the posts' final options so every theme number equals its filtered list.
            const fixed = reconcileThemes(themes, shown, finalPoll.total_opinions);
            themeIssues = countIssues(finalPoll, shown.values(), themes).filter((i) => i.where.startsWith("theme")).length;
            if (themeIssues) log.warn("theme counts fixed", { query: req.query, issues: themeIssues });
            themes = fixed;
            themeCount = themes.length;
            emit({ event: "themes", data: { themes } });
          })
          .catch((e) => log.warn("themes failed", { error: String(e).slice(0, 200) }));
    await within(Promise.all([Promise.all(reasonJobs), themeJob]), budget + 500, undefined);
    timing.themes = themeCount;
    // Avatars and icons had since sort_done; give them at most 1s more after the summaries.
    await within(Promise.all([profileJob, subJob, lateProfileJob]), 1_000, undefined);
    mark("reasons_done");

    stage = "done";
    const cost = { llm_usd: round(m.llmUsd), x_usd: round(m.xUsd), serper_usd: round(m.serperCredits * 0.001), total_usd: round(m.llmUsd + m.xUsd + m.serperCredits * 0.001) };
    // "thin" lets the UI show a "not much data for this question" note instead of a misleading poll.
    const status = finalPoll.total_opinions === 0 ? "empty" : finalPoll.total_opinions < 20 ? "thin" : "ok";
    // Plain flags the UI can show as "not much data" notes; also logged so odd runs can be found later.
    const otherRow = finalPoll.options.find((o) => o.is_other);
    const realOptions = finalPoll.options.filter((o) => !o.is_other && o.count > 0).length;
    const flags: string[] = [];
    if (finalPoll.total_opinions < 20) flags.push("thin_pool");
    else if (finalPoll.total_opinions < 60) flags.push("small_pool");
    if ((otherRow?.percent ?? 0) >= 60) flags.push("other_heavy");
    if (realOptions <= 1) flags.push("one_option");
    if (want("x") && !(xInfo as any)?.kept) flags.push("x_empty");
    if (want("reddit") && !(redditInfo as any)?.threadsFetched) flags.push("reddit_empty");
    if (m.xRetries > 40) flags.push("x_retries");
    if (m.llmUsd + m.xUsd > 1) flags.push("cost_spike");
    if (flags.length) log.info("quality flags", { query: req.query, flags });
    if (process.env.DUMP_POOL) await dumpPool(process.env.DUMP_POOL, { req, pool, arrivedAt, sampleIds, liveBase, purchasable, labels, threads: threads.size, dropped, timing, x_raw: (xInfo as any)?.raw ?? null });
    emit({
      event: "done",
      data: {
        id,
        status: status === "ok" && flags.some((f) => f === "other_heavy" || f === "one_option") ? "thin" : status,
        quality: { flags, purchasable },
        total_ms: elapsed(),
        timing,
        cost,
        poll: { total_opinions: finalPoll.total_opinions, leads: finalPoll.leads.total },
        pool: finalPoll.pool,
        count_issues: { poll: pollIssues.length, themes_fixed: themeIssues },
        searches: { reddit: (redditInfo as any)?.queries ?? [], x: (xInfo as any)?.queries ?? [] },
        x_pool: xPoolStats(xInfo, shown),
        reddit_pool: redditInfo ? { found: (redditInfo as any).threadsFound, kept_by_filter: (redditInfo as any).threadsKept, fetched: (redditInfo as any).threadsFetched } : null,
        calls: { llm: m.llmCalls, llm_failed: m.llmFailed, x: m.xCalls, x_retries: m.xRetries, x_failed: m.xFailed, serper: m.serperCalls, reddit_threads: m.redditFetches, reddit_failed: m.redditFailed },
        models: { options: optionsModel(), sort: sortModel(), reasons: reasonsModel() },
        coverage: pool.length ? Math.round((sortedCount / pool.length) * 1000) / 10 : 0,
        ...(debugPool ? { debug: { discarded } } : {}),
      },
    });
  } finally {
    clearInterval(ticker);
    abort.abort();
  }
}

/** Raw, kept and opinion counts per X lane kind, so lane mixes can be compared run to run. */
function xPoolStats(info: Awaited<ReturnType<typeof collectX>> | null, shown: Map<string, Post>) {
  if (!info) return null;
  const lanes = Object.fromEntries(Object.entries(info.lanes).map(([k, v]) => [k, { ...v, opinions: 0 }])) as Record<string, { raw: number; kept: number; opinions: number }>;
  for (const p of shown.values()) {
    const k = p.source === "x" && p.option ? info.laneOf.get(p.id) : undefined;
    if (k) lanes[k]!.opinions++;
  }
  // Eval only: per-query yield, so lane templates can be ranked by opinions per tweet.
  let perLane: unknown;
  if (process.env.DEBUG_POOL === "1") {
    const stats = info.laneStats.map((s) => ({ ...s, opinions: 0 }));
    for (const p of shown.values()) {
      const i = p.source === "x" && p.option ? info.laneIdx.get(p.id) : undefined;
      if (i != null) stats[i]!.opinions++;
    }
    perLane = stats;
  }
  return { raw: info.raw, kept: info.kept, capped: info.capped, lanes, ...(perLane ? { per_lane: perLane } : {}) };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Eval only: writes the frozen pool and the live plan inputs so options/sort/themes can be replayed without X/Reddit. */
async function dumpPool(dir: string, d: { req: SearchRequest; pool: RawPost[]; arrivedAt: Map<string, number>; sampleIds: string[]; liveBase: { title: string; description: string }[]; purchasable: boolean; labels: Map<string, unknown>; threads: number; dropped: unknown; timing: unknown; x_raw: number | null }) {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const slug = (d.req.query + (d.req.since ? `-since-${d.req.since}` : "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
    const { signal: _s, ...req } = d.req;
    await writeFile(
      `${dir}/${slug}.pool.json`,
      JSON.stringify({ req, pool: d.pool.map((p) => ({ ...p, arrived_ms: d.arrivedAt.get(p.id) ?? null })), options_sample_ids: d.sampleIds, live_options: d.liveBase, purchasable: d.purchasable, live_labels: Object.fromEntries(d.labels), threads: d.threads, dropped: d.dropped, timing: d.timing, x_raw: d.x_raw }),
    );
  } catch (e) {
    log.warn("pool dump failed", { error: String(e).slice(0, 200) });
  }
}

/** Last resort when every options call failed: generic sides that still let the sorter place posts. */
function genericOptions(query: string): Option[] {
  const vs = query.match(/^(.+?)\s+(?:vs\.?|versus|or)\s+(.+?)\??$/i);
  if (vs) {
    const a = vs[1]!.replace(/^(is|which is better|should i (get|pick|use|choose))\s+/i, "").trim();
    const b = vs[2]!.trim();
    return [
      { title: `${a} is better`, description: `People who prefer ${a}.` },
      { title: `${b} is better`, description: `People who prefer ${b}.` },
    ];
  }
  return [
    { title: "Yes", description: `People who answer yes to: ${query}` },
    { title: "No", description: `People who answer no to: ${query}` },
  ];
}
export type { Author };
