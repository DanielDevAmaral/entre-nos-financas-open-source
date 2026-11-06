import { migrateRemoteDatabase } from "../src/server/postgres.ts";
const connection = process.env.MIGRATION_DATABASE_URL;
if (!connection)
  throw new Error(
    "Defina MIGRATION_DATABASE_URL somente no ambiente administrativo.",
  );
const db = await migrateRemoteDatabase(connection);
await db.close();
console.log("Migrations administrativas concluídas.");
