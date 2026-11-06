import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { deployment } from "./deployment.ts";

export class RateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number) {
    super("Muitas solicitações. Aguarde um pouco e tente novamente.");
    this.retryAfter = retryAfter;
  }
}
export function clientAddress(request: Request): string {
  // Only Vercel's overwritten header is trusted. Never trust arbitrary XFF.
  if (process.env.VERCEL !== "1") return "unattributed";
  const ip = request.headers.get("x-vercel-forwarded-for")?.trim() || "";
  return isIP(ip) ? ip : "unattributed";
}
export function rateKey(value: string): string {
  const key =
    process.env.BANK_CONNECTIONS_KEY ||
    process.env.PARSER_TOKEN ||
    process.env.SETUP_TOKEN;
  if (deployment().remote && (!key || key.length < 32))
    throw new Error(
      "Configure um segredo do servidor antes de habilitar acesso remoto.",
    );
  return createHmac("sha256", key || "local-development-only-rate-limits")
    .update("entre-nos/rate-limit/v1\0" + value)
    .digest("hex");
}
export async function consumeLimit(
  db: Database,
  scope: string,
  key: string,
  limit: number,
  seconds: number,
): Promise<void> {
  if (
    !/^[a-z-]{1,40}$/.test(scope) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1
  )
    throw new Error("Política de limite inválida.");
  // The UPSERT locks one bucket atomically. Rejected requests never extend it.
  const r = await db.query<{ hits: number; retry: number }>(
    `INSERT INTO security_rate_buckets(scope,key_hash,hits,expires_at)
     VALUES($1,$2,1,clock_timestamp()+$4*interval '1 second')
     ON CONFLICT(scope,key_hash) DO UPDATE SET
       hits=CASE WHEN security_rate_buckets.expires_at<=clock_timestamp() THEN 1 ELSE least(security_rate_buckets.hits+1,$3+1) END,
       expires_at=CASE WHEN security_rate_buckets.expires_at<=clock_timestamp() THEN clock_timestamp()+$4*interval '1 second' ELSE security_rate_buckets.expires_at END
     RETURNING hits,greatest(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::integer AS retry`,
    [scope, rateKey(key), limit, seconds],
  );
  if (r.rows[0].hits > limit) throw new RateLimitError(r.rows[0].retry);
}
export async function limitClient(
  db: Database,
  request: Request,
  route: string,
) {
  const ip = clientAddress(request);
  await consumeLimit(db, "client", ip, 600, 60);
  if (route === "auth/login" || route === "auth/setup")
    await consumeLimit(db, "auth-client", ip, 20, 900);
}
export async function limitUser(
  db: Database,
  user: Identity,
  route: string,
  method: string,
) {
  await consumeLimit(
    db,
    method === "GET" ? "user-read" : "user-write",
    user.userId,
    method === "GET" ? 180 : 90,
    60,
  );
  if (
    [
      "admin/families",
      "auth/password",
      "members",
      "banks/credentials",
      "banks/connect",
      "banks/renew",
    ].includes(route) &&
    method === "POST"
  )
    await consumeLimit(db, "sensitive-write", user.userId, 5, 900);
  if (["help", "help/conversations/send"].includes(route) && method === "POST")
    await consumeLimit(db, "assistant", user.userId, 20, 600);
  if (["banks/read", "banks/read-due", "banks/analyze"].includes(route))
    await consumeLimit(db, "bank-work", user.familyId, 10, 300);
  if (["imports/preview", "planning/import"].includes(route))
    await consumeLimit(db, "import-work", user.userId, 5, 600);
  if (route === "export" || route === "export/family")
    await consumeLimit(db, "export-work", user.userId, 5, 600);
}
export async function cleanSecurityState(db: Database) {
  await db.query(
    "DELETE FROM security_rate_buckets WHERE expires_at<now()-interval '1 day'",
  );
  await db.query(
    "DELETE FROM sessions WHERE expires_at<now()-interval '1 day'",
  );
  await db.query(
    "DELETE FROM auth_attempts WHERE last_at<now()-interval '1 day'",
  );
}
