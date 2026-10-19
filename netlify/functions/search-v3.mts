import type { Config, Context } from "@netlify/functions";
import { env } from "../../src/lib/env.ts";
import { runV3, searchId } from "../../src/v3/run.ts";
import { anonId, clientIp, sessionUser } from "../../src/v3/auth.ts";
import { acquireInflight, addHistory, addSpend, allowRequest, countUserSearch, readCache, readSaved, releaseInflight, spentToday, writeCache } from "../../src/v3/store.ts";
import { grantFor, takeCredit } from "../../src/v3/credits.ts";
import type { V3Event, V3Source } from "../../src/v3/types.ts";
import { isDevRuntime } from "../../src/lib/runtime.ts";

const encoder = new TextEncoder();
const sse = (e: V3Event) => encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
const HEARTBEAT_MS = 3_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Real calendar date (rejects 2026-13-45, 2026-02-30). */
const isDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return DATE.test(s) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
/** Same-origin app; no cross-origin access (cookies carry the session). */
const CORS: Record<string, string> = {};
const NO_CREDITS = "New searches are paused right now. Saved and shared polls still open.";
function streamOf(run: (send: (e: V3Event) => void) => Promise<void>, setCookie: string | null = null, showDetail = false): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: V3Event) => {
        if (!open) return;
        // Internal error detail is for local debugging only.
        if (e.event === "error" && !showDetail) e = { event: "error", data: { message: (e.data as { message?: string })?.message ?? "Something went wrong." } };
        controller.enqueue(sse(e));
      };
      const heartbeat = setInterval(() => open && controller.enqueue(encoder.encode(": ping\n\n")), HEARTBEAT_MS);
      try {
        await run(send);
      } catch (e) {
        console.error("v3 search failed", e);
        send({ event: "error", data: { message: "Something went wrong while building this poll. Please try again." } });
      } finally {
        clearInterval(heartbeat);
        open = false;
        controller.close();
      }
    },
  });
  const headers = new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", ...CORS });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(stream, { headers });
}

const replay = (events: V3Event[], cachedAt: number, setCookie: string | null = null) =>
  streamOf(async (send) => {
    for (const e of events) send(e.event === "meta" ? { event: "meta", data: { ...(e.data as object), cached: true, cached_at: new Date(cachedAt).toISOString() } } : e);
  }, setCookie);

const deny = (status: number, error: string, message: string, setCookie: string | null = null) => {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS });
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(JSON.stringify({ error, message }), { status, headers });
};

/**
 * GET /api/v3/search?query=...&since=YYYY-MM-DD&until=YYYY-MM-DD&sources=reddit,x[&fresh=1]  -> SSE stream
 * GET /api/v3/search?id=<id>                                                                 -> replay a saved search
 */
export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return deny(405, "method_not_allowed", "Use GET.");
  const url = new URL(req.url);
  const p = url.searchParams;

  const savedId = p.get("id");
  if (savedId && !p.get("query")) {
    if (!/^[A-Za-z0-9_-]{8,32}$/.test(savedId)) return deny(404, "not_found", "This search has expired.");
    const saved = await readSaved(savedId);
    return saved ? replay(saved.events, saved.saved_at) : deny(404, "not_found", "This search has expired.");
  }

  const query = p.get("query")?.trim().slice(0, 300);
  if (!query) return deny(400, "bad_request", "query is required");
  const since = p.get("since") || undefined;
  const until = p.get("until") || undefined;
  if ((since && !isDate(since)) || (until && !isDate(until)) || (since && until && since > until))
    return deny(400, "bad_request", "since/until must be YYYY-MM-DD and since <= until");
  const today = new Date().toISOString().slice(0, 10);
  if (since && since > today) return deny(400, "bad_request", "since can't be in the future");
  const sources = (p.get("sources") ?? "reddit,x")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s === "twitter" ? "x" : s))
    .filter((s): s is V3Source => s === "reddit" || s === "x");
  if (!sources.length) return deny(400, "bad_request", "sources must include reddit and/or x");

  // Paid runs only start from our own pages (blocks cross-site links/iframes spending a visitor's quota).
  if (req.headers.get("sec-fetch-site") === "cross-site") return deny(403, "forbidden", "Open Consensus to search.");

  const request = { query, since, until, sources: [...new Set(sources)] };
  const id = searchId(request);

  // Access: cached replays are free for everyone; a new (paid) run needs a credit, and only allowlisted accounts have any.
  const [user, anon] = [await sessionUser(req), anonId(req)];
  const ip = clientIp(req, context.ip);

  if (user) void addHistory(user.uid, { id, query, since: since ?? null, until: until ?? null, sources: request.sources }).catch(() => {});

  // Only accounts with credits may force a fresh (paid) run.
  if (!(user && grantFor(user) > 0 && p.get("fresh") === "1")) {
    const cached = await readCache(id, env.cacheTtlHours);
    if (cached) return replay(cached.events, cached.saved_at, anon.setCookie);
  }
  if (!user || grantFor(user) <= 0) return deny(402, "no_credits", NO_CREDITS, anon.setCookie);

  // Unverified email/password accounts are cheap to mint, so they get a tighter hourly limit.
  const perHour = user && !user.email_verified ? Math.min(10, env.rateLimitPerHour) : env.rateLimitPerHour;
  // One live (paid) search per person at a time; cache replays above stay unlimited.
  const who = user ? `u:${user.uid}` : `a:${anon.id}`;
  const token = crypto.randomUUID();
  const running = await acquireInflight(who, token, query);
  if (running !== null) return deny(409, "search_in_progress", "Your other search is still running. It'll finish in a few seconds.", anon.setCookie);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void releaseInflight(who, token);
  };

  const [rate, spent] = await Promise.all([allowRequest(user ? `u:${user.uid}` : ip, perHour), spentToday()]);
  if (!rate.ok) return release(), deny(429, "rate_limited", "Too many searches. Try again in an hour.", anon.setCookie);
  if (spent >= env.dailySpendCapUsd) return release(), deny(503, "over_capacity", "We've hit today's search capacity. Please try again tomorrow.", anon.setCookie);
  if ((await takeCredit(user)) === null) return release(), deny(402, "no_credits", NO_CREDITS, anon.setCookie);
  void countUserSearch(user.uid).catch(() => {});
  req.signal?.addEventListener?.("abort", release, { once: true });

  return streamOf(async (send) => {
    try {
      const events: V3Event[] = [];
      let cost = 0;
      let ok = false;
      for await (const e of runV3({ ...request, signal: req.signal })) {
        send(e);
        events.push(e);
        if (e.event === "done") {
          const d = e.data as { cost: { total_usd: number }; status: string };
          cost = d.cost.total_usd;
          ok = d.status !== "empty";
        }
      }
      // Live progress ticks are not worth replaying; everything else is.
      const kept = events.filter((e) => e.event !== "progress");
      await Promise.all([addSpend(cost), ok ? writeCache(id, kept) : Promise.resolve()]);
    } finally {
      release();
    }
  }, anon.setCookie, isDevRuntime(context));
};

export const config: Config = {
  path: ["/api/v3/search"],
};
