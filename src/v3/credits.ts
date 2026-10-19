import { getStore } from "@netlify/blobs";

/*
 * Paid-search credits. Live (paid) searches are closed to everyone except the accounts below; every other account,
 * anonymous visitors and new signups get zero. Saved links and cache replays cost nothing and stay open.
 * Counted per uid in Blobs; fails closed so a storage error never starts a paid run.
 */
export const CREDIT_GRANTS: Readonly<Record<string, number>> = { "syedhashim2015@gmail.com": 100 };

export function grantFor(user: { email: string | null; email_verified: boolean } | null): number {
  if (!user?.email || !user.email_verified) return 0;
  return CREDIT_GRANTS[user.email.trim().toLowerCase()] ?? 0;
}

const memory = new Map<string, number>();
const credits = () =>
  process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.NETLIFY_LOCAL ? getStore({ name: "consensus-v3-credits", consistency: "strong" }) : null;

/** Takes one credit; returns credits left after this search, or null when none are left (or storage failed). */
export async function takeCredit(user: { uid: string; email: string | null; email_verified: boolean }): Promise<number | null> {
  const grant = grantFor(user);
  if (grant <= 0) return null;
  const key = user.uid.replace(/[^\w-]/g, "_");
  try {
    const s = credits();
    if (!s) {
      const used = memory.get(key) ?? 0;
      if (used >= grant) return null;
      memory.set(key, used + 1);
      return grant - used - 1;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await s.getWithMetadata(key, { type: "json" });
      const used = Number((cur?.data as { used?: number } | null)?.used ?? 0);
      if (used >= grant) return null;
      const next = { used: used + 1, grant, updated_at: new Date().toISOString() };
      const res = cur ? await s.setJSON(key, next, { onlyIfMatch: cur.etag! }) : await s.setJSON(key, next, { onlyIfNew: true });
      if (res.modified) return grant - used - 1;
    }
    return null;
  } catch {
    return null;
  }
}
