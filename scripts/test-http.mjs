import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";

await mkdir("work", { recursive: true });
const directory = await mkdtemp(path.resolve("work/http-test-"));
const base = "http://127.0.0.1:3212";
const server = spawn(process.execPath, ["scripts/serve.mjs", "start"], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    FINANCE_TEST_MODE: "1",
    DATABASE_URL: "",
    MIGRATION_DATABASE_URL: "",
    APP_ORIGIN: "",
    SETUP_TOKEN: "",
    PARSER_TOKEN: "",
    CRON_SECRET: "",
    AI_PROVIDER: "",
    OPENAI_API_KEY: "",
    GROQ_API_KEY: "",
    PORT: "3212",
    FINANCE_DATA_DIR: directory,
    BANK_CONNECTIONS_KEY: "",
  },
});
server.stdout.resume();
server.stderr.resume();
let cookie = "";
async function call(route, body, extra = {}) {
  const headers = {
    ...(cookie ? { cookie } : {}),
    ...(body === undefined ? {} : { origin: base }),
    ...(body instanceof FormData
      ? {}
      : body === undefined
        ? {}
        : { "content-type": "application/json" }),
    ...extra,
  };
  const response = await fetch(base + "/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const set = response.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = await response.json();
  return { status: response.status, data };
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const r = await fetch(base + "/api/auth/status");
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, "Servidor de teste não iniciou");
  const publicPage = await fetch(base);
  const csp = publicPage.headers.get("content-security-policy");
  assert.ok(
    csp &&
      !csp
        .split(";")
        .find((v) => v.includes("script-src"))
        .includes("unsafe-inline"),
  );
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  const publicHtml = await publicPage.text();
  assert.ok(publicHtml.includes('nonce="' + nonce + '"'));
  assert.notEqual(
    (await fetch(base)).headers.get("content-security-policy"),
    csp,
  );
  assert.equal((await call("auth/login")).status, 405);
  assert.equal(
    (
      await call(
        "imports/00000000-0000-4000-8000-000000000001/confirm/extra",
        {},
      )
    ).status,
    404,
  );
  const invalidType = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { origin: base, "content-type": "application/json.evil" },
    body: "{}",
  });
  assert.equal(invalidType.status, 415);
  assert.equal((await call("state?month=2026-01")).status, 401);
  assert.equal((await call("investments?month=2026-01")).status, 401);
  assert.equal((await call("help/status")).status, 401);
  assert.equal((await call("help/conversations")).status, 401);
  assert.equal((await call("profile/preferences")).status, 401);
  assert.equal(
    (await call("profile/preferences", { revision: 0 })).status,
    401,
  );
  assert.equal((await call("banks")).status, 401);
  assert.equal((await call("banks/read-due", {})).status, 401);
  const missingAction = {
    id: "00000000-0000-4000-8000-000000000001",
    decision: "confirm",
  };
  assert.equal((await call("help/actions", missingAction)).status, 401);
  assert.equal(
    (
      await call("help", {
        question: "Contas a pagar",
        month: "2026-01",
        currency: "BRL",
      })
    ).status,
    401,
  );
  const noOrigin = await fetch(base + "/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(noOrigin.status, 400);
  const setup = await call("auth/setup", {
    email: "qa@example.invalid",
    name: "Pessoa fictícia QA",
    familyName: "Família de teste",
    password: "SenhaFicticia!2026",
  });
  assert.equal(setup.status, 200);
  assert.ok(cookie);
  const initialProfile = await call("profile/preferences");
  assert.equal(initialProfile.data.onboarding_done, false);
  const personal = await call("profile/preferences", {
    revision: 0,
    theme: "dark",
    accent: "#a9b7d7",
    hidden_cards: ["categories"],
  });
  assert.equal(personal.status, 200);
  assert.equal(personal.data.revision, 1);
  assert.equal(
    (await call("profile/preferences", { revision: 0, theme: "light" })).status,
    400,
  );
  assert.equal(
    (
      await call(
        "profile/preferences",
        { revision: 1, theme: "light" },
        { origin: "https://invalid.example" },
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("profile/onboarding", {})).data.onboarding_done,
    true,
  );
  assert.equal(
    (await call("profile/preferences")).data.hidden_cards[0],
    "categories",
  );
  const noPhoto = await fetch(base + "/api/profile/photo", {
    headers: { cookie },
  });
  assert.equal(noPhoto.status, 404);
  assert.match(noPhoto.headers.get("cache-control"), /no-store/);
  const photoInput = await sharp({
    create: { width: 320, height: 240, channels: 3, background: "#71566f" },
  })
    .png()
    .withMetadata({ exif: { IFD0: { Artist: "synthetic-private" } } })
    .toBuffer();
  const photoPreferences = (await call("profile/preferences")).data;
  const photoSaved = await call("profile/preferences", {
    revision: photoPreferences.revision,
    photo: photoInput.toString("base64"),
  });
  assert.equal(photoSaved.status, 200);
  assert.equal(photoSaved.data.has_photo, true);
  // A fresh read, then an unrelated preference save must retain the stored photo.
  const reloadedPreferences = (await call("profile/preferences")).data;
  assert.equal(reloadedPreferences.has_photo, true);
  const themeSaved = await call("profile/preferences", {
    revision: reloadedPreferences.revision,
    theme: "light",
  });
  assert.equal(themeSaved.data.has_photo, true);
  const photoResponse = await fetch(
    base + "/api/profile/photo?v=" + themeSaved.data.revision,
    { headers: { cookie } },
  );
  assert.equal(photoResponse.status, 200);
  assert.match(photoResponse.headers.get("cache-control"), /private.*no-store/);
  const photoMetadata = await sharp(
    Buffer.from(await photoResponse.arrayBuffer()),
  ).metadata();
  assert.equal(photoMetadata.width, 256);
  assert.equal(photoMetadata.height, 256);
  assert.equal(photoMetadata.exif, undefined);
  assert.equal((await fetch(base + "/api/profile/photo")).status, 401);
  const banks = await call("banks");
  assert.equal(banks.status, 200);
  assert.equal(banks.data.storageReady, false);
  assert.deepEqual(banks.data.connections, []);
  assert.equal(
    (
      await call("banks/credentials", {
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
        consent: true,
      })
    ).status,
    400,
  );
  assert.equal((await call("banks/read-due", {})).status, 200);
  assert.equal((await call("investments?month=2026-01")).status, 200);
  const localAnswer = await call("help", {
    question: "Quais contas faltam pagar?",
    month: "2026-01",
    currency: "BRL",
  });
  assert.equal(localAnswer.status, 200);
  assert.equal(localAnswer.data.mode, "local");
  assert.equal((await call("help/status")).data.externalReady, false);
  const conversationId = randomUUID();
  assert.equal(
    (
      await call("help/conversations", {
        id: conversationId,
        month: "2026-01",
        currency: "BRL",
      })
    ).status,
    200,
  );
  const savedChat = await call("help/conversations/send", {
    id: conversationId,
    request_id: randomUUID(),
    question: "Quanto sobra neste mês?",
    external: false,
  });
  assert.equal(savedChat.status, 200);
  assert.equal(savedChat.data.messages.length, 2);
  // A separate authenticated session restores the same private conversation.
  assert.equal(
    (
      await call("auth/login", {
        email: "qa@example.invalid",
        password: "SenhaFicticia!2026",
      })
    ).status,
    200,
  );
  const restoredChat = await call("help/conversations/open", {
    id: conversationId,
  });
  assert.equal(restoredChat.status, 200);
  assert.deepEqual(restoredChat.data.messages, savedChat.data.messages);
  assert.equal(
    (await call("help/conversations")).data.conversations[0].id,
    conversationId,
  );

  const acct = await call("accounts", {
    name: "Conta fictícia",
    institution: "Banco de teste",
    currency: "BRL",
    kind: "checking",
    opening: "0,00",
    opening_date: "2025-12-31",
  });
  assert.equal(acct.status, 200);
  const csv =
    "data;descricao;valor;moeda\n02/01/2026;Salário fictício;1.000,00;BRL\n03/01/2026;Supermercado fictício;-25,00;BRL\n";
  function upload(name) {
    const form = new FormData();
    form.set("account_id", acct.data.id);
    form.set("file", new File([csv], name, { type: "text/csv" }));
    return form;
  }
  const uploaded = await call("imports/preview", upload("ficticio.csv"));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  const id = uploaded.data.id;
  let preview = (await call("imports/" + id)).data;
  assert.equal(preview.rows.length, 2);
  assert.ok(preview.batch.checks.every((c) => c.passed));
  assert.equal((await call("imports/" + id + "/confirm", {})).status, 400);
  const state = (await call("state?month=2026-01&currency=BRL")).data;
  assert.equal(state.summary.event_count, 0);
  assert.equal(state.pending.counts.rows, 2);
  const prepared = await call("pending/prepare", {});
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.confirmed, 0);
  const food = state.categories.find((c) => c.name === "Alimentação").id,
    income = state.categories.find(
      (c) => c.name === "Receitas profissionais",
    ).id;
  const rows = preview.rows.map((row) => ({
    id: row.id,
    version: row.version,
    description: row.description,
    kind: BigInt(row.amount_cents) > 0n ? "income" : "expense",
    category_id: BigInt(row.amount_cents) > 0n ? income : food,
    counter_account_id: null,
    counter_currency: null,
    counter_amount_cents: null,
    related_event_id: null,
    link_event_id: null,
    decision: "accept",
    review_note: "",
  }));
  assert.equal((await call("imports/" + id + "/review", { rows })).status, 200);
  const confirmed = await call("imports/" + id + "/confirm", {});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.created, 2);
  assert.equal(
    (await call("imports/" + id + "/confirm", {})).data.alreadyConfirmed,
    true,
  );
  const repeated = await call("imports/preview", upload("renomeado.csv"));
  assert.equal(repeated.data.id, id);
  assert.equal(repeated.data.repeated, true);
  const result = (await call("state?month=2026-01&currency=BRL")).data;
  assert.equal(result.summary.income_cents, "100000");
  assert.equal(result.summary.expense_cents, "2500");
  assert.equal(result.summary.result_cents, "97500");
  assert.equal(result.accounts[0].balance_cents, "97500");
  assert.equal(result.events.length, 2);
  const exported = await fetch(base + "/api/export", { headers: { cookie } });
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.ok(text.includes('"-25,00"'));
  assert.ok(text.includes('"data";"descricao";"valor"'));
  assert.equal(
    (
      await call("members", {
        name: "Leitor fictício",
        email: "leitor-qa@example.invalid",
        password: "SenhaFicticia!2026",
        role: "reader",
      })
    ).status,
    200,
  );
  const ownerCookie = cookie;
  assert.equal(
    (
      await call("auth/login", {
        email: "leitor-qa@example.invalid",
        password: "SenhaFicticia!2026",
      })
    ).status,
    200,
  );
  assert.equal((await call("state?month=2026-01")).status, 200);
  assert.equal((await call("accounts", { name: "Negado" })).status, 403);
  assert.equal((await call("help/conversations")).data.conversations.length, 0);
  assert.equal(
    (await call("help/conversations/open", { id: conversationId })).status,
    400,
  );

  assert.equal((await call("help/actions", missingAction)).status, 403);
  assert.equal((await call("pending/prepare", {})).status, 403);
  assert.equal((await call("pending/assisted", { record: true })).status, 403);
  assert.equal((await call("export/family")).status, 403);
  assert.equal(
    (
      await call("auth/password", {
        current: "SenhaFicticia!2026",
        password: "SenhaNovaFicticia!2026",
      })
    ).status,
    200,
  );
  assert.equal((await call("auth/logout", {})).status, 200);
  assert.equal((await call("state?month=2026-01")).status, 401);
  cookie = ownerCookie;
  assert.equal((await call("export/family")).status, 200);
  assert.equal((await fetch(base + "/data/postgres/PG_VERSION")).status, 404);
  const item = await call("routine/item", {
    month: "2026-01",
    label: "Conta planejada",
    purpose: "expense",
    currency: "BRL",
    amount: "50,00",
    due_date: "2026-01-20",
    notes: "teste",
  });
  assert.equal(item.status, 200);
  const before = (await call("family/month?month=2026-01")).data;
  assert.equal(before.routine.items.length, 1);
  assert.equal(
    (
      await call("routine/check", {
        id: item.data.id,
        version: 1,
        status: "done",
        amount: "49,00",
        date: "2026-01-19",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("routine/check", {
        id: item.data.id,
        version: 1,
        status: "open",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("state?month=2026-01")).data.events.length,
    2,
    "checking plan must not duplicate bank events",
  );
  assert.equal(
    (await call("routine/copy", { from: "2026-01", to: "2026-02" })).status,
    200,
  );
  assert.equal(
    (await call("routine?month=2026-02")).data.items[0].status,
    "open",
  );
  const body = {
    request_id: crypto.randomUUID(),
    account_id: acct.data.id,
    date: "2026-01-25",
    description: "Imprevisto fict�cio",
    amount: "-5,00",
    kind: "expense",
    category_id: result.categories[0].id,
    counter_account_id: null,
    counter_currency: null,
    counter_amount: null,
    related_event_id: null,
  };
  const one = await call("events", body),
    two = await call("events", body);
  assert.equal(one.status, 200);
  assert.equal(two.data.id, one.data.id);
  assert.equal((await call("notifications")).status, 200);
  assert.equal(
    (
      await call("notifications/subscribe", {
        endpoint: "https://127.0.0.1/",
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
      })
    ).status,
    400,
  );
  assert.equal((await call("cron/reminders")).status, 403);
  console.log(
    "Rotina familiar: planejamento, pago sem duplica��o, conflito entre aparelhos, c�pia de m�s, lan�amento idempotente e prote��o de notifica��es passaram.",
  );
  console.log(
    "HTTP: autenticação, CSRF, upload CSV, prévia, revisão, confirmação, reimportação, indicadores, exportação, leitor, troca de senha e logout passaram com dados fictícios.",
  );
  const unknownField = await call("auth/login", {
    email: "fake@example.invalid",
    password: "Fictitious!2026abc",
    admin: true,
  });
  assert.equal(unknownField.status, 400);
  let throttled = false;
  for (let i = 0; i < 11; i++) {
    const r = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        email: "throttle@example.invalid",
        password: "Fictitious!2026abc",
      }),
    });
    if (r.status === 429) {
      throttled = true;
      assert.ok(Number(r.headers.get("retry-after")) > 0);
      assert.match(r.headers.get("x-request-id"), /^[a-f0-9-]{36}$/);
    }
  }
  assert.ok(throttled, "Login deve aplicar limite persistente e Retry-After");
  console.log(
    "HTTP security: CSP nonce, strict methods/paths/inputs, 415, 429, Retry-After and correlation IDs passed.",
  );
} finally {
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else server.kill("SIGTERM");
}
