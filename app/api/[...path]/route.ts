import {
  readPreferences,
  savePreferences,
  readProfilePhoto,
  completeOnboarding,
} from "../../../src/server/preferences.ts";
import { allowedMethods, logSecurity } from "../../../src/server/api-policy.ts";
import {
  isAdministrator,
  listFamilies,
  registerFamily,
  AdministrationError,
} from "../../../src/server/administration.ts";
import {
  limitClient,
  limitUser,
  consumeLimit,
  RateLimitError,
  cleanSecurityState,
} from "../../../src/server/rate-limit.ts";
import { saveManualCard } from "../../../src/server/manual-cards.ts";
import { saveCardCycle } from "../../../src/server/card-cycle.ts";
import { readCards } from "../../../src/server/cards.ts";
import {
  analyzeBanks,
  configureIncome,
} from "../../../src/server/bank-analysis.ts";
import {
  renewBank,
  readBanks,
  saveBankCredentials,
  connectBank,
  mapBankAccount,
  pauseBank,
  syncBank,
  syncOwnBanks,
  reviewBankTransaction,
} from "../../../src/server/banks.ts";
import { createManualEvent } from "../../../src/server/manual.ts";
import { resolveAction } from "../../../src/server/chat-actions.ts";
import {
  createConversation,
  listConversations,
  openConversation,
  sendChat,
} from "../../../src/server/chat-history.ts";
import { deployment, validSecret } from "../../../src/server/deployment.ts";
import { readInvestments } from "../../../src/server/future.ts";
import { askHelp, helpStatus } from "../../../src/server/help.ts";
import {
  readRoutine,
  saveItem,
  checkItem,
  copyMonth,
} from "../../../src/server/routine.ts";
import {
  testPush,
  pushStatus,
  subscribePush,
  unsubscribePush,
  sendDueReminders,
} from "../../../src/server/notifications.ts";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import {
  applyPlanning,
  prefillAndRecord,
  prepareOpenings,
} from "../../../src/server/assisted.ts";
import { z } from "zod";
import { getDb, asUser, recordAudit } from "../../../src/server/db.ts";
import {
  createFamily,
  hashPassword,
  identity,
  issueSession,
  login,
  digest,
  verifyPassword,
  AuthError,
} from "../../../src/server/auth.ts";
import {
  accountFor,
  extractPreview,
  stagePreview,
  saveReview,
  remapPreview,
  confirmBatch,
  reviewSchema,
  UserError,
  refreshReconciliations,
} from "../../../src/server/imports.ts";
import { readState } from "../../../src/server/state.ts";
import { repairPendingFx } from "../../../src/server/pending.ts";
import {
  assertLocal,
  assertCronHost,
  bodyJson,
  csvCell,
  json,
  limitedBody,
  HttpError,
} from "../../../src/server/http.ts";
import { cents, dateOnly } from "../../../src/domain/finance.ts";
import { plainMoney, brDate } from "../../../src/domain/format.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ path: string[] }> };
const text = z.string().trim().min(1).max(120);
const currency = z.enum(["BRL", "USD", "EUR"]);
const authSchema = z
  .object({
    email: z.email().max(200),
    password: z.string().min(12).max(128),
  })
  .strict();
