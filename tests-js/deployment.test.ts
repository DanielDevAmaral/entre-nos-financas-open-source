import { test } from "node:test";
import assert from "node:assert/strict";
import { deployment, validSecret } from "../src/server/deployment.ts";
import { assertLocal } from "../src/server/http.ts";
import {
  postgresConfig,
  createPostgresDatabase,
} from "../src/server/postgres.ts";
import type { Pool } from "pg";
import { readFile } from "node:fs/promises";
test("hosted access fails closed; exact HTTPS origin and bootstrap token required", () => {
  const old = {
    database: process.env.DATABASE_URL,
    origin: process.env.APP_ORIGIN,
  };
  try {
    process.env.DATABASE_URL = "postgres://fake.invalid/test";
    delete process.env.APP_ORIGIN;
    assert.throws(() => deployment());
    for (const origin of [
      "http://finance.example",
      "https://finance.example/",
      "https://finance.example/path",
    ]) {
      process.env.APP_ORIGIN = origin;
      assert.throws(() => deployment());
    }
    process.env.APP_ORIGIN = "https://finance.example";
    assert.equal(deployment().remote, true);
    const req = (host: string, origin: string) =>
      new Request("https://finance.example/api/test", {
        headers: { host, origin },
        method: "POST",
      });
    assert.doesNotThrow(() =>
      assertLocal(req("finance.example", "https://finance.example"), true),
    );
    assert.throws(() =>
      assertLocal(req("finance.example", "https://evil.invalid"), true),
    );
    assert.throws(() =>
      assertLocal(req("evil.invalid", "https://finance.example"), true),
    );
    assert.equal(validSecret("short", "short"), false);
    assert.equal(validSecret("x".repeat(32), "y".repeat(32)), false);
    assert.equal(validSecret("x".repeat(32), "x".repeat(32)), true);
  } finally {
    for (const [key, value] of [
      ["DATABASE_URL", old.database],
      ["APP_ORIGIN", old.origin],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});
test("remote TLS certificate validation cannot be disabled by URL options", () => {
  const config = postgresConfig(
    "postgresql://example:fake@db.example/db?sslmode=no-verify",
  );
  assert.deepEqual(config.ssl, { rejectUnauthorized: true, minVersion: "TLSv1.2" });
  assert.equal(config.enableChannelBinding, true);
  assert.ok(!config.connectionString.includes("sslmode"));
  assert.equal(postgresConfig("postgresql://localhost/test").ssl, false);
  assert.throws(() => postgresConfig("https://db.example"));
});
test("PostgreSQL transaction pins its client, rolls back on failure and releases it", async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      return { rows: [], fields: [], rowCount: 0 };
    },
    release: () => calls.push("release"),
  };
  const db = createPostgresDatabase({
    connect: async () => client,
    end: async () => {},
  } as unknown as Pool);
  await db.transaction(async (tx) => {
    await tx.query("SELECT 1");
  });
  assert.deepEqual(calls, ["BEGIN", "SELECT 1", "COMMIT", "release"]);
  calls.length = 0;
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("SELECT 2");
      throw new Error("fake");
    }),
  );
  assert.deepEqual(calls, ["BEGIN", "SELECT 2", "ROLLBACK", "release"]);
});
test("service worker bypasses API and financial caching; offline navigation receives only public notice", async () => {
  const sw = await readFile("public/sw.js", "utf8");
  const { runInNewContext } = await import("node:vm");
  const handlers: Record<string, (event: unknown) => void> = {};
  const cached: string[] = [];
  runInNewContext(sw, {
    URL,
    self: {
      location: { origin: "https://finance.example" },
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        handlers[name] = fn;
      },
    },
    fetch: async () => {
      throw new Error("offline");
    },
    caches: {
      match: async (key: string) => {
        cached.push(key);
        return "public notice";
      },
    },
  });
  let response: Promise<unknown> | undefined;
  handlers.fetch({
    request: {
      url: "https://finance.example/api/state",
      method: "GET",
      mode: "cors",
    },
    respondWith: () => assert.fail("Financial API must bypass worker"),
  });
  handlers.fetch({
    request: {
      url: "https://finance.example/",
      method: "GET",
      mode: "navigate",
    },
    respondWith: (p: Promise<unknown>) => {
      response = p;
    },
  });
  assert.equal(await response, "public notice");
  assert.deepEqual(cached, ["/offline.html"]);
});

test("remote role migration preserves dollar quoting and accepts an existing safe role", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { remoteMigrationSql } = await import("../src/server/postgres.ts");
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE family_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await db.exec(
      remoteMigrationSql(
        1,
        await readFile("db/migrations/001_initial.sql", "utf8"),
      ),
    );
    assert.equal((await db.query("SELECT 1 FROM accounts")).rows.length, 0);
  } finally {
    await db.close();
  }
});
