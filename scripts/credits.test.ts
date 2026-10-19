import assert from "node:assert/strict";
import { test } from "node:test";
import { grantFor, takeCredit } from "../src/v3/credits.ts";

test("only the allowlisted verified account gets credits", () => {
  assert.equal(grantFor({ email: "syedhashim2015@gmail.com", email_verified: true }), 100);
  assert.equal(grantFor({ email: "SyedHashim2015@Gmail.com ", email_verified: true }), 100);
  assert.equal(grantFor({ email: "syedhashim2015@gmail.com", email_verified: false }), 0);
  assert.equal(grantFor({ email: "someone@gmail.com", email_verified: true }), 0);
  assert.equal(grantFor({ email: null, email_verified: true }), 0);
  assert.equal(grantFor(null), 0);
});

test("credits run out after the grant", async () => {
  const u = { uid: "t1", email: "syedhashim2015@gmail.com", email_verified: true };
  for (let i = 99; i >= 0; i--) assert.equal(await takeCredit(u), i);
  assert.equal(await takeCredit(u), null);
  assert.equal(await takeCredit({ uid: "t2", email: "other@gmail.com", email_verified: true }), null);
});
