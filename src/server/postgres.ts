import { Pool, types, type PoolClient, type QueryResult } from "pg";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Transaction, Results } from "@electric-sql/pglite";
import type { Database } from "./db.ts";

// Monetary integers and calendar dates must retain their exact source values.
types.setTypeParser(20, (value) => value);
types.setTypeParser(1082, (value) => value);
function result<T>(r: QueryResult): Results<T> {
  return {
    rows: r.rows as T[],
    fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    affectedRows: r.rowCount ?? 0,
  };
}
function methods(client: PoolClient | Pool): Pick<Database, "query" | "exec"> {
  return {
    query: async <T>(sql: string, params?: unknown[]) =>
      result<T>(await client.query(sql, params)),
    exec: async (sql: string) => {
      const r = await client.query(sql);
      return (Array.isArray(r) ? r : [r]).map((v) => result(v));
    },
  };
}
export function createPostgresDatabase(
  pool: Pool,
): Database & { close: () => Promise<void> } {
  return {
    ...methods(pool),
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const value = await fn(methods(client) as Transaction);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
export function postgresConfig(connection: string) {
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Use uma conexão PostgreSQL válida.");
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  // Remove SSL URL options so they cannot silently replace certificate verification.
  for (const key of [
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "sslnegotiation",
  ])
    url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl: local
      ? false
      : { rejectUnauthorized: true, minVersion: "TLSv1.2" as const },
    enableChannelBinding: true,
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 15000,
    lock_timeout: 10000,
    application_name: "entre-nos",
  };
}
export function remoteMigrationSql(version: number, source: string) {
  if (version !== 1) return source;
  return source.replace(
    "CREATE ROLE family_app NOLOGIN NOSUPERUSER NOBYPASSRLS;",
    () =>
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='family_app') THEN CREATE ROLE family_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$;",
  );
}
export async function migrateRemoteDatabase(connection: string) {
  const pool = new Pool(postgresConfig(connection));
  pool.on("error", () => {
    /* Never log SQL, connection strings or financial values. */
  });
  const db = createPostgresDatabase(pool);
  try {
    await db.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(716240210)");
      await tx.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      const files = (await readdir(path.join(process.cwd(), "db/migrations")))
        .filter((n) => /^\d+_[a-z_]+\.sql$/.test(n))
        .sort();
      for (const file of files) {
        const version = Number(file.split("_")[0]);
        if (
          (
            await tx.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
              version,
            ])
          ).rows.length
        )
          continue;
        let sql = await readFile(
          path.join(process.cwd(), "db/migrations", file),
          "utf8",
        );
        // Roles are cluster-wide, while schema_migrations belongs to this database.
        sql = remoteMigrationSql(version, sql);
        await tx.exec(sql);
        await tx.query("INSERT INTO schema_migrations(version) VALUES($1)", [
          version,
        ]);
      }
      const role = (
        await tx.query<{ unsafe: boolean }>(
          "SELECT rolsuper OR rolbypassrls OR rolcanlogin AS unsafe FROM pg_roles WHERE rolname='family_app'",
        )
      ).rows[0];
      if (!role || role.unsafe)
        throw new Error("Papel financeiro inseguro; configuração recusada.");
      await tx.exec(
        "DO $$ BEGIN EXECUTE format('GRANT family_app TO %I',current_user); END $$;",
      );
    });
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
export async function openRemoteDatabase(connection: string) {
  const pool = new Pool(postgresConfig(connection));
  pool.on("error", () => {});
  const db = createPostgresDatabase(pool);
  try {
    const unsafe = (
      await db.query<{ unsafe: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) AND pg_has_role(current_user,r.oid,'MEMBER'))
       OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND pg_has_role(current_user,c.relowner,'MEMBER'))
       OR EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_has_role(current_user,datdba,'MEMBER'))
       OR has_schema_privilege(current_user,'public','CREATE')
       OR has_database_privilege(current_user,current_database(),'CREATE') AS unsafe`,
      )
    ).rows[0];
    if (!unsafe || unsafe.unsafe)
      throw new Error(
        "Runtime administrativo recusado. Use uma credencial restrita; migrations devem ser executadas separadamente.",
      );
    const versions = (
      await db.query<{ version: number }>(
        "SELECT version FROM schema_migrations",
      )
    ).rows.map((r) => r.version);
    const expected = (await readdir(path.join(process.cwd(), "db/migrations")))
      .filter((n) => /^\d+_[a-z_]+\.sql$/.test(n))
      .map((n) => Number(n.split("_")[0]));
    if (expected.some((v) => !versions.includes(v)))
      throw new Error(
        "Migrations pendentes. Execute a rotina administrativa antes da publicação.",
      );
    const role = (
      await db.query<{ unsafe: boolean }>(
        "SELECT rolsuper OR rolbypassrls OR rolcanlogin AS unsafe FROM pg_roles WHERE rolname='family_app'",
      )
    ).rows[0];
    if (!role || role.unsafe)
      throw new Error("Papel financeiro inseguro; configuração recusada.");
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