const setupSchema = authSchema.extend({
  name: text,
  familyName: text,
  setupToken: z.string().max(512).optional(),
});
function setSession(response: NextResponse, token: string) {
  response.cookies.set("family_session", token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60,
    secure: deployment().remote,
  });
  return response;
}
async function handle(request: Request, context: Context) {
  const requestId = randomUUID();
  const response = await handleRequest(request, context, requestId);
  response.headers.set("X-Request-Id", requestId);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
async function handleRequest(
  request: Request,
  context: Context,
  requestId: string,
) {
  try {
    const mutating = request.method !== "GET";
    const segments = (await context.params).path;
    const route = segments.join("/");
    if (route === "cron/reminders" && request.method === "GET") {
      if (
        !validSecret(
          request.headers.get("authorization")?.replace(/^Bearer /, ""),
          process.env.CRON_SECRET,
        )
      )
        return json({ error: "Acesso recusado." }, 403);
      assertCronHost(request);
      const cronDb = await getDb();
      await cleanSecurityState(cronDb);
      return json(await sendDueReminders(cronDb));
    }
    assertLocal(request, mutating);
    const methods = allowedMethods(route);
    if (!methods.length)
      return json({ error: "Operação não encontrada." }, 404);
    if (!methods.includes(request.method)) {
      const response = json({ error: "Método não permitido." }, 405);
      response.headers.set("Allow", methods.join(", "));
      return response;
    }
    const db = await getDb();
    await limitClient(db, request, route);
    const token = (await cookies()).get("family_session")?.value;
    const user = await identity(db, token);
    if (route === "auth/status" && request.method === "GET") {
      const configured =
        (await db.query("SELECT 1 FROM users LIMIT 1")).rows.length > 0;
      return json({
        configured,
        user: user
          ? { ...user, administrator: await isAdministrator(db, user.userId) }
          : null,
        hosted: deployment().remote,
      });
    }
    if (route === "auth/setup" && mutating) {
      const body = await bodyJson(request, 4096);
      if (
        deployment().remote &&
        !validSecret(
          (body as Record<string, unknown>)?.setupToken,
          process.env.SETUP_TOKEN,
        )
      )
        return json({ error: "Código de configuração inválido." }, 403);
      const input = setupSchema.parse(body);
      const id = await createFamily(db, input, true);
      return setSession(json({ ok: true }), await issueSession(db, id));
    }
    if (route === "auth/login" && mutating) {
      const input = authSchema.parse(await bodyJson(request, 4096));
      await consumeLimit(
        db,
        "auth-account",
        input.email.toLowerCase(),
        10,
        900,
      );
      try {
        const response = setSession(
          json({ ok: true }),
          await login(db, input.email, input.password),
        );
        logSecurity("login_ok", requestId, 200);
        return response;
      } catch (error) {
        logSecurity("login_failed", requestId, 401);
        return json(
          {
            error:
              error instanceof AuthError
                ? error.message
                : "Acesso recusado. Tente novamente.",
          },
          401,
        );
      }
    }
    if (route === "auth/logout" && mutating) {
      if (token)
        await db.query("DELETE FROM sessions WHERE token_hash=$1", [
          digest(token),
        ]);
      const response = json({ ok: true });
      response.cookies.set("family_session", "", {
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
        secure: deployment().remote,
      });
      return response;
    }
    if (!user)
      return json({ error: "Entre na sua conta para continuar." }, 401);
    await limitUser(db, user, route, request.method);
    if (route === "admin/families" && request.method === "GET")
      return json({ families: await listFamilies(db, user) });
    if (route === "admin/families" && request.method === "POST")
      return json(
        await registerFamily(db, user, await bodyJson(request, 8192)),
      );
    if (route === "profile/preferences" && request.method === "GET")
      return json(await readPreferences(db, user));
    if (route === "profile/preferences" && request.method === "POST")
      return json(await savePreferences(db, user, await bodyJson(request)));
    if (route === "profile/onboarding" && request.method === "POST") {
      z.object({})
        .strict()
        .parse(await bodyJson(request));
      return json(await completeOnboarding(db, user));
    }
    if (route === "profile/photo" && request.method === "GET") {
      const photo = await readProfilePhoto(db, user);
      return new Response(photo ? new Uint8Array(photo) : null, {
        status: photo ? 200 : 404,
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'",
        },
      });
    }
    if (route === "auth/password" && mutating) {
      const input = z
        .object({
          current: z.string().min(12).max(128),
          password: z.string().min(12).max(128),
        })
        .strict()
        .parse(await bodyJson(request));
      const current = (
        await db.query<{ password_hash: string }>(
          "SELECT password_hash FROM users WHERE id=$1",
          [user.userId],
        )
      ).rows[0];
      if (
        !current ||
        !(await verifyPassword(input.current, current.password_hash))
      )
        throw new UserError("Senha atual inválida.");
      const hash = await hashPassword(input.password);
      await db.transaction(async (tx) => {
        await tx.query("UPDATE users SET password_hash=$1 WHERE id=$2", [
          hash,
          user.userId,
        ]);
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.userId]);
      });
      return setSession(
        json({ ok: true }),
        await issueSession(db, user.userId),
      );
    }
    if (route === "help" && request.method === "POST")
      return json(await askHelp(db, user, await bodyJson(request)));
    if (route === "help/status" && request.method === "GET")
      return json(helpStatus());
    if (route === "help/conversations" && request.method === "GET")
      return json(
        await listConversations(
          db,
          user,
          Number(new URL(request.url).searchParams.get("offset") || 0),
        ),
      );
    if (route === "help/conversations" && request.method === "POST")
      return json(await createConversation(db, user, await bodyJson(request)));
    if (route === "help/conversations/open" && request.method === "POST")
      return json(await openConversation(db, user, await bodyJson(request)));
    if (route === "help/conversations/send" && request.method === "POST")
      return json(await sendChat(db, user, await bodyJson(request)));
    if (mutating && user.role === "reader")
      return json({ error: "Seu acesso é somente para leitura." }, 403);
    const url = new URL(request.url);
    if (route === "banks" && request.method === "GET")
      return json(
        await readBanks(
          db,
          user,
          Number(url.searchParams.get("offset") || 0),
          url.searchParams.get("group") || "",
          url.searchParams.get("account") || "",
        ),
      );
    if (route === "cards/manual" && request.method === "POST")
      return json(await saveManualCard(db, user, await bodyJson(request)));
    if (route === "cards/cycle" && request.method === "POST")
      return json(await saveCardCycle(db, user, await bodyJson(request)));
    if (route === "banks/analyze" && request.method === "POST")
      return json(await analyzeBanks(db, user));
    if (route === "income/rule" && request.method === "POST")
      return json(await configureIncome(db, user, await bodyJson(request)));
    if (route === "banks/credentials" && request.method === "POST")
      return json(await saveBankCredentials(db, user, await bodyJson(request)));
    if (route === "banks/connect" && request.method === "POST")
      return json(await connectBank(db, user, await bodyJson(request)));
    if (route === "banks/renew" && request.method === "POST")
      return json(await renewBank(db, user, await bodyJson(request)));
    if (route === "banks/map" && request.method === "POST")
      return json(await mapBankAccount(db, user, await bodyJson(request)));
    if (route === "banks/pause" && request.method === "POST")
      return json(await pauseBank(db, user, await bodyJson(request)));
    if (route === "banks/read" && request.method === "POST")
      return json(await syncBank(db, user, await bodyJson(request)));
    if (route === "banks/read-due" && request.method === "POST")
      return json(await syncOwnBanks(db, user));
    if (route === "banks/review" && request.method === "POST")
      return json(
        await reviewBankTransaction(db, user, await bodyJson(request)),
      );
    if (route === "help/actions" && request.method === "POST")
      return json(await resolveAction(db, user, await bodyJson(request)));
    if (route === "investments" && request.method === "GET")
      return json(
        await readInvestments(
          db,
          user,
          z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .parse(url.searchParams.get("month")),
        ),
      );
    if (route === "family/month" && request.method === "GET") {
      const month = z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .parse(url.searchParams.get("month"));
      const curr = currency.parse(url.searchParams.get("currency") || "BRL");
      dateOnly(month + "-01");
      const [state, routine, cards] = await Promise.all([
        readState(db, user, month + "-01", curr, undefined, undefined, false),
        readRoutine(db, user, month),
        readCards(db, user, month),
      ]);
      return json({ state, routine, cards });
    }
    if (route === "routine" && request.method === "GET")
      return json(
        await readRoutine(
          db,
          user,
          z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .parse(url.searchParams.get("month")),
        ),
      );
    if (route === "routine/item" && request.method === "POST")
      return json(await saveItem(db, user, await bodyJson(request)));
    if (route === "routine/check" && request.method === "POST")
      return json(await checkItem(db, user, await bodyJson(request)));
    if (route === "routine/copy" && request.method === "POST")
      return json(await copyMonth(db, user, await bodyJson(request)));
    if (route === "notifications" && request.method === "GET")
      return json(await pushStatus(db, user));
    if (route === "notifications/subscribe" && request.method === "POST")
      return json(await subscribePush(db, user, await bodyJson(request)));
    if (route === "notifications/test" && request.method === "POST")
      return json(await testPush(db, user, await bodyJson(request)));
    if (route === "notifications/unsubscribe" && request.method === "POST")
      return json(await unsubscribePush(db, user, await bodyJson(request)));
    if (route === "accounts/prepare-openings" && request.method === "POST") {
      await bodyJson(request);
      return json(await prepareOpenings(db, user));
    }
    if (route === "planning/import" && request.method === "POST") {
      const form = await limitedBody(request, 10 * 1024 * 1024 + 100000).then(
        (bytes) =>
          new Response(new Uint8Array(bytes), {
            headers: { "Content-Type": request.headers.get("content-type")! },
          }).formData(),
      );
      const file = form.get("file");
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx"))
        throw new UserError("Selecione sua planilha XLSX.");
      const preview = await extractPreview(file, "BRL");
      const planning = (preview.reference as { planning?: unknown })?.planning;
      return json(
        await applyPlanning(
          db,
          user,
          planning,
          createHash("sha256")
            .update(Buffer.from(await file.arrayBuffer()))
            .digest("hex"),
          file.name,
        ),
      );
    }
    if (route === "pending/assisted" && request.method === "POST") {
      const input = z
        .object({ record: z.boolean() })
        .strict()
        .parse(await bodyJson(request));
      await repairPendingFx(db, user);
      return json(await prefillAndRecord(db, user, input.record));
    }
    if (route === "pending/prepare" && request.method === "POST")
      return json(await repairPendingFx(db, user));
    if (route === "state" && request.method === "GET") {
      const month =
        z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .parse(url.searchParams.get("month")) + "-01";
      dateOnly(month);
      const curr = currency.parse(url.searchParams.get("currency") || "BRL");
      const account = url.searchParams.get("account")
        ? z.uuid().parse(url.searchParams.get("account"))
        : undefined;
      const category = url.searchParams.get("category")
        ? z.uuid().parse(url.searchParams.get("category"))
        : undefined;
      return json(await readState(db, user, month, curr, account, category));
    }
    if (route === "accounts" && mutating) {
      const input = z
        .object({
          name: text,
          institution: text,
          currency,
          kind: z.enum(["checking", "card", "investment", "benefit"]),
          opening: z.string().max(30).optional(),
          opening_date: z.string().optional(),
        })
        .strict()
        .parse(await bodyJson(request));
      const amount = input.opening?.trim()
        ? cents(input.opening).toString()
        : null;
      const day = input.opening_date ? dateOnly(input.opening_date) : null;
      if ((amount === null) !== (day === null))
        throw new UserError(
          "Informe juntos o saldo e sua data de referência, ou deixe ambos vazios.",
        );
      const id = randomUUID();
      await asUser(db, user.userId, async (tx) => {
        await tx.query(
          "INSERT INTO accounts(id,household_id,name,institution,currency,kind,opening_cents,opening_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            user.familyId,
            input.name,
            input.institution,
            input.currency,
            input.kind,
            amount,
            day,
            user.userId,
          ],
        );
        await recordAudit(tx, user.familyId, user.userId, "account.create", id);
      });
      return json({ id });
    }
    if (route === "accounts/opening" && mutating) {
      const input = z
        .object({ id: z.uuid(), opening: z.string(), date: z.string() })
        .strict()
        .parse(await bodyJson(request));
      const amount = cents(input.opening).toString(),
        day = dateOnly(input.date);
      await asUser(db, user.userId, async (tx) => {
        const account = await accountFor(tx, user.familyId, input.id);
        if (account.opening_cents !== null)
          throw new UserError(
            "A abertura já está registrada. Alteração exige conciliação específica e não é automática.",
          );
        const earlier = await tx.query(
          "SELECT 1 FROM ledger_entries l JOIN economic_events e ON e.id=l.event_id WHERE l.account_id=$1 AND e.transaction_date<=$2 LIMIT 1",
          [input.id, day],
        );
        if (earlier.rows.length)
          throw new UserError(
            "A abertura deve ser anterior a todos os movimentos já confirmados.",
          );
        await tx.query(
          "UPDATE accounts SET opening_cents=$1,opening_date=$2 WHERE id=$3",
          [amount, day, input.id],
        );
        await recordAudit(
          tx,
          user.familyId,
          user.userId,
          "account.opening",
          input.id,
        );
        await refreshReconciliations(tx, user.familyId);
      });
      return json({ ok: true });
    }
    if (route === "categories" && mutating) {
      const input = z
        .object({
          id: z.uuid().optional(),
          name: text,
          essential: z.boolean().default(false),
        })
        .strict()
        .parse(await bodyJson(request));
      const id = input.id || randomUUID();
      await asUser(db, user.userId, async (tx) => {
        if (input.id) {
          const result = await tx.query(
            "UPDATE categories SET name=$1,essential=$2 WHERE id=$3 AND household_id=$4 RETURNING id",
            [input.name, input.essential, id, user.familyId],
          );
          if (!result.rows.length)
            throw new UserError("Categoria indisponível.");
        } else
          await tx.query(
            "INSERT INTO categories(id,household_id,name,essential) VALUES($1,$2,$3,$4)",
            [id, user.familyId, input.name, input.essential],
          );
        await recordAudit(tx, user.familyId, user.userId, "category.save", id);
      });
      return json({ id });
    }
    if (route === "budgets" && mutating) {
      const input = z
        .object({
          category_id: z.uuid(),
          month: z.string().regex(/^\d{4}-\d{2}$/),
          currency,
          planned: z.string(),
        })
        .strict()
        .parse(await bodyJson(request));
      const amount = cents(input.planned);
      if (amount < 0n) throw new UserError("Orçamento não pode ser negativo.");
      await asUser(db, user.userId, async (tx) => {
        await tx.query(
          "INSERT INTO budgets(household_id,category_id,month,currency,planned_cents) VALUES($1,$2,$3,$4,$5) ON CONFLICT(household_id,category_id,month,currency) DO UPDATE SET planned_cents=EXCLUDED.planned_cents",
          [
            user.familyId,
            input.category_id,
            dateOnly(input.month + "-01"),
            input.currency,
            amount.toString(),
          ],
        );
        await recordAudit(
          tx,
          user.familyId,
          user.userId,
          "budget.save",
          input.category_id,
          { month: input.month },
        );
      });
      return json({ ok: true });
    }
    if (route === "events" && mutating)
      return json({
        id: await createManualEvent(db, user, await bodyJson(request)),
      });
    if (route === "members" && request.method === "GET") {
      const members = (
        await db.query(
          "SELECT u.name,u.email,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.household_id=$1",
          [user.familyId],
        )
      ).rows;
      return json({ members });
    }
    if (route === "members" && mutating) {
      if (user.role !== "owner")
        return json(
          { error: "Somente o proprietário pode adicionar a segunda pessoa." },
          403,
        );
      const input = authSchema
        .extend({ name: text, role: z.enum(["editor", "reader"]) })
        .parse(await bodyJson(request));
      const hash = await hashPassword(input.password);
      await db.transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          user.familyId + "members",
        ]);
        const owner = await tx.query(
          "SELECT 1 FROM members WHERE user_id=$1 AND household_id=$2 AND role='owner'",
          [user.userId, user.familyId],
        );
        if (!owner.rows.length) throw new UserError("Permissão insuficiente.");
        const count = (
          await tx.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM members WHERE household_id=$1",
            [user.familyId],
          )
        ).rows[0].count;
        if (count >= 2)
          throw new UserError(
            "Esta versão local permite duas pessoas por família.",
          );
        const id = randomUUID();
        await tx.query(
          "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
          [id, input.email.toLowerCase(), input.name, hash],
        );
        await tx.query(
          "INSERT INTO members(household_id,user_id,role) VALUES($1,$2,$3)",
          [user.familyId, id, input.role],
        );
      });
      return json({ ok: true });
    }
    if (route === "imports/preview" && mutating) {
      const bytes = await limitedBody(request, 11 * 1024 * 1024);
      const form = await new Response(bytes as BodyInit, {
        headers: { "content-type": request.headers.get("content-type") || "" },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new UserError("Selecione um arquivo.");
      const accountId = z.uuid().parse(form.get("account_id"));
      const account = await asUser(db, user.userId, (tx) =>
        accountFor(tx, user.familyId, accountId),
      );
      const preview = await extractPreview(file, account.currency);
      return json(
        await stagePreview(
          db,
          user,
          accountId,
          { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
          preview,
        ),
      );
    }
    if (segments[0] === "imports" && segments.length >= 2) {
      const id = z.uuid().parse(segments[1]);
      if (segments.length === 2 && request.method === "GET") {
        return json(
          await asUser(db, user.userId, async (tx) => {
            const batch = (
              await tx.query<Record<string, unknown> & { account_id: string }>(
                "SELECT b.*,b.period_start::text,b.period_end::text,f.filename FROM import_batches b JOIN source_files f ON f.id=b.source_id WHERE b.id=$1 AND b.household_id=$2",
                [id, user.familyId],
              )
            ).rows[0];
            if (!batch) throw new UserError("Importação indisponível.");
            const rows = (
              await tx.query(
                "SELECT s.*,EXISTS(SELECT 1 FROM event_sources es WHERE es.staged_id=s.id) AS recorded,s.transaction_date::text,s.processing_date::text,s.due_date::text,s.amount_cents::text,s.counter_amount_cents::text,coalesce((SELECT json_agg(json_build_object('id',e.id,'description',e.description,'date',e.transaction_date::text)) FROM economic_events e JOIN ledger_entries l ON l.event_id=e.id WHERE e.household_id=s.household_id AND e.kind IN ('transfer','card_payment','investment_buy','investment_sell','fx') AND l.account_id=$3 AND l.amount_cents=s.amount_cents AND l.currency=s.currency AND abs(e.transaction_date-s.transaction_date)<=3),'[]') AS link_candidates FROM staged_transactions s WHERE s.batch_id=$1 AND s.household_id=$2 ORDER BY s.ordinal",
                [id, user.familyId, batch.account_id],
              )
            ).rows;
            return { batch, rows };
          }),
        );
      }
      if (segments[2] === "review" && mutating) {
        const input = z
          .object({ rows: z.array(reviewSchema).min(1).max(500) })
          .strict()
          .parse(await bodyJson(request));
        await saveReview(db, user, id, input.rows);
        return json({ ok: true });
      }
      if (segments[2] === "account" && mutating) {
        const input = z
          .object({ account_id: z.uuid() })
          .strict()
          .parse(await bodyJson(request));
        await remapPreview(db, user, id, input.account_id);
        return json({ ok: true });
      }
      if (segments[2] === "confirm" && mutating) {
        await bodyJson(request);
        return json(await confirmBatch(db, user, id));
      }
    }
    if (route === "export" && request.method === "GET") {
      const data = await asUser(db, user.userId, (tx) =>
        tx.query<Record<string, string>>(
          "SELECT transaction_date::text,description,amount_cents::text,currency,kind,id FROM economic_events WHERE household_id=$1 ORDER BY transaction_date",
          [user.familyId],
        ),
      );
      const headings = ["data", "descricao", "valor", "moeda", "tipo", "id"];
      const csv =
        "\ufeff" +
        [
          headings.map(csvCell).join(";"),
          ...data.rows.map((r) =>
            [
              csvCell(brDate(r.transaction_date)),
              csvCell(r.description),
              '"' + plainMoney(r.amount_cents) + '"',
              csvCell(r.currency),
              csvCell(r.kind),
              csvCell(r.id),
            ].join(";"),
          ),
        ].join("\r\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="transacoes.csv"',
          "Cache-Control": "no-store",
        },
      });
    }
    if (route === "export/family" && request.method === "GET") {
      if (user.role !== "owner")
        return json(
          { error: "Exportação completa restrita ao proprietário." },
          403,
        );
      const tables = [
        "accounts",
        "categories",
        "source_files",
        "import_batches",
        "staged_transactions",
        "economic_events",
        "ledger_entries",
        "event_sources",
        "budgets",
        "audit_events",
        "planning_sources",
        "planning_lines",
        "monthly_items",
        "merchant_rules",
        "operation_keys",
        "bank_connections",
        "bank_accounts",
        "bank_transactions",
        "bank_card_bills",
        "card_cycles",
        "manual_card_settings",
        "manual_card_bills",
      ];
      const data = await asUser(db, user.userId, async (tx) => {
        const result: Record<string, unknown> = {
          schema_version: 14,
          household_id: user.familyId,
        };
        for (const table of tables)
          result[table] = (
            await tx.query(`SELECT * FROM ${table} WHERE household_id=$1`, [
              user.familyId,
            ])
          ).rows;
        return result;
      });
      const response = json(data);
      response.headers.set(
        "Content-Disposition",
        'attachment; filename="dados-familia.json"',
      );
      return response;
    }
    return json({ error: "Operação não encontrada." }, 404);
  } catch (error) {
    if (error instanceof AdministrationError)
      return json({ error: error.message }, 403);
    if (error instanceof RateLimitError) {
      logSecurity("rate_limited", requestId, 429);
      const response = json({ error: error.message }, 429);
      response.headers.set("Retry-After", String(error.retryAfter));
      return response;
    }
    if (error instanceof HttpError) {
      logSecurity("input_rejected", requestId, error.status);
      return json({ error: error.message }, error.status);
    }
    if (error instanceof UserError) {
      logSecurity("input_rejected", requestId, 400);
      return json({ error: error.message }, 400);
    }
    if (error instanceof z.ZodError) {
      logSecurity("input_rejected", requestId, 400);
      return json(
        { error: "Dados inválidos. Confira os campos e tente novamente." },
        400,
      );
    }
    // Não registrar objetos de erro: drivers podem incluir SQL e dados privados.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "INTERNAL";
    console.error(
      "finance_api_failure",
      /^[A-Z0-9_]{1,32}$/.test(code) ? code : "INTERNAL",
    );
    return json(
      {
        error:
          "Não foi possível concluir. Confira os campos, vínculos e permissões. Nenhuma alteração parcial foi confirmada.",
      },
      400,
    );
  }
}
export const GET = handle;
export const POST = handle;
