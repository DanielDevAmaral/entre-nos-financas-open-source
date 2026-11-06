import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asUser, recordAudit, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import type { MonthlyItem } from "./routine.ts";
import { saveItemTx, checkItemTx } from "./routine.ts";
import { createManualEventTx } from "./manual.ts";
import { UserError } from "./imports.ts";
import { cents, dateOnly, postings, type Currency } from "../domain/finance.ts";
import { plainMoney, formatted, brDate } from "../domain/format.ts";

const amount = z
  .string()
  .regex(/^\d{1,15}$/)
  .refine((v) => BigInt(v) > 0n);
export const chatIntent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("plan_create"),
      label: z.string().trim().min(1).max(180),
      amount_cents: amount,
      purpose: z.enum(["expense", "income", "saving", "card", "benefit"]),
      date: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("plan_edit"),
      target: z.string(),
      label: z.string().trim().min(1).max(180).optional(),
      amount_cents: amount.optional(),
      date: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("plan_status"),
      target: z.string(),
      status: z.enum(["open", "done", "partial"]),
      amount_cents: amount.nullable(),
      date: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("event_create"),
      label: z.string().trim().min(1).max(180),
      amount_cents: amount,
      account: z.string(),
      counter_account: z.string().nullable(),
      category: z.string().nullable(),
      date: z.string(),
      kind: z.enum([
        "income",
        "expense",
        "transfer",
        "card_purchase",
        "card_payment",
        "investment_buy",
        "investment_sell",
        "yield",
        "fee",
      ]),
    })
    .strict(),
]);
export type ActionView = {
  id: string;
  title: string;
  details: string[];
  status: string;
};
export type ChatCatalog = {
  items: MonthlyItem[];
  accounts: { id: string; name: string; kind: string; currency: Currency }[];
  categories: { id: string; name: string }[];
};
export function actionCatalog(c: ChatCatalog, currency: Currency) {
  return {
    items: c.items.map((i, n) => ({
      ref: `p${n}`,
      label: i.label,
      currency: i.currency,
      amount_cents: i.planned_cents,
      status: i.status,
      due_date: i.due_date,
    })),
    accounts: c.accounts.map((a, n) => ({
      ref: `a${n}`,
      name: a.name,
      kind: a.kind,
      currency: a.currency,
    })),
    categories: c.categories.map((a, n) => ({ ref: `c${n}`, name: a.name })),
    currency,
  };
}
export async function proposeAction(
  db: Database,
  user: Identity,
  raw: unknown,
  c: ChatCatalog,
  month: string,
  currency: Currency,
): Promise<ActionView> {
  if (user.role === "reader")
    throw new UserError("Seu acesso é somente para leitura.");
  const a = chatIntent.parse(raw);
  const id = randomUUID();
  const day = (value: string | null | undefined) => {
    if (!value) return null;
    const d = dateOnly(value);
    if (!d.startsWith(month + "-"))
      throw new UserError(
        "Informe o mês e a data da operação na mensagem e peça novamente.",
      );
    return d;
  };
  const ref = <T>(value: string, prefix: string, values: T[]): T => {
    if (
      !new RegExp(`^${prefix}(0|[1-9]\\d*)$`).test(value) ||
      !values[Number(value.slice(1))]
    )
      throw new UserError(
        "Não identifiquei esse registro com segurança. Informe o nome completo.",
      );
    return values[Number(value.slice(1))];
  };
  let payload: {
    operation: string;
    data: unknown;
    view: Omit<ActionView, "id" | "status">;
  };
  if (a.type === "event_create") {
    const account = ref(a.account, "a", c.accounts);
    const counter = a.counter_account
      ? ref(a.counter_account, "a", c.accounts)
      : null;
    const category = a.category ? ref(a.category, "c", c.categories) : null;
    if (
      account.currency !== currency ||
      (counter && counter.currency !== currency)
    )
      throw new UserError(
        "Para câmbio, use o formulário de movimento e confira principal e tarifas separadamente.",
      );
    const paired = [
      "transfer",
      "card_payment",
      "investment_buy",
      "investment_sell",
    ].includes(a.kind);
    if (!paired && !category)
      throw new UserError("Qual categoria deseja usar para este movimento?");
    if (paired !== !!counter)
      throw new UserError(
        "Informe as duas contas para essa transferência; não vou escolher por vocês.",
      );
    const signed = ["income", "yield", "investment_sell"].includes(a.kind)
      ? a.amount_cents
      : "-" + a.amount_cents;
    // Validate the same ledger invariants before offering a preview.
    postings({
      kind: a.kind,
      amount: BigInt(signed),
      accountId: account.id,
      currency,
      accountKind: account.kind as "checking",
      counterId: counter?.id,
      counterKind: counter?.kind as "checking" | undefined,
    });
    const date = day(a.date)!;
    payload = {
      operation: "event",
      data: {
        account_id: account.id,
        date,
        description: a.label,
        amount: plainMoney(signed),
        kind: a.kind,
        category_id: paired ? null : (category?.id ?? null),
        counter_account_id: counter?.id ?? null,
        counter_currency: null,
        counter_amount: null,
        related_event_id: null,
        request_id: id,
      },
      view: {
        title: "Registrar movimento",
        details: [
          a.label,
          {
            income: "Entrada",
            expense: "Despesa",
            transfer: "Transferência entre nossas contas",
            card_purchase: "Compra no cartão",
            card_payment: "Pagamento de fatura",
            investment_buy: "Aporte",
            investment_sell: "Resgate",
            yield: "Rendimento",
            fee: "Tarifa",
          }[a.kind],
          `${formatted(signed, currency)} · ${brDate(date)}`,
          `${account.name}${counter ? (BigInt(signed) > 0n ? " ← " : " → ") + counter.name : ""}`,
          category && !paired
            ? `Categoria: ${category.name}`
            : "Sem categoria de despesa",
          paired
            ? "Entre nossas contas: não conta como consumo."
            : "Confira se este movimento já aparece no extrato para evitar duplicidade.",
        ],
      },
    };
  } else if (a.type === "plan_create") {
    const due = day(a.date);
    if (
      c.items.some(
        (i) =>
          i.currency === currency &&
          i.label.trim().toLocaleLowerCase() === a.label.toLocaleLowerCase(),
      )
    )
      throw new UserError(
        "Já existe um compromisso com esse nome. Peça para editar o existente ou use um nome diferente.",
      );
    payload = {
      operation: "plan",
      data: {
        month,
        label: a.label,
        purpose: a.purpose,
        currency,
        amount: plainMoney(a.amount_cents),
        due_date: due,
        category_id: null,
        notes: "",
      },
      view: {
        title: "Incluir no planejamento",
        details: [
          a.label,
          formatted(a.amount_cents, currency),
          due ? `Vence em ${brDate(due)}` : "Sem vencimento",
          `Mês: ${month} · ${a.purpose === "income" ? "Entrada prevista" : a.purpose === "saving" ? "Reserva" : a.purpose === "card" ? "Fatura" : a.purpose === "benefit" ? "Pago com benefício" : "Conta a pagar"}`,
          "Cria um compromisso; não cria uma transação bancária.",
        ],
      },
    };
  } else {
    const item = ref(a.target, "p", c.items);
    if (item.currency !== currency || !item.month.startsWith(month))
      throw new UserError("Este compromisso pertence a outro mês ou moeda.");
    if (a.type === "plan_edit") {
      if (
        a.label === undefined &&
        a.amount_cents === undefined &&
        a.date === undefined
      )
        throw new UserError("Diga o que deseja alterar neste compromisso.");
      const due = a.date === undefined ? item.due_date : day(a.date);
      payload = {
        operation: "plan",
        data: {
          id: item.id,
          version: item.version,
          month,
          label: a.label ?? item.label,
          purpose: item.purpose,
          currency,
          amount: a.amount_cents
            ? plainMoney(a.amount_cents)
            : item.planned_cents
              ? plainMoney(item.planned_cents)
              : "",
          due_date: due,
          category_id: item.category_id,
          notes: item.notes,
        },
        view: {
          title: "Editar planejamento",
          details: [
            `Nome: ${item.label} → ${a.label ?? item.label}`,
            `Valor: ${item.planned_cents === null ? "A definir" : formatted(item.planned_cents, currency)} → ${(a.amount_cents ?? item.planned_cents) === null ? "A definir" : formatted(a.amount_cents ?? item.planned_cents!, currency)}`,
            `Vencimento: ${item.due_date ? brDate(item.due_date) : "Sem data"} → ${due ? brDate(due) : "Sem data"}`,
            "Os movimentos e extratos originais permanecem preservados.",
          ],
        },
      };
    } else {
      const date = day(a.date);
      if (a.status === "partial" && !a.amount_cents)
        throw new UserError("Qual foi o valor pago parcialmente?");
      if (a.status !== "open" && !a.amount_cents && item.planned_cents === null)
        throw new UserError(
          "Qual foi o valor pago? O compromisso ainda está sem valor.",
        );
      payload = {
        operation: "check",
        data: {
          id: item.id,
          version: item.version,
          status: a.status,
          amount: a.amount_cents ? plainMoney(a.amount_cents) : null,
          date,
          event_id: a.status === "open" ? null : item.event_id,
        },
        view: {
          title:
            a.status === "open" ? "Reabrir compromisso" : "Atualizar pagamento",
          details: [
            item.label,
            `Situação: ${item.status === "done" ? "Pago" : item.status === "partial" ? "Parcial" : "Em aberto"} → ${a.status === "done" ? "Pago" : a.status === "partial" ? "Parcial" : "Em aberto"}`,
            a.status === "open"
              ? "Remove a marcação de pagamento."
              : formatted(
                  a.amount_cents ?? item.planned_cents ?? "0",
                  currency,
                ),
            date ? `Data: ${brDate(date)}` : "Sem data de pagamento informada",
            "Atualiza apenas o acompanhamento; não cria outra despesa.",
          ],
        },
      };
    }
  }
  await asUser(db, user.userId, async (tx) => {
    await tx.query(
      "INSERT INTO chat_actions(id,household_id,user_id,payload) VALUES($1,$2,$3,$4)",
      [id, user.familyId, user.userId, JSON.stringify(payload)],
    );
    await recordAudit(tx, user.familyId, user.userId, "chat.propose", id);
  });
  return { id, ...payload.view, status: "pending" };
}
export async function resolveAction(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  const input = z
    .object({ id: z.uuid(), decision: z.enum(["confirm", "cancel"]) })
    .strict()
    .parse(raw);
  if (user.role === "reader")
    throw new UserError("Seu acesso é somente para leitura.");
  return asUser(db, user.userId, async (tx) => {
    const a = (
      await tx.query<{
        payload: { operation: string; data: unknown };
        status: string;
        expired: boolean;
        result: unknown;
      }>(
        "SELECT payload,status,expires_at<now() AS expired,result FROM chat_actions WHERE id=$1 AND household_id=$2 AND user_id=$3 FOR UPDATE",
        [input.id, user.familyId, user.userId],
      )
    ).rows[0];
    if (!a)
      throw new UserError("Essa prévia não está disponível para este acesso.");
    if (a.status !== "pending") return { status: a.status, result: a.result };
    if (a.expired)
      throw new UserError(
        "A prévia expirou. Peça novamente para conferir os dados atuais.",
      );
    if (input.decision === "cancel") {
      await tx.query("UPDATE chat_actions SET status='cancelled' WHERE id=$1", [
        input.id,
      ]);
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "chat.cancel",
        input.id,
      );
      return { status: "cancelled" };
    }
    const p = a.payload;
    // Lock creates by their economic identity, including previews made in separate conversations.
    if (p.operation === "plan") {
      const data = p.data as {
        id?: string;
        month: string;
        label: string;
        currency: string;
      };
      if (!data.id) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          user.familyId +
            data.month +
            data.currency +
            data.label.toLocaleLowerCase(),
        ]);
        const duplicate = await tx.query(
          "SELECT id FROM monthly_items WHERE household_id=$1 AND month=$2 AND currency=$3 AND lower(label)=lower($4) AND NOT archived LIMIT 1",
          [user.familyId, data.month + "-01", data.currency, data.label],
        );
        if (duplicate.rows.length)
          throw new UserError(
            "Este compromisso já foi incluído. Atualize o mês antes de criar outro.",
          );
      }
    }
    if (p.operation === "event") {
      const data = p.data as {
        account_id: string;
        date: string;
        description: string;
        amount: string;
      };
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        user.familyId + data.account_id + data.date + data.amount,
      ]);
      const duplicate = await tx.query(
        "SELECT id FROM economic_events WHERE household_id=$1 AND account_id=$2 AND transaction_date=$3 AND amount_cents=$4 AND lower(description)=lower($5) LIMIT 1",
        [
          user.familyId,
          data.account_id,
          data.date,
          cents(data.amount).toString(),
          data.description,
        ],
      );
      if (duplicate.rows.length)
        throw new UserError(
          "Já há um movimento com essa conta, data, descrição e valor. Confira Movimentos; nada foi duplicado.",
        );
    }
    const result =
      p.operation === "plan"
        ? await saveItemTx(tx, user, p.data)
        : p.operation === "check"
          ? await checkItemTx(tx, user, p.data)
          : p.operation === "event"
            ? { id: await createManualEventTx(tx, user, p.data) }
            : null;
    if (!result) throw new UserError("Tipo de alteração indisponível.");
    await tx.query(
      "UPDATE chat_actions SET status='confirmed',result=$1 WHERE id=$2",
      [JSON.stringify(result), input.id],
    );
    await recordAudit(tx, user.familyId, user.userId, "chat.confirm", input.id);
    return { status: "confirmed", result };
  });
}
