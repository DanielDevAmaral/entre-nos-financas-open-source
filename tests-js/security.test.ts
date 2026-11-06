import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCronHost,
  assertLocal,
  csvCell,
  limitedBody,
} from "../src/server/http.ts";
import { encryptBackup, decryptBackup } from "../src/server/backup.ts";
import { openDatabase } from "../src/server/db.ts";
import { PGlite } from "@electric-sql/pglite";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
test("operações exigem host local e origem exata; DNS rebinding e CSRF são recusados", () => {
  process.env.APP_PORT = "3210";
  const req = (host: string, origin?: string) =>
    new Request("http://127.0.0.1:3210/api/accounts", {
      method: "POST",
      headers: { host, ...(origin ? { origin } : {}) },
    });
  assert.doesNotThrow(() =>
    assertLocal(req("127.0.0.1:3210", "http://127.0.0.1:3210"), true),
  );
  assert.throws(() =>
    assertLocal(req("evil.invalid", "http://evil.invalid"), true),
  );
  assert.throws(() =>
    assertLocal(req("127.0.0.1:3210", "http://evil.invalid"), true),
  );
  assert.throws(() => assertLocal(req("127.0.0.1:3210"), true));
});
test("limite de formulário é aplicado também sem content-length", async () => {
  const request = new Request("http://127.0.0.1", {
    method: "POST",
    body: "0123456789",
  });
  await assert.rejects(limitedBody(request, 5));
});
test("CSV escapa aspas e impede interpretação de descrições como fórmulas", () => {
  assert.equal(csvCell('texto "fictício"'), '"texto ""fictício"""');
  for (const value of ["=1+1", "+SOMA(1)", "-SOMA(1)", "@SUM(1)", "  =1"])
    assert.ok(csvCell(value).startsWith("\"'"));
});
test("backup criptografado restaura um PostgreSQL com dados fictícios e rejeita adulteração", async () => {
  const db = await openDatabase();
  try {
    await db.exec(
      "CREATE TABLE teste_backup(id integer PRIMARY KEY,descricao text);INSERT INTO teste_backup VALUES(1,'Somente dados fictícios')",
    );
    const dump = await db.dumpDataDir("gzip");
    const encrypted = await encryptBackup(
      new Uint8Array(await dump.arrayBuffer()),
      "SenhaFicticiaBackup!2026",
    );
    assert.equal(
      encrypted.includes(Buffer.from("Somente dados fictícios")),
      false,
    );
    await assert.rejects(decryptBackup(encrypted, "SenhaFicticiaIncorreta"));
    const decrypted = await decryptBackup(
      encrypted,
      "SenhaFicticiaBackup!2026",
    );
    const restored = new PGlite({
      loadDataDir: new Blob([new Uint8Array(decrypted)]),
    });
    await restored.waitReady;
    try {
      assert.equal(
        (
          await restored.query<{ descricao: string }>(
            "SELECT descricao FROM teste_backup",
          )
        ).rows[0].descricao,
        "Somente dados fictícios",
      );
    } finally {
      await restored.close();
    }
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    await assert.rejects(decryptBackup(tampered, "SenhaFicticiaBackup!2026"));
  } finally {
    await db.close();
  }
});
test("banco local persiste após fechar e reabrir; migrations são idempotentes", async () => {
  await mkdir("work", { recursive: true });
  const folder = await mkdtemp(path.resolve("work/persistencia-ficticia-"));
  const first = await openDatabase(folder);
  await first.exec(
    "CREATE TABLE persistencia_ficticia(id integer);INSERT INTO persistencia_ficticia VALUES(42)",
  );
  const versions = (
    await first.query("SELECT version FROM schema_migrations ORDER BY version")
  ).rows;
  await first.close();
  const second = await openDatabase(folder);
  try {
    assert.equal(
      (
        await second.query<{ id: number }>(
          "SELECT id FROM persistencia_ficticia",
        )
      ).rows[0].id,
      42,
    );
    assert.deepEqual(
      (
        await second.query(
          "SELECT version FROM schema_migrations ORDER BY version",
        )
      ).rows,
      versions,
    );
  } finally {
    await second.close();
  }
});
test("atualização de banco preenchido preserva partidas e não deixa triggers pendentes", async () => {
  await mkdir("work", { recursive: true });
  const folder = await mkdtemp(path.resolve("work/upgrade-ficticio-"));
  const old = new PGlite(folder);
  await old.waitReady;
  await old.exec(
    "CREATE TABLE schema_migrations(version integer PRIMARY KEY,applied_at timestamptz DEFAULT now())",
  );
  await old.exec(await readFile("db/migrations/001_initial.sql", "utf8"));
  await old.exec("INSERT INTO schema_migrations(version) VALUES(1)");
  await old.transaction(async (tx) => {
    await tx.exec(
      "INSERT INTO users(id,email,name,password_hash) VALUES('00000000-0000-0000-0000-000000000001','upgrade@example.invalid','Fictício','hash fictício');INSERT INTO households(id,name) VALUES('00000000-0000-0000-0000-000000000002','Família fictícia');INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','Conta fictícia','Teste','BRL','checking','00000000-0000-0000-0000-000000000001');INSERT INTO economic_events(id,household_id,account_id,kind,transaction_date,description,original_description,amount_cents,currency,created_by) VALUES('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','income','2026-01-02','Fictício','Fictício',100,'BRL','00000000-0000-0000-0000-000000000001');INSERT INTO ledger_entries(id,household_id,event_id,account_id,nominal,currency,amount_cents) VALUES('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000003',NULL,'BRL',100),('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004',NULL,'income','BRL',-100)",
    );
  });
  await old.close();
  const upgraded = await openDatabase(folder);
  try {
    const entries = (
      await upgraded.query<{ day: string }>(
        "SELECT transaction_date::text AS day FROM ledger_entries",
      )
    ).rows;
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.day === "2026-01-02"));
  } finally {
    await upgraded.close();
  }
});

test("authenticated cron may target only its exact production deployment; ordinary APIs still reject it", () => {
  const old = {
    DATABASE_URL: process.env.DATABASE_URL,
    APP_ORIGIN: process.env.APP_ORIGIN,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  try {
    process.env.DATABASE_URL = "postgres://synthetic.invalid/test";
    process.env.APP_ORIGIN = "https://family.example.invalid";
    process.env.VERCEL_URL = "family-deployment-123.vercel.app";
    process.env.VERCEL_ENV = "production";
    const req = (host: string) =>
      new Request("https://" + host + "/api/cron/reminders", {
        headers: { host },
      });
    assert.doesNotThrow(() =>
      assertCronHost(req("family-deployment-123.vercel.app")),
    );
    assert.doesNotThrow(() => assertCronHost(req("family.example.invalid")));
    assert.throws(() => assertCronHost(req("other-deployment.vercel.app")));
    assert.throws(() => assertLocal(req("family-deployment-123.vercel.app")));
    process.env.VERCEL_ENV = "preview";
    assert.throws(() =>
      assertCronHost(req("family-deployment-123.vercel.app")),
    );
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
