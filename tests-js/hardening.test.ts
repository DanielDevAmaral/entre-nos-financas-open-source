import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, issueSession, identity } from "../src/server/auth.ts";
import {
  consumeLimit,
  RateLimitError,
  rateKey,
  clientAddress,
  limitUser,
  cleanSecurityState,
} from "../src/server/rate-limit.ts";
import { bodyJson, HttpError } from "../src/server/http.ts";
import { allowedMethods } from "../src/server/api-policy.ts";
import { contentSecurityPolicy } from "../src/server/csp.ts";

test("shared database throttle is atomic, bounded, independent by key, expires and is inaccessible to family users", async () => {
  const db = await openDatabase();
  try {
    const result = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        consumeLimit(db, "test", "fictitious-client", 5, 60),
      ),
    );
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 5);
    for (const r of result)
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof RateLimitError);
        assert.ok(r.reason.retryAfter >= 1 && r.reason.retryAfter <= 60);
      }
    const before = await db.query<{ expires_at: Date }>(
      "SELECT expires_at FROM security_rate_buckets WHERE scope='test'",
    );
    await assert.rejects(
      consumeLimit(db, "test", "fictitious-client", 5, 60),
      RateLimitError,
    );
    const after = await db.query<{ hits: number; expires_at: Date }>(
      "SELECT hits,expires_at FROM security_rate_buckets WHERE scope='test'",
    );
    assert.equal(after.rows[0].hits, 6);
    assert.equal(
      String(after.rows[0].expires_at),
      String(before.rows[0].expires_at),
    );
    assert.equal(JSON.stringify(after).includes("fictitious-client"), false);
    await consumeLimit(db, "test", "other-client", 5, 60);
    await db.query(
      "UPDATE security_rate_buckets SET expires_at=now()-interval '1 second'",
    );
    await consumeLimit(db, "test", "fictitious-client", 5, 60);
    assert.equal(
      (
        await db.query<{ hits: number }>(
          "SELECT hits FROM security_rate_buckets WHERE key_hash=$1",
          [rateKey("fictitious-client")],
        )
      ).rows[0].hits,
      1,
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE family_app");
        await tx.query("SELECT * FROM security_rate_buckets");
      }),
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec("SET LOCAL ROLE family_app");
        await tx.query("DELETE FROM security_rate_buckets");
      }),
    );
    const fake = {
      userId: randomUUID(),
      familyId: randomUUID(),
      role: "owner" as const,
      name: "Fictitious",
      email: "a@example.invalid",
    };
    for (let i = 0; i < 5; i++)
      await limitUser(db, fake, "export/family", "GET");
    await assert.rejects(
      limitUser(db, fake, "export/family", "GET"),
      RateLimitError,
    );
    await db.query(
      "UPDATE security_rate_buckets SET expires_at=now()-interval '2 days'",
    );
    await cleanSecurityState(db);
    assert.equal(
      (await db.query("SELECT 1 FROM security_rate_buckets")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});

test("untrusted IP headers cannot change local rate keys; only Vercel's header is used on Vercel", () => {
  const old = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    const r = new Request("https://example.invalid", {
      headers: {
        "x-forwarded-for": "192.0.2.1",
        "x-vercel-forwarded-for": "192.0.2.2",
      },
    });
    assert.equal(clientAddress(r), "unattributed");
    process.env.VERCEL = "1";
    assert.equal(clientAddress(r), "192.0.2.2");
    assert.equal(
      clientAddress(
        new Request("https://example.invalid", {
          headers: { "x-vercel-forwarded-for": "192.0.2.2, 192.0.2.3" },
        }),
      ),
      "unattributed",
    );
  } finally {
    if (old === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = old;
  }
});

