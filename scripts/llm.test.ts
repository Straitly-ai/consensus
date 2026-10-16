import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { completeText } from "../src/llm.ts";
import { meterStore, newMeter } from "../src/lib/meter.ts";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

function configure() {
  process.env.LLM_GATEWAY = "straitly";
  process.env.STRAITLY_API_KEY = "test-only";
  process.env.LLM_MODEL = "xiaomi/mimo-v2.6-pro";
}

test("Straitly uses the no-reasoning request field and meters success", async () => {
  configure();
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.reasoning, undefined);
    assert.equal(body.provider, undefined);
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { cost: 0.01 } });
  }) as typeof fetch;
  const meter = newMeter();
  assert.equal(await meterStore.run(meter, () => completeText("test")), "ok");
  assert.equal(meter.llmCalls, 1);
  assert.equal(meter.llmUsd, 0.01);
});

test("invalid credentials fail once and mark the search fatal", async () => {
  configure();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: { message: "Invalid key" } }, { status: 401 });
  }) as typeof fetch;
  const meter = newMeter();
  await assert.rejects(meterStore.run(meter, () => completeText("test")), /401/);
  assert.equal(calls, 1);
  assert.equal(meter.llmFatal, true);
  assert.equal(meter.llmFailed, 1);
});

test("a deadline cancels rate-limit backoff without issuing another request", async () => {
  configure();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: "limited" }, { status: 429, headers: { "retry-after": "120" } });
  }) as typeof fetch;
  const started = Date.now();
  const meter = newMeter();
  await assert.rejects(meterStore.run(meter, () => completeText("test", { signal: AbortSignal.timeout(30) })));
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000);
  assert.equal(meter.llmFailed, 0);
});
