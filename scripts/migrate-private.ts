import { existsSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { getDb } from "../src/server/db.ts";
import { migrateRemoteDatabase } from "../src/server/postgres.ts";
import {
  captureFamily,
  migrateFamily,
  verifyFamily,
} from "../src/server/migration.ts";
for (const file of [".env.local", ".env"])
  if (existsSync(file)) process.loadEnvFile(file);
const destination = process.env.DATABASE_URL;
const expected = process.argv
  .find((v) => v.startsWith("--expected-host="))
  ?.split("=")[1];
if (
  !destination ||
  !expected ||
  !process.argv.includes("--allow-upload") ||
  new URL(destination).hostname !== expected
)
  throw new Error(
    "Migração exige conexão privada, host exato e --allow-upload. Nenhum envio executado.",
  );
if (
  !existsSync((process.env.FINANCE_DATA_DIR || "data") + "/postgres/PG_VERSION")
)
  throw new Error("Banco local não encontrado.");
async function main() {
  delete process.env.DATABASE_URL;
  const local = (await getDb()) as PGlite;
  let remote: Awaited<ReturnType<typeof migrateRemoteDatabase>> | undefined;
  try {
    const snapshot = await captureFamily(local);
    remote = await migrateRemoteDatabase(destination!);
    const counts = await migrateFamily(remote, snapshot);
    await verifyFamily(remote, snapshot);
    console.log(
      JSON.stringify({
        migration: "verified",
        counts,
        exact_contents: true,
        sessions_copied: false,
      }),
    );
  } finally {
    await local.close();
    await remote?.close();
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      migration: "not_completed",
      code: error?.code || "INTERNAL",
      note: "Nenhum dado parcial confirmado; confira a conexão, o destino vazio e as permissões.",
    }),
  );
  process.exitCode = 1;
});