test("JSON rejects smuggled media types, oversize, nested input, prototype keys, invalid UTF8 and null characters", async () => {
  const req = (body: string | Uint8Array, type = "application/json") =>
    new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": type },
      body: body as BodyInit,
    });
  assert.deepEqual(
    await bodyJson(
      req('{"label":"Família <teste>"}', "application/json; charset=utf-8"),
    ),
    { label: "Família <teste>" },
  );
  for (const text of [
    "null",
    "[]",
    "1",
    '{"constructor":{}}',
    '{"__proto__":{"admin":true}}',
    '{"text":"a\\u0000b"}',
    "[".repeat(25) + "0" + "]".repeat(25),
    '{"x":'.repeat(25) + "0" + "}".repeat(25),
  ])
    await assert.rejects(bodyJson(req(text)), HttpError);
  await assert.rejects(
    bodyJson(req("{}", "application/json.evil")),
    (e) => e instanceof HttpError && e.status === 415,
  );
  await assert.rejects(
    bodyJson(req('{"text":"too long"}'), 3),
    (e) => e instanceof HttpError && e.status === 413,
  );
  await assert.rejects(
    bodyJson(req(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]))),
  );
});

test("API methods and segments are allowlisted; script CSP uses a nonce without inline/eval in production", () => {
  const id = randomUUID();
  assert.deepEqual(allowedMethods("auth/login"), ["POST"]);
  assert.deepEqual(allowedMethods("routine"), ["GET"]);
  assert.deepEqual(allowedMethods("imports/" + id + "/confirm"), ["POST"]);
  assert.deepEqual(allowedMethods("imports/" + id + "/confirm/extra"), []);
  assert.deepEqual(allowedMethods("unknown"), []);
  assert.deepEqual(allowedMethods("profile/preferences"), ["GET", "POST"]);
  const csp = contentSecurityPolicy(
    Buffer.from(randomUUID()).toString("base64"),
  );
  const script = csp.split(";").find((x) => x.includes("script-src"))!;
  assert.ok(script.includes("'nonce-"));
  assert.ok(!script.includes("unsafe-inline"));
  assert.ok(!script.includes("unsafe-eval"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.throws(() => contentSecurityPolicy("'unsafe-inline'"));
});

test("tenant table inventory forces RLS, denies missing context and cross-family IDs; ambiguous sessions fail closed", async () => {
  const db = await openDatabase();
  try {
    const make = async (email: string) => {
      const id = await createFamily(db, {
        email,
        name: "Fictitious",
        familyName: "Test only",
        password: "Fictitious!2026abc",
      });
      return (await identity(db, await issueSession(db, id)))!;
    };
    const a = await make("first@example.invalid"),
      b = await make("second@example.invalid");
    const tables = (
      await db.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='household_id' AND table_name NOT IN ('members') ORDER BY table_name",
      )
    ).rows;
    assert.ok(tables.length > 20);
    for (const { table_name: t } of tables) {
      assert.ok(/^[a-z_]+$/.test(t));
      const flags = (
        await db.query<{ rls: boolean; forced: boolean }>(
          "SELECT relrowsecurity AS rls,relforcerowsecurity AS forced FROM pg_class WHERE oid=$1::regclass",
          [t],
        )
      ).rows[0];
      assert.equal(flags.rls, true, t);
      assert.equal(flags.forced, true, t);
      await asUser(db, a.userId, async (tx) => {
        const rows = await tx.query<{ household_id: string }>(
          `SELECT household_id FROM "${t}"`,
        );
        assert.ok(
          rows.rows.every((r) => r.household_id === a.familyId),
          t,
        );
        assert.equal(
          (
            await tx.query(`SELECT 1 FROM "${t}" WHERE household_id=$1`, [
              b.familyId,
            ])
          ).rows.length,
          0,
          t,
        );
      });
    }
    await db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE family_app");
      assert.equal((await tx.query("SELECT 1 FROM categories")).rows.length, 0);
    });
    const token = await issueSession(db, a.userId);
    await db.query(
      "INSERT INTO members(household_id,user_id,role) VALUES($1,$2,'reader')",
      [b.familyId, a.userId],
    );
    assert.equal(await identity(db, token), null);
  } finally {
    await db.close();
  }
});
