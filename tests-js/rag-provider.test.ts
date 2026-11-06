import { test } from "node:test";
import assert from "node:assert/strict";
import { retrieveFacts } from "../src/domain/retrieval.ts";
import type { HelpContext } from "../src/domain/help.ts";
import { llmConfig, requestLlm } from "../src/server/llm.ts";
const context: HelpContext = {
  month: "2026-10",
  currency: "BRL",
  today: "2026-10-22",
  items: [],
  income_cents: "123456",
  expense_cents: "5555",
  unresolved: 2,
  budgets: [
    {
      category_name: "Supermercado",
      planned_cents: "10000",
      spent_cents: "3000",
      remaining_cents: "7000",
    },
  ],
  investmentMovements: [
    { kind: "investment_buy", currency: "USD", amount_cents: "999" },
    { kind: "investment_buy", currency: "BRL", amount_cents: "5000" },
  ],
};
test("structured RAG selects only question-relevant facts, with explicit period, currency and sources", () => {
  const food = retrieveFacts("Quanto ainda cabe em alimentação?", context);
  assert.deepEqual(
    food.facts.map((f) => f.id),
    ["A1"],
  );
  assert.equal(food.facts[0].data.remaining_cents, "7000");
  assert.equal(food.period, "2026-10");
  assert.equal(food.currency, "BRL");
  assert.equal(food.unresolved_movements, 2);
  assert.doesNotMatch(JSON.stringify(food), /123456|999|Supermercado/);
  const investments = retrieveFacts("Como estão os investimentos?", context);
  assert.deepEqual(
    investments.facts.map((f) => f.id),
    ["I1"],
  );
  assert.doesNotMatch(JSON.stringify(investments), /999|USD/);
  assert.deepEqual(
    retrieveFacts("Explique o planejamento", context).facts.map((f) => f.id),
    ["P1", "H1"],
  );
  const missing = retrieveFacts("alimentação", { ...context, budgets: [] });
  assert.equal(missing.facts[0].data.available, false);
});
test("Groq is disabled without key and confirmed ZDR; fixed endpoint and no paid-provider failover", async () => {
  const keys = [
    "AI_PROVIDER",
    "GROQ_API_KEY",
    "GROQ_MODEL",
    "GROQ_ZDR_CONFIRMED",
  ];
  const original = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const fetchOriginal = globalThis.fetch;
  let calls = 0;
  try {
    process.env.AI_PROVIDER = "groq";
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
    delete process.env.GROQ_ZDR_CONFIRMED;
    assert.equal(llmConfig().ready, false);
    process.env.GROQ_API_KEY = "chave-ficticia";
    assert.equal(llmConfig().ready, false);
    await assert.rejects(
      requestLlm({
        model: "openai/gpt-oss-120b",
        instructions: "Teste",
        input: "Teste fictício",
      }),
    );
    process.env.GROQ_ZDR_CONFIRMED = "true";
    assert.equal(llmConfig().ready, true);
    assert.equal(llmConfig().provider, "Groq");
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(options?.redirect, "error");
      const body = JSON.parse(String(options?.body));
      assert.equal(body.include_reasoning, false);
      assert.equal(body.max_completion_tokens, 1200);
      assert.equal("tools" in body, false);
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Resposta fictícia [P1]",
              reasoning: "Não exibir",
            },
          },
        ],
      });
    };
    assert.equal(
      await requestLlm({
        model: llmConfig().model,
        instructions: "Teste",
        input: "Dados fictícios",
      }),
      "Resposta fictícia [P1]",
    );
    assert.equal(calls, 1);
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 429 });
    };
    await assert.rejects(
      requestLlm({
        model: llmConfig().model,
        instructions: "Teste",
        input: "Teste",
      }),
      /PROVIDER_RATE_LIMIT/,
    );
    assert.equal(calls, 2);
    globalThis.fetch = async () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: "Resposta incompleta" },
          },
        ],
      });
    await assert.rejects(
      requestLlm({
        model: llmConfig().model,
        instructions: "Teste",
        input: "Teste",
      }),
      /Incomplete/,
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  }
});
