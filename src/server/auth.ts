import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import type { Database } from "./db.ts";
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export type Identity = {
  userId: string;
  familyId: string;
  role: "owner" | "editor" | "reader";
  name: string;
  email: string;
};
export class AuthError extends Error {}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [method, salt, key] = encoded.split("$");
  if (method !== "scrypt" || !salt || !key) return false;
  const actual = await derive(password, salt);
  const expected = Buffer.from(key, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
const categoryNames = [
  "Moradia",
  "Alimentação",
  "Transporte",
  "Saúde",
  "Educação",
  "Lazer",
  "Assinaturas",
  "Compras pessoais",
  "Família",
  "Impostos e tarifas",
  "Doações",
  "Receitas profissionais",
  "Outras receitas",
  "Outras despesas",
];
export async function createFamily(
  db: Database,
  input: { email: string; name: string; password: string; familyName: string },
  firstOnly = false,
): Promise<string> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    if (firstOnly) await tx.query("SELECT pg_advisory_xact_lock(716240211)");
    if (
      firstOnly &&
      (await tx.query("SELECT 1 FROM users LIMIT 1")).rows.length
    )
      throw new Error("A configuração inicial já foi concluída.");
    const id = randomUUID(),
      family = randomUUID();
    await tx.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
      [id, input.email.toLowerCase(), input.name, passwordHash],
    );
    await tx.query("INSERT INTO households(id,name) VALUES($1,$2)", [
      family,
      input.familyName,
    ]);
    await tx.query(
      "INSERT INTO members(household_id,user_id,role) VALUES($1,$2,'owner')",
      [family, id],
    );
    await tx.exec("SET LOCAL ROLE family_app");
    await tx.query("SELECT set_config('app.user_id',$1,true)", [id]);
    for (const name of categoryNames)
      await tx.query(
        "INSERT INTO categories(id,household_id,name) VALUES($1,$2,$3)",
        [randomUUID(), family, name],
      );
    return id;
  });
}
export async function issueSession(
  db: Database,
  userId: string,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
    [digest(token), userId],
  );
  return token;
}
export async function identity(
  db: Database,
  token: string | undefined,
): Promise<Identity | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const result = await db.query<Identity>(
    'SELECT u.id AS "userId",m.household_id AS "familyId",m.role,u.name,u.email FROM sessions s JOIN users u ON u.id=s.user_id JOIN members m ON m.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',
    [digest(token)],
  );
  // Refuse ambiguous membership; selecting a household must be explicit in a
  // future multi-family schema, never whichever JOIN row happens to be first.
  return result.rows.length === 1 ? result.rows[0] : null;
}
export async function login(
  db: Database,
  email: string,
  password: string,
): Promise<string> {
  const key = digest(email.toLowerCase());
  const attempt = await db.query<{ blocked: boolean }>(
    "SELECT blocked_until>now() AS blocked FROM auth_attempts WHERE email_hash=$1",
    [key],
  );
  if (attempt.rows[0]?.blocked)
    throw new AuthError(
      "Muitas tentativas. Aguarde 15 minutos e tente novamente.",
    );
  const users = await db.query<{ id: string; password_hash: string }>(
    "SELECT id,password_hash FROM users WHERE email=$1",
    [email.toLowerCase()],
  );
  const user = users.rows[0];
  const valid = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(
        password,
        "scrypt$00000000000000000000000000000000$" + "00".repeat(64),
      );
  if (!user || !valid) {
    await db.query(
      "INSERT INTO auth_attempts(email_hash,failures,last_at) VALUES($1,1,now()) ON CONFLICT(email_hash) DO UPDATE SET failures=CASE WHEN auth_attempts.last_at<now()-interval '15 minutes' THEN 1 ELSE auth_attempts.failures+1 END,last_at=now(),blocked_until=CASE WHEN auth_attempts.failures>=4 AND auth_attempts.last_at>now()-interval '15 minutes' THEN now()+interval '15 minutes' ELSE NULL END",
      [key],
    );
    throw new AuthError("E-mail ou senha inválidos.");
  }
  await db.query("DELETE FROM auth_attempts WHERE email_hash=$1", [key]);
  return issueSession(db, user.id);
}
