import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readFile, readdir, mkdir, open, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { deployment } from "./deployment.ts";
import { randomUUID } from "node:crypto";
export type Database = Pick<PGlite, "query" | "exec" | "transaction">;

export async function openDatabase(dataDir?: string): Promise<PGlite> {
  const db = new PGlite(dataDir, { relaxedDurability: false });
  await db.waitReady;
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const folder = path.join(process.cwd(), "db/migrations");
  try {
    for (const filename of (await readdir(folder))
      .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
      .sort()) {
      const version = Number(filename.split("_")[0]);
      const found = await db.query(
        "SELECT version FROM schema_migrations WHERE version=$1",
        [version],
      );
      if (found.rows.length) continue;
      const sql = await readFile(path.join(folder, filename), "utf8");
      await db.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations(version) VALUES($1)", [
          version,
        ]);
      });
    }
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}
type GlobalDatabase = typeof globalThis & {
  familyDatabase?: Promise<Database>;
};
export async function getDb(): Promise<Database> {
  const root = globalThis as GlobalDatabase;
  if (!root.familyDatabase)
    root.familyDatabase = (async () => {
      if (process.env.DATABASE_URL) {
        deployment();
        const { openRemoteDatabase } = await import("./postgres.ts");
        return openRemoteDatabase(process.env.DATABASE_URL);
      }
      const folder = path.resolve(
        /* turbopackIgnore: true */ process.env.FINANCE_DATA_DIR || "data",
      );
      await mkdir(folder, { recursive: true });
      const lock = path.join(folder, "database.lock");
      const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
      try {
        const file = await open(lock, "wx");
        await file.writeFile(token);
        await file.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const old = JSON.parse(await readFile(lock, "utf8")) as { pid: number };
        let alive = true;
        try {
          process.kill(old.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive)
          throw new Error(
            "O banco já está aberto em outro processo. Feche a outra instância.",
          );
        await unlink(lock);
        const file = await open(lock, "wx");
        await file.writeFile(token);
        await file.close();
      }
      process.once("exit", () => {
        try {
          if (readFileSync(lock, "utf8") === token) unlinkSync(lock);
        } catch {
          /* Lock expirado será conferido no próximo início. */
        }
      });
      return openDatabase(path.join(folder, "postgres"));
    })();
  return root.familyDatabase;
}
export async function asUser<T>(
  db: Database,
  userId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL ROLE family_app");
    await tx.query("SELECT set_config('app.user_id',$1,true)", [userId]);
    return work(tx);
  });
}
export async function recordAudit(
  tx: Transaction,
  family: string,
  actor: string,
  action: string,
  entity: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.query(
    "INSERT INTO audit_events(id,household_id,actor_id,action,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), family, actor, action, entity, JSON.stringify(metadata)],
  );
}
