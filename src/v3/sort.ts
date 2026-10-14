import { env } from "../lib/env.ts";
import { logger } from "../lib/log.ts";
import { completeJson, completeText } from "../llm.ts";
import { flat, within } from "./limit.ts";
import type { Intent, RawPost, Reason } from "./types.ts";

const log = logger("v3-sort");

/** Buckets and "why" text are one call each per search, so they use a stronger model than the bulk sorter. */
export const optionsModel = () => process.env.OPTIONS_MODEL ?? env.llmModel;
export const reasonsModel = () => process.env.REASONS_MODEL ?? optionsModel();
export const sortModel = () => env.classifierModel;

export interface Option {
  title: string;
  description: string;
}

// ---------------------------------------------------------------- buckets

const OPTIONS_SCHEMA = {
  type: "object",
  properties: {
    options: { type: "array", items: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"] } },
    off_topic: { type: "boolean" },
    type: { type: "string", enum: ["yes_no", "a_vs_b", "best_x"] },
    purchasable: { type: "boolean" },
  },
  required: ["type", "options"],
};

/** Thrown when the collected posts are not about the question (gibberish or no real discussion). */
export class OffTopicError extends Error {
  constructor() {
    super("posts are not about the question");
  }
}

/** A spread of the pool for writing buckets: top comments round-robin across threads, plus the most-liked X posts. */
export function sampleForOptions(pool: RawPost[], n = 240): RawPost[] {
  const byThread = new Map<string, RawPost[]>();
  for (const p of pool) {
    if (p.source !== "reddit" || p.kind === "opener" || p.depth > 1) continue;
    const k = p.thread_url ?? "";
    byThread.set(k, [...(byThread.get(k) ?? []), p]);
  }
  const lists = [...byThread.values()].map((l) => l.sort((a, b) => b.score - a.score));
  const reddit: RawPost[] = [];
  for (let i = 0; reddit.length < n && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && reddit.length < n) reddit.push(l[i]!);
  const x = pool.filter((p) => p.source === "x").sort((a, b) => b.score - a.score);
  const xShare = Math.min(x.length, Math.max(Math.round(n * 0.3), n - reddit.length));
  return [...reddit.slice(0, n - xShare), ...x.slice(0, xShare)];
}

/** Set by writeOptions: whether the question is about something people buy (sales leads only make sense then). */
export interface OptionsResult extends Array<Option> {
  purchasable?: boolean;
  qtype?: string;
}

export async function writeOptions(query: string, sample: RawPost[], signal?: AbortSignal): Promise<OptionsResult> {
  const lines = sample
    .map((p, i) => `[${i}] ${p.source === "x" ? "(X post)" : `(Reddit, thread: ${flat(p.thread_title, 90)})`} ${flat(p.text, 240)}`)
    .join("\n");
  const prompt = `You run a public opinion poll built from real Reddit and X posts. Read the posts about "${query}" and write the poll options: the distinct answers people actually give.

First decide the question type ("type": yes_no, a_vs_b or best_x), then follow its rule:
- YES/NO ("is X worth it", "is X overrated", "will X happen", "should I"): exactly the two plain sides ("Worth it" / "Not worth it", "Yes, it will pop" / "No, it won't"), plus at most ONE middle option, only if many posts take it, naming its concrete condition ("Only if your employer pays"). Never a reason, timing or flavour of a side as its own option ("Too expensive", "Yes but not soon", "Only for prototypes", "Steal it" are reasons or sub-cases, not options).
- A VS B ("A vs B", "A or B"): "A is better", "B is better", plus at most one middle option ("Use both", "Depends on team size") only if many posts take it. A third product appears only if MANY posts say "neither, use C".
- BEST X / WHICH / WHO / WHERE ("best X", "who will win", "best food in sf"): 4 to 7 options, one per specific named pick (exact name), the MOST RECOMMENDED picks across ALL posts first (count posts that recommend or praise it as the answer, not posts that merely mention it). Never pick something only one or two posts name over something many posts recommend. All options at the same level (all shoe models, or all teams, or all dishes) and each is truly a kind of X: under "best venture capital" every option is a VC firm (Sequoia, Benchmark), not an accelerator like YC or Techstars; under "best seed fund" every option is a fund. No "depends", no "anyone but", no category debate.
- Ambiguous subjects ("amazon vs meta", "is sf back"): use the sense most of the posts discuss, and name it in the titles ("Amazon stock is better" or "Amazon is the better employer").

Rules for every option:
- It directly answers "${query}" exactly as asked, taking its premise as given. Ignore posts about something else even if they are many.
- If the question names a place, every pick must be IN that place. Picks from other cities or regions (even if many posts name them) are never options.
- Mutually exclusive: a person holding one cannot also hold another. If two options could both be true for the same poster, merge them.
- Every option has real support in the posts. Ordered most to least common.
- No "other", "none", "mixed" or catch-all option (Other is added automatically). Never "Depends on personal preference" or "It depends".
- Titles: 1 to 6 words, plain, neutral, specific. Like "Worth it", "Not worth it", "Cursor is better", "Pipedrive", "Dodgers".
- Descriptions: ONE short neutral sentence (max 15 words) saying what the option means, e.g. "Says the subscription pays for itself." Not a list of reasons, no praise, no numbers or claims about popularity.
- Names may be written many ways (PearX = Pear X = Pear VC, YC = Y Combinator, SF = San Francisco): treat them as the same subject.
- Plain text only, no quotation marks. Ignore spam, ads and news headlines.
- "purchasable": true only if the question is about choosing a product, tool, service or subscription that people buy or sign up for (CRMs, shoes, software, gyms, phone plans). False for opinions, predictions, places to eat or live, people, investors, accelerators, toppings, politics.
- Always return options. If few posts are about "${query}", still write the answers people most commonly give to it, from what you know, and set "off_topic": true.

Posts:
${lines}`;
  const r = await completeJson<{ options?: { title?: string; description?: string }[]; off_topic?: boolean; type?: string; purchasable?: boolean }>(
    prompt,
    OPTIONS_SCHEMA,
    { model: optionsModel(), maxTokens: 900, timeoutMs: 20_000, signal },
    1,
  );
  if (!(r.options ?? []).length) throw new OffTopicError();
  // Two sides plus one middle at most: extra yes/no or A-vs-B options are almost always reasons or sub-cases of a side.
  const cap = r.type === "best_x" ? 7 : 3;
  const seen = new Set<string>();
  const out: OptionsResult = (r.options ?? [])
    .filter((o) => o.title?.trim() && !/^(other|others|none|mixed)\b/i.test(o.title.trim()))
    .map((o) => ({ title: o.title!.trim().replace(/^["']|["']$/g, ""), description: o.description?.trim() ?? "" }))
    .filter((o) => !seen.has(o.title.toLowerCase()) && !!seen.add(o.title.toLowerCase()))
    .filter((o) => !VAGUE.test(o.title))
    .slice(0, cap);
  out.purchasable = r.purchasable;
  out.qtype = r.type;
  return out;
}

/** Catch-all titles that are not a real answer. */
const VAGUE = /^(other|others|none|mixed|various|specific|any|misc|it depends)\b|\b(recommendation|recommendations|options|alternatives in general|brands)$|^depends on (personal |your )?(preference|taste|needs)s?$|^personal (preference|taste)$/i;

/** Used only when nothing was collected in time to read: buckets from the question alone. */
export async function writeOptionsFromQuestion(query: string, signal?: AbortSignal): Promise<Option[]> {
  const prompt = `Write the 2 to 4 poll options for the public-opinion question "${query}": the distinct, mutually exclusive answers people commonly give. Titles 2 to 7 words (e.g. "Worth it", "Not worth it", "Depends on budget"); for "best X" questions, the most commonly recommended specific picks by name. One-sentence description each. No "other" option.`;
  const r = await completeJson<{ options?: { title?: string; description?: string }[] }>(prompt, OPTIONS_SCHEMA, { model: optionsModel(), maxTokens: 600, timeoutMs: 15_000, signal }, 1);
  return (r.options ?? []).filter((o) => o.title?.trim()).slice(0, 4).map((o) => ({ title: o.title!.trim(), description: o.description?.trim() ?? "" }));
}

// ---------------------------------------------------------------- one sorting pass per post

export interface Label {
  /** Option index, "other" (an opinion on the question that fits no option), "none" (on-topic, no stance) or "drop". */
  bucket: number | "other" | "none" | "drop";
  strength: number;
  intent: Intent | null;
  /** How many of the three sort models gave this bucket, as a share (1 = all three, 0.67 = two, 0.5 = primary alone). */
  agree?: number;
}

const INTENT_CODE: Record<string, Intent> = { L: "looking", W: "switching", F: "frustrated", B: "just_bought" };
export const SORT_BATCH = Number(process.env.SORT_BATCH ?? 25);

export function sortPrompt(query: string, options: Option[], posts: RawPost[]): string {
  const opts = options.map((o, i) => `${i} = ${o.title}: ${o.description}`).join("\n");
  const body = posts
    .map((p, i) => {
      const where =
        p.source === "x"
          ? `(X ${p.kind === "reply" ? "reply" : "post"} @${p.author.handle}${p.parent_text ? `, replying to: "${flat(p.parent_text, 160)}"` : ""})`
          : p.kind === "opener"
            ? `(Reddit thread opener in ${p.community ?? "reddit"})`
            : `(Reddit reply in thread "${flat(p.thread_title, 100)}"${p.parent_text ? `, answering: "${flat(p.parent_text, 140)}"` : ""})`;
      return `[${i}] ${where} ${flat(p.text, 600)}`;
    })
    .join("\n");
  return `You are sorting posts for a public-opinion poll on: "${query}"

POLL OPTIONS:
${opts}

THE TEST for every post: if you asked this poster "${query}", what would they answer, judging ONLY from what they wrote here (and the thread or comment it replies to)? If you can tell, that is a vote. If you cannot tell, it is N. Being about the same topic is NOT a vote.

BUCKET:
- an option number: the post answers the question that way, in words or by clear implication. Examples of clear implication: under "is X worth it", "cancelled it, total waste of money" = not worth it, "best purchase I made this year" = worth it; under "best X", recommending or saying they love a specific X = a vote for that pick; under "A vs B", "switched from A to B and never looked back" = B. Short replies count when the comment they answer makes the lean clear ("No, never again" under "Is X worth it?").
- O = the poster clearly answers the question with something none of the options captures (a different pick or a different position).
- N = NOT a vote. This includes: posts on the topic that do not answer THIS question; general praise or criticism of a person or company that does not answer what was asked (under "will Trump win another election", "he's the worst president ever" is N, it is not a prediction); news, scores, stats and facts; tips and how-tos; questions; jokes or reactions with no answer; replies like "agreed", "this", "lol" whose own words do not show the answer; mixed views with no lean.
- S = remove: spam, ads, giveaways, bots, news-headline accounts, link drops, self-promotion (pitching one's own product, service, agency, course, newsletter, "DM me", "we built", "check out my"), brand/official accounts promoting their own product (@AnthropicAI posting about Claude is not a vote for Claude), affiliate listicles, posts about a different thing that only shares a word, and posts that only use a name as a metaphor ("the Michael Jordan of presidents" is not a vote in a Jordan vs LeBron poll).
- S also = WRONG PLACE or WRONG SUBJECT: if the question names a place (a city, neighborhood, region), a pick located somewhere else is S, not O ("Thai Taste in San Ramon" or "Asha Tea House in Berkeley" under a San Francisco question, "Kumako in San Jose Japantown" under best ramen in SF). Same for a different subject than asked (another accelerator's program details under "is a16z speedrun worth it" are N unless they compare it).
A thread opener that only asks the question is N.
A VS B and YES/NO: criticizing or praising one side alone is a vote ONLY if it answers the question. Under "A vs B", "A is overrated" or "A is a bad deal" is NOT a vote for B unless they say B (or the alternative) is better or they chose B; it is N. Under "is X worth it", praise or criticism of a different program is N.
Ranked lists and "my picks" posts that name the poster's own top choice are a vote for their #1 (strength 2). Lists copied from elsewhere, "top 10" marketing threads and directories are S.
MENTION IS NOT A VOTE: under "best X", naming a pick as a resource, event, example, place to apply, or one of several options to "check out" is N. It is a vote only if the poster says it is the best, their favorite, what they chose and liked, or what they recommend over others. Advice ("talk to angels", "get traction first") that names something in passing is N.
ANNOUNCEMENTS ARE NOT VOTES: program or funding announcements, "applications open", demo day promos, accepted/rejected/joined news ("got into YC", "rejected from Speedrun") with no judgment of whether it was worth it, and posts by the subject's own account or its staff hyping it are S (if promotional) or N.
O (Other) is only for a clear DIFFERENT answer of the same kind as asked (another named VC firm under "best VC", another named restaurant in the same city). Vague complaints, "none", or general takes on the whole category are N.
If a post picks several options (e.g. "pepperoni and mushroom" under best topping), give the one it mentions first.
Be strict: when in doubt between an option and N, choose N. A wrong vote is much worse than a missed one.

STRENGTH (for option or O): 3 = clear answer with a reason or first-hand experience, 2 = clear answer, 1 = answer implied but unmistakable. Use 0 for N and S.

LEAD = a sales lead: the POSTER'S OWN, first-person buying situation in this space. Most posts are "-".
L = the poster says they are personally shopping: "I'm looking for", "what should I use for my team", "need a CRM for my shop"
W = the poster says they personally are switching, cancelling or just moved ("we're moving to X", "cancelled last month")
F = the poster is personally fed up with a product they use now (price, bugs, support), in their own words
B = the poster says they just bought or just started using a product
- = everything else, including: people recommending or advising others, general opinions, vendors/consultants/agencies, hypotheticals, quoting others, and anything marked S.
Questions in a reply that answer someone else are "-" (they are advising, not buying).

POSTS:
${body}

Output exactly one line per post, in order, as "<index> <bucket> <strength> <lead>", e.g.
0 1 3 -
1 S 0 -
2 N 0 L
3 O 2 F
Nothing else.`;
}

/** The prompt's final instructions, swapped for the "say their answer first" format. */
const TAIL_RE = /Output exactly one line per post[\s\S]*$/;
export function sortPromptCot(query: string, options: Option[], posts: RawPost[]): string {
  return sortPrompt(query, options, posts).replace(
    TAIL_RE,
    `For each post, first write in 2 to 8 words what this poster would answer to "${query.replace(/\$/g, "")}" (or "no answer"), then the label.
Output exactly one line per post, in order, as "<index> | <their answer> | <bucket> <strength> <lead>". The bucket is the NUMBER of the poll option above whose title matches their answer (check the list each time). Format example (the option numbers here are placeholders, not this poll's):
0 | <answer matching option 1> | 1 3 -
1 | no answer, an ad | S 0 -
2 | no answer, asking for help | N 0 L
3 | prefers a third option | O 2 F
Nothing else.`,
  );
}

/** Option whose title the written answer starts with ("worth it, ..." -> "Worth it"), longest title first; -1 if none. */
function titleMatch(answer: string, titles: string[]): number {
  const a = answer.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  let best = -1;
  titles.forEach((t, i) => {
    const tt = t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (tt && (a === tt || a.startsWith(`${tt} `)) && (best < 0 || tt.length > titles[best]!.length)) best = i;
  });
  return best;
}

function parseLabels(text: string, n: number, k: number, titles?: string[]): (Label | undefined)[] {
  const out: (Label | undefined)[] = new Array(n);
  // Accepts both "<i> <bucket> <strength> <lead>" and "<i> | answer | <bucket> <strength> <lead>".
  for (const m of text.matchAll(/^\s*\[?(\d+)\]?\s*[:.\-]?\s*(?:\|([^|\n]*)\|)?\s*([0-9]+|[ONSons])\s+([0-3])\s+([LWFBlwfb-])\s*$/gm)) {
    const i = Number(m[1]);
    if (i >= n || out[i]) continue;
    const b = m[3]!.toUpperCase();
    let bucket: Label["bucket"];
    if (b === "O") bucket = "other";
    else if (b === "N") bucket = "none";
    else if (b === "S") bucket = "drop";
    else if (Number(b) < k) bucket = Number(b);
    else continue;
    // The written answer names one option but the number points at another (an off-by-one the model makes on
    // two-option polls): the words win.
    if (typeof bucket === "number" && titles && m[2]) {
      const t = titleMatch(m[2], titles);
      if (t >= 0 && t !== bucket) bucket = t;
    }
    let strength = typeof bucket === "number" || bucket === "other" ? Math.max(1, Number(m[4])) : 0;
    // Strength-1 votes were judged right only 27% of the time; they rank last, and SORT_DROP_S1=1 drops them (cost ~25% of opinions in r2).
    if (strength === 1 && process.env.SORT_DROP_S1 === "1") {
      bucket = "none";
      strength = 0;
    }
    out[i] = { bucket, strength, intent: bucket === "drop" ? null : (INTENT_CODE[m[5]!.toUpperCase()] ?? null) };
  }
  return out;
}

/*
 * Sorting = majority vote of three models on every batch (round 4 eval on 2,828 Sonnet-judged posts):
 * DeepSeek Flash with "say their answer first" 82.8% correct, MiMo 82.6%, Luna Pro 80.9%; the 2-of-3 vote 85.4%,
 * with 88.7% of counted votes real (DeepSeek alone 84.2%). DeepSeek is primary; the voters only get a short grace
 * period after it finishes, and a missing voter just means DeepSeek's label stands.
 */
const VOTERS = env.llmVoters;
const VOTER_GRACE_MS = Number(process.env.SORT_VOTER_GRACE_MS ?? 6_000);

async function labelOnce(prompt: string, model: string, n: number, k: number, signal?: AbortSignal, noReasoning?: boolean, titles?: string[]): Promise<(Label | undefined)[]> {
  const text = await completeText(prompt, { model, maxTokens: 60 * n + 300, timeoutMs: 25_000, signal, temperature: 0, ...(noReasoning ? { noReasoning } : {}) }, 0);
  return parseLabels(text, n, k, titles);
}

const key = (l?: Label) => (l ? String(l.bucket) : "");

/** Labels one batch; a primary batch that comes back mostly unparsed is asked once more. Missing labels stay undefined. */
export async function sortBatch(query: string, options: Option[], posts: RawPost[], signal?: AbortSignal): Promise<(Label | undefined)[]> {
  const n = posts.length;
  const k = options.length;
  const voterAbort = new AbortController();
  const voterSignal = signal ? AbortSignal.any([signal, voterAbort.signal]) : voterAbort.signal;
  const plain = sortPrompt(query, options, posts);
  const voters = VOTERS.map((model) =>
    labelOnce(plain, model, n, k, voterSignal, true).catch((e) => {
      if (!voterSignal.aborted) log.warn("sort voter failed", { model, error: String(e).slice(0, 160) });
      return null;
    }),
  );
  let best: (Label | undefined)[] = new Array(n);
  const cot = sortPromptCot(query, options, posts);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const got = await labelOnce(cot, sortModel(), n, k, signal, false, options.map((o) => o.title));
      if (got.filter(Boolean).length > best.filter(Boolean).length) best = got;
      if (best.filter(Boolean).length >= n * 0.8) break;
    } catch (e) {
      if (signal?.aborted) break;
      log.warn("sort batch failed", { error: String(e).slice(0, 200) });
    }
  }
  const votes = await within(Promise.all(voters), VOTER_GRACE_MS, voters.map(() => null));
  voterAbort.abort();
  const [b, c] = [votes[0] ?? null, votes[1] ?? null];
  return best.map((a, i) => {
    const vb = b?.[i];
    const vc = c?.[i];
    // No primary label: two voters that agree still give one.
    if (!a) return vb && key(vb) === key(vc) ? { ...vb, agree: 0.67 } : undefined;
    if (!vb || !vc) return { ...a, agree: vb && key(vb) === key(a) ? 0.67 : vc && key(vc) === key(a) ? 0.67 : 0.5 };
    if (key(a) === key(vb) || key(a) === key(vc)) return { ...a, agree: key(a) === key(vb) && key(a) === key(vc) ? 1 : 0.67 };
    // Both voters agree against the primary (r3: primary flipped every HF0 "worth it" to option 1): voters win.
    if (key(vb) === key(vc)) return { ...vb, intent: a.intent ?? vb.intent, agree: 0.67 };
    // Three different answers: not a clear vote.
    return { bucket: "none", strength: 0, intent: a.intent, agree: 0 };
  });
}

// ---------------------------------------------------------------- splitting a large Other bucket

/**
 * When many opinions land in Other, either the sorter was too cautious (the post really leans to an existing option)
 * or the buckets missed a real position (typical for "best X" questions). One call reads the Other posts, moves the
 * ones with a clear lean back into existing options, proposes up to 2 genuinely new options and assigns the rest.
 * `assign` values: existing option index, or `k + j` for new option j (k = options.length).
 */
export async function splitOther(query: string, options: Option[], posts: RawPost[], signal?: AbortSignal): Promise<{ added: Option[]; assign: Map<number, number> }> {
  const SAMPLE = 160;
  const sample = posts.slice(0, SAMPLE);
  const k = options.length;
  const prompt = `Public-opinion poll on "${query}". Existing options:
${options.map((o, i) => `${i} = ${o.title}: ${o.description}`).join("\n")}

These posts were put in "Other":
${sample.map((p, i) => `[${i}] ${flat(p.text, 260)}`).join("\n")}

Step 1. Some of these actually answer the question with an existing option (under "is X worth it", "cancelled it, waste of money" is "not worth it"; under "best X", naming a pick that is an option). Assign only those to that option's number. A post that does not answer "${query}" itself (news, facts, tips, general praise or criticism of something else, jokes) stays in Other: do not list it.
Step 2. If at least 4 of the remaining posts share the same answer that is a genuinely DIFFERENT position (a person holding it could not also pick any existing option), add it as a new option. At most 4 new options, most supported first. Each new option must directly answer "${query}" as asked and names ONE specific answer (for "best X" questions: one named product/place/brand that is a kind of X, never a debate about the category), located in the place the question names (if any), never a vague group like "Other shops" or "Specific brands", and never "Depends on personal preference". Never add a reason, sub-case or flavour of an existing option (e.g. "Too expensive" when "Not worth it" exists, or "Use a cheaper alternative" when "Not worth it" exists). Title 2 to 7 words, specific; one-sentence description.
Assign posts to a new option with to = ${k} + its position in "added" (so ${k}, ${k + 1}, ...). Use -1 to leave a post in Other.
Return {"added":[{"title":"...","description":"..."}],"assign":[{"i":0,"to":1}, ...]}. List only posts that move.`;
  try {
    const r = await completeJson<{ added?: { title?: string; description?: string }[]; assign?: { i?: number; to?: number }[] }>(
      prompt,
      undefined,
      { model: optionsModel(), maxTokens: 3500, timeoutMs: 15_000, signal },
      0,
    );
    const added = (r.added ?? []).filter((o) => o.title?.trim() && !VAGUE.test(o.title.trim())).slice(0, Math.max(0, Math.min(4, 8 - k))).map((o) => ({ title: o.title!.trim(), description: o.description?.trim() ?? "" }));
    const assign = new Map<number, number>();
    const valid = (i: unknown, to: unknown, n: number) => Number.isInteger(i) && Number.isInteger(to) && (to as number) >= 0 && (to as number) < k + added.length && (i as number) >= 0 && (i as number) < n;
    for (const a of r.assign ?? []) if (valid(a.i, a.to, sample.length)) assign.set(a.i!, a.to!);

    // The rest of Other (long tails on "best X" questions) is assigned against the final option list in parallel.
    const rest = posts.slice(SAMPLE, SAMPLE + 600);
    if (rest.length) {
      const all = [...options, ...added];
      const CHUNK = 100;
      const chunks = Array.from({ length: Math.ceil(rest.length / CHUNK) }, (_, c) => rest.slice(c * CHUNK, (c + 1) * CHUNK));
      await Promise.all(
        chunks.map(async (chunk, c) => {
          const q = `Public-opinion poll on "${query}". Options:
${all.map((o, i) => `${i} = ${o.title}: ${o.description}`).join("\n")}

Posts:
${chunk.map((p, i) => `[${i}] ${flat(p.text, 240)}`).join("\n")}

For each post that itself answers "${query}" with one of these options (it picks, recommends or clearly argues for it), give its number. Leave out posts that fit none or do not answer the question. When unsure, leave it out.
Return {"assign":[{"i":0,"to":1}, ...]}.`;
          try {
            const rr = await completeJson<{ assign?: { i?: number; to?: number }[] }>(q, undefined, { model: optionsModel(), maxTokens: 1500, timeoutMs: 9_000, signal }, 0);
            for (const a of rr.assign ?? []) if (valid(a.i, a.to, chunk.length)) assign.set(SAMPLE + c * CHUNK + a.i!, a.to!);
          } catch (e) {
            log.warn("other assign chunk failed", { error: String(e).slice(0, 200) });
          }
        }),
      );
    }

    // A new option fewer than 3 posts were assigned to is dropped (and later indices shift).
    const used = added.map((_, j) => [...assign.values()].filter((t) => t === k + j).length >= 3);
    const keep = added.filter((_, j) => used[j]);
    const remap = new Map<number, number>();
    added.forEach((_, j) => used[j] && remap.set(k + j, k + keep.indexOf(added[j]!)));
    for (const [i, t] of [...assign]) {
      if (t < k) continue;
      if (remap.has(t)) assign.set(i, remap.get(t)!);
      else assign.delete(i);
    }
    return { added: keep, assign };
  } catch (e) {
    log.warn("other split failed", { error: String(e).slice(0, 200) });
    return { added: [], assign: new Map() };
  }
}

// ---------------------------------------------------------------- long-tail Other, second pass

/**
 * Second pass for long-tail answers ("best X"): when Other is still large after the split, read up to 120 Other
 * posts, propose 2-4 more concrete picks, then sort every Other post against all options in parallel chunks.
 * `assign` values: existing option index, or `k + j` for new option j. New options need 3+ posts.
 */
export async function deepenOther(query: string, options: Option[], posts: RawPost[], signal?: AbortSignal): Promise<{ added: Option[]; assign: Map<number, number> }> {
  const k = options.length;
  const sample = posts.slice(0, 200);
  try {
    const r = await completeJson<{ added?: { title?: string; description?: string }[] }>(
      `Public-opinion poll on "${query}". Current options:
${options.map((o, i) => `${i} = ${o.title}`).join("\n")}

These answers fit none of them:
${sample.map((p, i) => `[${i}] ${flat(p.text, 200)}`).join("\n")}

Name the 3 to 6 specific answers that the most of these posts pick and that are NOT already an option. Each must be ONE concrete, named kind of the thing asked about, located in the place the question names (if any) (a specific product, model, brand, place, topping, tool...). Never a category, a debate about the category, a vague group ("Budget brands", "Other options", "Various"), a criterion ("Comfort", "Price"), or "Depends on preference". Most picked first. Title 1 to 5 words; one-sentence description.
Return {"added":[{"title":"...","description":"..."}]}.`,
      undefined,
      { model: optionsModel(), maxTokens: 600, timeoutMs: 4_000, signal },
      0,
    );
    const have = new Set(options.map((o) => o.title.toLowerCase()));
    const added = (r.added ?? [])
      .filter((o) => o.title?.trim() && !VAGUE.test(o.title.trim()) && !have.has(o.title.trim().toLowerCase()))
      .slice(0, 6)
      .map((o) => ({ title: o.title!.trim(), description: o.description?.trim() ?? "" }));
    if (!added.length) return { added: [], assign: new Map() };

    const all = [...options, ...added];
    const CHUNK = 60;
    const rest = posts.slice(0, 1500);
    const chunks = Array.from({ length: Math.ceil(rest.length / CHUNK) }, (_, c) => rest.slice(c * CHUNK, (c + 1) * CHUNK));
    const assign = new Map<number, number>();
    await Promise.all(
      chunks.map(async (chunk, c) => {
        try {
          const rr = await completeJson<{ assign?: { i?: number; to?: number }[] }>(
            `Public-opinion poll on "${query}". Options:
${all.map((o, i) => `${i} = ${o.title}: ${o.description}`).join("\n")}

Posts:
${chunk.map((p, i) => `[${i}] ${flat(p.text, 220)}`).join("\n")}

For each post that itself answers "${query}" with one of these options (it picks, recommends or clearly argues for it), give its number. Leave out posts that fit none or do not answer the question. When unsure, leave it out.
Return {"assign":[{"i":0,"to":1}, ...]}.`,
            undefined,
            { model: optionsModel(), maxTokens: 900, timeoutMs: 3_500, signal },
            0,
          );
          for (const a of rr.assign ?? []) {
            if (Number.isInteger(a.i) && Number.isInteger(a.to) && a.i! >= 0 && a.i! < chunk.length && a.to! >= 0 && a.to! < all.length) assign.set(c * CHUNK + a.i!, a.to!);
          }
        } catch (e) {
          log.warn("deepen chunk failed", { error: String(e).slice(0, 200) });
        }
      }),
    );
    const keep = added.filter((_, j) => [...assign.values()].filter((t) => t === k + j).length >= 3);
    for (const [i, t] of [...assign]) {
      if (t < k) continue;
      const at = keep.indexOf(added[t - k]!);
      if (at >= 0) assign.set(i, k + at);
      else assign.delete(i);
    }
    return { added: keep, assign };
  } catch (e) {
    log.warn("deepen other failed", { error: String(e).slice(0, 200) });
    return { added: [], assign: new Map() };
  }
}

// ---------------------------------------------------------------- why people say this

export async function writeReason(query: string, option: Option & { id: string }, posts: RawPost[], signal?: AbortSignal): Promise<Reason | null> {
  if (!posts.length) return null;
  const sample = posts.slice(0, 30);
  const prompt = `Public-opinion poll on "${query}". These posts all chose the answer "${option.title}".
${sample.map((p, i) => `[${i}] ${flat(p.text, 300)}`).join("\n")}

Write why people chose this answer, using only what the posts say:
- summary: one or two plain sentences (max 40 words) naming the concrete reasons that come up most, e.g. "Pricing jumps hard once you need Sales Hub Pro; most say the free CRM is great but paid tiers are overkill under 10 people." No hedging, no "users say".
- points: the 2 or 3 most common distinct reasons, each with a short label (max 8 words) and the index of the one post that shows it best plus an exact quote from that post (max 25 words, copied verbatim).
Return {"summary":"...","points":[{"text":"...","post":0,"quote":"..."}]}.`;
  try {
    const r = await completeJson<{ summary?: string; points?: { text?: string; post?: number; quote?: string }[] }>(
      prompt,
      undefined,
      { model: reasonsModel(), maxTokens: 450, timeoutMs: 7_000, signal },
      0,
    );
    const points = (r.points ?? [])
      .filter((p) => p.text && Number.isInteger(p.post) && sample[p.post!])
      .slice(0, 3)
      .map((p) => {
        const post = sample[p.post!]!;
        const quote = p.quote && post.text.replace(/\s+/g, " ").includes(p.quote.replace(/\s+/g, " ").trim()) ? p.quote.trim() : flat(post.text, 160);
        return { text: p.text!.trim(), quote, post_id: post.id, url: post.url };
      });
    return { option_id: option.id, summary: (r.summary ?? "").trim(), points };
  } catch (e) {
    log.warn(`reason for "${option.title}" failed`, { error: String(e).slice(0, 200) });
    return null;
  }
}
