import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { existsSync } from "node:fs";
import { getDb } from "../src/server/db.ts";
import { encryptBackup, decryptBackup } from "../src/server/backup.ts";
for (const envFile of [".env.local", ".env"])
  if (existsSync(envFile)) process.loadEnvFile(envFile);
if (process.env.DATABASE_URL)
  throw new Error(
    "Este backup é exclusivo do banco local. Use o backup privado do provedor PostgreSQL remoto.",
  );
const password = process.env.BACKUP_PASSWORD;
if (!password || password.length < 16)
  throw new Error(
    "Defina BACKUP_PASSWORD com pelo menos 16 caracteres na sessão do terminal. Não coloque a senha na linha de comando ou em arquivo versionado.",
  );
if (process.argv[2] === "restore") {
  const input = process.argv[3],
    destination = process.argv[4];
  if (!input || !destination)
    throw new Error("Uso: npm run restore -- arquivo.enc NOVA_PASTA");
  const target = path.resolve(destination);
  try {
    await stat(target);
    throw new Error(
      "A pasta de restauração já existe; escolha uma pasta nova.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bytes = await decryptBackup(await readFile(input), password);
  await mkdir(target, { recursive: false });
  const db = new PGlite(path.join(target, "postgres"), {
    loadDataDir: new Blob([new Uint8Array(bytes)]),
  });
  await db.waitReady;
  await db.query("SELECT version FROM schema_migrations");
  await db.close();
  console.log(
    "Backup restaurado em nova pasta. Configure FINANCE_DATA_DIR com essa pasta antes de iniciar.",
  );
} else {
  if (
    !existsSync(
      path.resolve(
        process.env.FINANCE_DATA_DIR || "data",
        "postgres",
        "PG_VERSION",
      ),
    )
  )
    throw new Error(
      "Banco local não encontrado na pasta configurada. Nenhum banco vazio foi criado para backup.",
    );
  const db = (await getDb()) as PGlite;
  try {
    const snapshot = await db.dumpDataDir("gzip");
    const encrypted = await encryptBackup(
      new Uint8Array(await snapshot.arrayBuffer()),
      password,
    );
    const directory = path.resolve(
      process.env.FINANCE_DATA_DIR || "data",
      "backups",
    );
    await mkdir(directory, { recursive: true });
    const filename = path.join(
      directory,
      `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.enc`,
    );
    await writeFile(filename, encrypted, { flag: "wx" });
    console.log(
      "Backup completo criptografado criado em data/backups (ou no diretório de dados configurado). Guarde também a senha em local privado separado.",
    );
  } finally {
    await db.close();
  }
}
