import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { localHelp, type HelpContext } from "../src/domain/help.ts";
import type { MonthlyItem } from "../src/server/routine.ts";
import { externalPayload, askHelp, helpStatus } from "../src/server/help.ts";
import { readInvestments } from "../src/server/future.ts";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
const item = (overrides: Partial<MonthlyItem>): MonthlyItem => ({
  id: randomUUID(),
  month: "2026-10-01",
  label: "Conta fictícia",
  purpose: "expense",
  currency: "BRL",
  planned_cents: "10000",
  paid_cents: null,
  status: "open",
  due_date: null,
  paid_date: null,
  notes: "",
  source_note: "",
  source_line_id: null,
  category_id: null,
  event_id: null,
  derived: false,
  version: 1,
  actual_reference_cents: null,
  ...overrides,
});
const context: HelpContext = {
  month: "2026-10",
  currency: "BRL",
  today: "2026-10-22",
  items: [
    item({
      label: "Internet",
      status: "partial",
      paid_cents: "3000",
      due_date: "2026-10-23",
    }),
    item({ label: "Concluída", status: "done" }),
    item({ label: "Moeda diferente", currency: "USD" }),
    item({ label: "Sem valor", planned_cents: null }),
  ],
  income_cents: "250000",
  expense_cents: "80000",
  unresolved: 3,
  budgets: [],
};
test("local answers preserve partial payments, currency boundaries and unknown amounts", () => {
  const result = localHelp("Quais contas faltam pagar?", context);
  assert.match(result.text, /2 compromissos/);
  assert.match(result.text, /70,00/);
  assert.match(result.text, /valor a definir/);
  assert.doesNotMatch(result.text, /Concluída|Moeda diferente/);
  assert.match(result.coverage, /3 movimentos/);
  assert.match(
    localHelp("Quais contas vencem esta semana?", context).text,
    /Internet/,
  );
  assert.doesNotMatch(
    localHelp("Quais contas estão atrasadas?", context).text,
    /Internet/,
  );
  assert.match(
    localHelp("Quanto sobra no planejamento?", context).text,
    /total ainda é parcial/,
  );
});
test("external payload contains only aggregates, uses stateless responses and cannot request tools", () => {
  const payload = externalPayload(
    "Explique os totais",
    context,
    "modelo-configurado",
  );
  assert.equal(payload.store, false);
  assert.equal(payload.max_output_tokens, 800);
  assert.equal("tools" in payload, false);
  assert.doesNotMatch(
    payload.input,
    /Internet|Conta fictícia|source_line_id|category_id|notes|userId/,
  );
  assert.match(payload.input, /unknown_planned_values/);
});
test("investment reads isolate families and never invent a balance without an opening position", async () => {
  const db = await openDatabase();
  try {
    const users: Identity[] = [];
    for (const suffix of ["one", "two"]) {
      const id = await createFamily(db, {
        name: "Pessoa fictícia",
        familyName: "Casa fictícia",
        email: suffix + "@example.invalid",
        password: "senha-sintetica-segura",
      });
      const family = (
        await db.query<{ household_id: string }>(
          "SELECT household_id FROM members WHERE user_id=$1",
          [id],
        )
      ).rows[0].household_id;
      users.push({
        userId: id,
        familyId: family,
        name: "Pessoa fictícia",
        email: suffix + "@example.invalid",
        role: "owner",
      });
    }
    for (const [i, u] of users.entries())
      await asUser(db, u.userId, (tx) =>
        tx.query(
          "INSERT INTO accounts(id,household_id,name,institution,currency,kind,opening_cents,opening_date,created_by) VALUES($1,$2,$3,'Fictícia','BRL','investment',$4,$5,$6)",
          [
            randomUUID(),
            u.familyId,
            "Reserva " + i,
            i ? "999999" : null,
            i ? "2026-10-01" : null,
            u.userId,
          ],
        ),
      );
    let result = await readInvestments(db, users[0], "2026-10");
    assert.equal(result.positions.length, 1);
    assert.equal(result.positions[0].calculated_cents, null);
    assert.equal(result.positions[0].name, "Reserva 0");
    result = await readInvestments(db, users[1], "2026-09");
    assert.equal(result.positions[0].calculated_cents, null);
    result = await readInvestments(db, users[1], "2026-10");
    assert.equal(result.positions[0].calculated_cents, "999999");
    const before = (await db.query("SELECT 1 FROM economic_events")).rows
      .length;
    const env = {
      provider: process.env.AI_PROVIDER,
      key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL,
    };
    const original = globalThis.fetch;
    let calls = 0;
    try {
      delete process.env.AI_PROVIDER;
      assert.equal(helpStatus().externalReady, false);
      await assert.rejects(
        askHelp(db, users[0], {
          question: "Explique o mês",
          month: "2026-10",
          currency: "BRL",
          external: true,
        }),
      );
      process.env.AI_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "chave-ficticia-nao-real";
      process.env.OPENAI_MODEL = "modelo-ficticio";
      globalThis.fetch = async () => {
        calls++;
        return Response.json({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Resposta de teste" }],
            },
          ],
        });
      };
      assert.equal(
        (
          await askHelp(db, users[0], {
            question: "Quais contas faltam pagar?",
            month: "2026-10",
            currency: "BRL",
          })
        ).mode,
        "local",
      );
      assert.equal(calls, 0);
      assert.equal(
        (
          await askHelp(db, users[0], {
            question: "Explique os totais",
            month: "2026-10",
            currency: "BRL",
            external: true,
          })
        ).mode,
        "external",
      );
      assert.equal(calls, 1);
      await db.query(
        "INSERT INTO audit_events(id,household_id,actor_id,action,entity_id) SELECT gen_random_uuid(),$1,$2,'help.external',gen_random_uuid() FROM generate_series(1,19)",
        [users[0].familyId, users[0].userId],
      );
      await assert.rejects(
        askHelp(db, users[0], {
          question: "Explique novamente",
          month: "2026-10",
          currency: "BRL",
          external: true,
        }),
        /limite/,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = original;
      for (const [key, value] of Object.entries({
        AI_PROVIDER: env.provider,
        OPENAI_API_KEY: env.key,
        OPENAI_MODEL: env.model,
      }))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    assert.equal(
      (await db.query("SELECT 1 FROM economic_events")).rows.length,
      before,
    );
  } finally {
    await db.close();
  }
});
