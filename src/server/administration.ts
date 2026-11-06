import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  createFamily,
  hashPassword,
  verifyPassword,
  type Identity,
} from "./auth.ts";
import type { Database } from "./db.ts";
import { UserError } from "./imports.ts";
export class AdministrationError extends UserError {}
export async function isAdministrator(db: Database, userId: string) {
  return (
    (
      await db.query("SELECT 1 FROM platform_administrators WHERE user_id=$1", [
        userId,
      ])
    ).rows.length === 1
  );
}
async function requireAdministrator(db: Database, user: Identity) {
  if (!(await isAdministrator(db, user.userId)))
    throw new AdministrationError("Esta área é exclusiva do administrador.");
}
export async function listFamilies(db: Database, user: Identity) {
  await requireAdministrator(db, user);
  return db.transaction(async (tx) => {
    await tx.query("SELECT set_config('app.user_id',$1,true)", [user.userId]);
    return (
      await tx.query<{
        id: string;
        name: string;
        people: { name: string; email: string }[];
      }>(
        `SELECT h.id,h.name,json_agg(json_build_object('name',u.name,'email',u.email) ORDER BY u.name) AS people FROM administered_families a JOIN households h ON h.id=a.household_id JOIN members m ON m.household_id=h.id JOIN users u ON u.id=m.user_id GROUP BY h.id,h.name ORDER BY h.name`,
      )
    ).rows;
  });
}
const person = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z
      .email()
      .max(200)
      .transform((s) => s.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
const schema = z
  .object({
    request_id: z.uuid(),
    familyName: z.string().trim().min(1).max(120),
    first: person,
    second: person,
    currentPassword: z.string().min(12).max(128),
  })
  .strict();
export async function registerFamily(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  await requireAdministrator(db, user);
  const input = schema.parse(raw);
  const current = (
    await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [user.userId],
    )
  ).rows[0];
  if (
    !current ||
    !(await verifyPassword(input.currentPassword, current.password_hash))
  )
    throw new AdministrationError("Senha de autorização inválida.");
  if (input.first.email === input.second.email)
    throw new UserError("Informe um e-mail individual para cada pessoa.");
  const spouseHash = await hashPassword(input.second.password);
  try {
    return await db.transaction(async (tx) => {
      await tx.query("SELECT set_config('app.user_id',$1,true)", [user.userId]);
      await tx.query("SELECT pg_advisory_xact_lock(716240230)");
      const previous = (
        await tx.query<{ household_id: string; created_by: string }>(
          "SELECT household_id,created_by FROM administered_families WHERE request_id=$1",
          [input.request_id],
        )
      ).rows[0];
      if (previous) {
        if (previous.created_by !== user.userId)
          throw new AdministrationError("Solicitação indisponível.");
        return { id: previous.household_id };
      }
      const count = (
        await tx.query<{ n: number }>(
          "SELECT count(*)::integer AS n FROM users",
        )
      ).rows[0].n;
      if (count + 2 > 30)
        throw new UserError(
          "O limite de 30 pessoas foi atingido. Nenhum acesso foi criado.",
        );
      const nested: Database = { ...db, transaction: async (fn) => fn(tx) };
      const ownerId = await createFamily(nested, {
        ...input.first,
        familyName: input.familyName,
      });
      await tx.exec("RESET ROLE");
      await tx.query("SELECT set_config('app.user_id',$1,true)", [user.userId]);
      const family = (
        await tx.query<{ household_id: string }>(
          "SELECT household_id FROM members WHERE user_id=$1",
          [ownerId],
        )
      ).rows[0].household_id;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [id, input.second.email, input.second.name, spouseHash],
      );
      await tx.query(
        "INSERT INTO members(household_id,user_id,role) VALUES($1,$2,'editor')",
        [family, id],
      );
      await tx.query(
        "INSERT INTO administered_families(household_id,created_by,request_id) VALUES($1,$2,$3)",
        [family, user.userId, input.request_id],
      );
      return { id: family };
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "23505"
    )
      throw new UserError(
        "Não foi possível criar os acessos. Verifique se os e-mails já estão cadastrados.",
      );
    throw error;
  }
}
