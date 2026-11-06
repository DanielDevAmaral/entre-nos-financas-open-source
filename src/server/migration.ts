import { createHash } from "node:crypto";
import type { Database } from "./db.ts";
import type { Transaction } from "@electric-sql/pglite";
export const migrationTables = [
  "users",
  "households",
  "members",
  "accounts",
  "categories",
  "source_files",
  "import_batches",
  "economic_events",
  "ledger_entries",
  "staged_transactions",
  "event_sources",
  "budgets",
  "audit_events",
  "planning_sources",
  "planning_lines",
] as const;
type Column = { column_name: string; data_type: string };
type Row = Record<string, unknown>;
export type FamilySnapshot = {
  tables: Record<string, { columns: Column[]; rows: Row[]; digest: string }>;
  owner: string;
  family: string;
};
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function digest(rows: Row[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(rows.map((r) => JSON.stringify(canonical(r))).sort()),
    )
    .digest("hex");
}
async function tableRows(tx: Transaction, table: string, columns: Column[]) {
  const exact = new Set([
    "date",
    "timestamp with time zone",
    "timestamp without time zone",
    "bigint",
    "numeric",
  ]);
  const select = columns
    .map((c) =>
      exact.has(c.data_type)
        ? `${quote(c.column_name)}::text AS ${quote(c.column_name)}`
        : quote(c.column_name),
    )
    .join(",");
  return (await tx.query<Row>(`SELECT ${select} FROM ${quote(table)}`)).rows;
}
export async function captureFamily(db: Database): Promise<FamilySnapshot> {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL TIME ZONE 'UTC'");
    const tables: FamilySnapshot["tables"] = {};
    for (const table of migrationTables) {
      const columns = (
        await tx.query<Column>(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
          [table],
        )
      ).rows;
      if (!columns.length) throw new Error("Tabela de origem indisponível.");
      const rows = await tableRows(tx, table, columns);
      tables[table] = { columns, rows, digest: digest(rows) };
    }
    if (tables.households.rows.length !== 1)
      throw new Error("A migração exige exatamente uma família.");
    const owner = tables.members.rows.find((r) => r.role === "owner");
    if (!owner) throw new Error("Proprietário ausente.");
    if (
      tables.users.rows.some(
        (u) => !tables.members.rows.some((m) => m.user_id === u.id),
      )
    )
      throw new Error("Usuário fora da família.");
    return {
      tables,
      owner: String(owner.user_id),
      family: String(owner.household_id),
    };
  });
}
export async function verifyFamily(db: Database, snapshot: FamilySnapshot) {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL TIME ZONE 'UTC'");
    for (const table of ["users", "households", "members"]) {
      const expected = snapshot.tables[table];
      const rows = await tableRows(tx, table, expected.columns);
      if (digest(rows) !== expected.digest)
        throw new Error("Acessos divergentes.");
    }
    await tx.exec("SET LOCAL ROLE family_app");
    await tx.query("SELECT set_config('app.user_id',$1,true)", [
      snapshot.owner,
    ]);
    const counts: Record<string, number> = {};
    for (const table of migrationTables.filter(
      (t) => !["users", "households", "members"].includes(t),
    )) {
      const expected = snapshot.tables[table];
      const rows = await tableRows(tx, table, expected.columns);
      if (
        rows.length !== expected.rows.length ||
        digest(rows) !== expected.digest
      )
        throw new Error("Conteúdo divergente.");
      counts[table] = rows.length;
    }
    return counts;
  });
}
export async function migrateFamily(db: Database, snapshot: FamilySnapshot) {
  return db.transaction(async (tx) => {
    await tx.exec("SET LOCAL TIME ZONE 'UTC'");
    await tx.query("SELECT pg_advisory_xact_lock(716240211)");
    if (
      (await tx.query("SELECT 1 FROM users LIMIT 1")).rows.length ||
      (await tx.query("SELECT 1 FROM households LIMIT 1")).rows.length
    )
      throw new Error("O destino precisa estar vazio.");
    const counts: Record<string, number> = {};
    for (const table of migrationTables) {
      if (table === "accounts") {
        await tx.exec("SET LOCAL ROLE family_app");
        await tx.query("SELECT set_config('app.user_id',$1,true)", [
          snapshot.owner,
        ]);
      }
      const { columns } = snapshot.tables[table];
      let rows = snapshot.tables[table].rows;
      if (table === "economic_events") {
        const remaining = [...rows],
          ordered: Row[] = [],
          seen = new Set();
        while (remaining.length) {
          const index = remaining.findIndex(
            (r) => !r.related_event_id || seen.has(r.related_event_id),
          );
          if (index < 0) throw new Error("Referências circulares.");
          const [row] = remaining.splice(index, 1);
          ordered.push(row);
          seen.add(row.id);
        }
        rows = ordered;
      }
      for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = rows.slice(offset, offset + 100);
        const values: unknown[] = [];
        const placeholders = chunk
          .map(
            (row) =>
              "(" +
              columns
                .map((c) => {
                  values.push(
                    c.data_type === "jsonb"
                      ? JSON.stringify(row[c.column_name])
                      : row[c.column_name],
                  );
                  return "$" + values.length;
                })
                .join(",") +
              ")",
          )
          .join(",");
        await tx.query(
          `INSERT INTO ${quote(table)}(${columns.map((c) => quote(c.column_name)).join(",")}) VALUES ${placeholders}`,
          values,
        );
      }
      const actual = await tableRows(tx, table, columns);
      if (
        actual.length !== rows.length ||
        digest(actual) !== snapshot.tables[table].digest
      )
        throw new Error("Conteúdo da migração divergente.");
      counts[table] = actual.length;
    }
    // Force deferred ledger checks before reporting success; any failure rolls back all data.
    await tx.exec("SET CONSTRAINTS ALL IMMEDIATE");
    return counts;
  });
}
