import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { dateOnly } from "../domain/finance.ts";
import { UserError } from "./imports.ts";

export const credentialsSchema = z
  .object({
    clientId: z.string().trim().min(8).max(300),
    clientSecret: z.string().trim().min(8).max(500),
  })
  .strict();
export type BankCredentials = z.infer<typeof credentialsSchema>;
function encryptionKey() {
  const key = process.env.BANK_CONNECTIONS_KEY ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key))
    throw new UserError(
      "A conexão bancária ainda precisa ser ativada na hospedagem.",
    );
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32)
    throw new UserError("Configuração bancária indisponível.");
  return bytes;
}
export function bankStorageReady() {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}
export function sealCredentials(value: BankCredentials, binding: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("entre-nos:pluggy:v1:" + binding));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentialsSchema.parse(value))),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}
export function openCredentials(
  sealed: string,
  binding: string,
): BankCredentials {
  try {
    const [version, iv, tag, payload, ...extra] = sealed.split(".");
    if (version !== "v1" || extra.length) throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from("entre-nos:pluggy:v1:" + binding));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return credentialsSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(payload, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
  } catch {
    throw new UserError(
      "Não foi possível abrir suas credenciais. Confira a configuração da hospedagem; não gere outra chave se já houver conexões.",
    );
  }
}
export function decimalCents(value: string) {
  if (!/^-?\d{1,14}(?:\.\d{1,2})?$/.test(value))
    throw new UserError("O banco retornou um valor que precisa de revisão.");
  const negative = value.startsWith("-"),
    [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (result > 9000000000000000n)
    throw new UserError("Valor bancário fora do limite.");
  return result * (negative ? -1n : 1n);
}
const remoteId = z.uuid();
const itemSchema = z.object({
  id: remoteId,
  status: z.string(),
  consentExpiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  lastUpdatedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  connector: z.object({ name: z.string().max(200) }).optional(),
});
const accountSchema = z.object({
  id: remoteId,
  itemId: remoteId,
  name: z.string().max(200),
  number: z.string().max(200).nullish(),
  currencyCode: z.string().max(10),
  type: z.enum(["BANK", "CREDIT"]),
  balance: z.string().nullish(),
  creditData: z
    .object({
      balanceDueDate: z.string().nullish(),
      balanceCloseDate: z.string().nullish(),
      creditLimit: z.string().nullish(),
      availableCreditLimit: z.string().nullish(),
    })
    .nullish(),
});
export type RemoteAccount = z.infer<typeof accountSchema>;
const transactionSchema = z.object({
  id: z.string().min(1).max(200),
  accountId: remoteId,
  description: z.string().min(1).max(1000),
  amount: z.string(),
  date: z.string().min(10).max(40),
  type: z.enum(["CREDIT", "DEBIT"]),
  status: z.enum(["POSTED", "PENDING"]),
  currencyCode: z.string().max(10).optional(),
  providerId: z.string().max(250).nullish(),
  operationType: z.string().max(100).nullish(),
  creditCardMetadata: z
    .object({
      billId: z.uuid().nullish(),
      installmentNumber: z.number().int().min(0).max(999).nullish(),
      totalInstallments: z.number().int().min(0).max(999).nullish(),
      purchaseDate: z.string().nullish(),
    })
    .nullish(),
});
export type BankObservation = {
  remote_id: string;
  provider_id: string | null;
  transaction_date: string;
  description: string;
  amount_cents: string;
  currency: string;
  provider_status: string;
  operation_type: string;
  card_meta?: {
    bill_id: string | null;
    installment_number: number | null;
    total_installments: number | null;
    purchase_date: string | null;
  };
};
export function normalizeObservation(
  raw: unknown,
  account: RemoteAccount,
): BankObservation {
  const t = transactionSchema.parse(raw);
  if (t.accountId !== account.id)
    throw new UserError(
      "A resposta do banco trouxe uma conta diferente da solicitada.",
    );
  const amount = decimalCents(t.amount),
    absolute = amount < 0n ? -amount : amount;
  return {
    remote_id: t.id,
    provider_id: t.providerId ?? null,
    transaction_date: dateOnly(t.date.slice(0, 10)),
    description: t.description,
    amount_cents: (absolute * (t.type === "DEBIT" ? -1n : 1n)).toString(),
    currency: t.currencyCode ?? account.currencyCode,
    provider_status: t.status,
    operation_type: t.operationType ?? "",
    ...(account.type === "CREDIT" && t.creditCardMetadata
      ? {
          card_meta: {
            bill_id: t.creditCardMetadata.billId ?? null,
            installment_number: t.creditCardMetadata.installmentNumber || null,
            total_installments: t.creditCardMetadata.totalInstallments || null,
            purchase_date: t.creditCardMetadata.purchaseDate
              ? dateOnly(t.creditCardMetadata.purchaseDate.slice(0, 10))
              : null,
          },
        }
      : {}),
  };
}
export type RemoteBill = {
  remote_id: string;
  due_date: string;
  close_date: string | null;
  total_cents: string | null;
  raw_total: string;
  needs_review: boolean;
  charges_cents: string | null;
  payments: {
    id: string;
    date: string;
    cents: string | null;
    raw_amount: string;
  }[];
};
// Fixed host, explicit read endpoints, no redirects or arbitrary URLs. Auth is the only POST.
export class PluggyReader {
  private token = "";
  private deadline = Date.now() + 40000;
  private readonly credentials: BankCredentials;
  private readonly transport: typeof fetch;
  constructor(credentials: BankCredentials, transport: typeof fetch = fetch) {
    this.credentials = credentials;
    this.transport = transport;
  }
  private async request(path: string, auth = false): Promise<unknown> {
    if (
      !(auth && path === "/auth") &&
      !/^\/(?:items\/[0-9a-f-]{36}|accounts\?|bills\?|v2\/transactions\?)/i.test(
        path,
      )
    )
      throw new UserError("Operação bancária não permitida.");
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new UserError(
        "A leitura demorou mais que o esperado. Tente novamente; nada foi lançado.",
      );
    let response: Response;
    try {
      response = await this.transport("https://api.pluggy.ai" + path, {
        method: auth ? "POST" : "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(8000, remaining)),
        headers: auth
          ? { "content-type": "application/json" }
          : { "X-API-KEY": this.token },
        body: auth ? JSON.stringify(this.credentials) : undefined,
      });
    } catch {
      throw new UserError(
        "A Pluggy não respondeu. Tente mais tarde; nenhum movimento foi confirmado.",
      );
    }
    if (!response.ok)
      throw new UserError(
        response.status === 401 || response.status === 403
          ? "Confira suas credenciais e renove a autorização no Meu Pluggy, se necessário."
          : "Não foi possível consultar a Pluggy. Confira a conexão no painel do provedor e tente mais tarde.",
      );
    const reader = response.body?.getReader();
    if (!reader) throw new UserError("Resposta bancária vazia.");
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4 * 1024 * 1024) {
        await reader.cancel();
        throw new UserError("A resposta bancária excedeu o limite seguro.");
      }
      parts.push(value);
    }
    const body = Buffer.concat(parts).toString("utf8");
    try {
      return JSON.parse(
        body.replace(
          /(?<!\\)("(?:amount|balance|totalAmount|creditLimit|availableCreditLimit)"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
          '$1"$2"',
        ),
      );
    } catch {
      throw new UserError("O banco retornou uma resposta inválida.");
    }
  }
  async authenticate() {
    const r = z
      .object({ apiKey: z.string().min(1).max(5000) })
      .parse(await this.request("/auth", true));
    this.token = r.apiKey;
  }
  async item(id: string) {
    return itemSchema.parse(await this.request("/items/" + remoteId.parse(id)));
  }
  async accounts(itemId: string) {
    const r = z
      .object({
        results: z.array(accountSchema).max(50),
        total: z.number().optional(),
      })
      .parse(
        await this.request(
          "/accounts?" +
            new URLSearchParams({
              itemId: remoteId.parse(itemId),
              pageSize: "500",
            }),
        ),
      );
    if (r.total !== undefined && r.total > r.results.length)
      throw new UserError(
        "A conexão retornou contas além do limite de leitura.",
      );
    if (r.results.some((a) => a.itemId !== itemId))
      throw new UserError("A conexão retornou contas de outra autorização.");
    return r.results;
  }
  async bills(account: RemoteAccount) {
    if (account.type !== "CREDIT") return [];
    const schema = z.object({
      id: z.uuid(),
      accountId: z.uuid().optional(),
      dueDate: z.string(),
      billClosingDate: z.string().nullish(),
      totalAmount: z.string(),
      totalAmountCurrencyCode: z.string(),
      financeCharges: z
        .array(z.object({ amount: z.string(), currencyCode: z.string() }))
        .max(500)
        .default([]),
      payments: z
        .array(
          z.object({
            id: z.string().max(200),
            paymentDate: z.string(),
            amount: z.string(),
            currencyCode: z.string(),
          }),
        )
        .max(500)
        .default([]),
    });
    const rows: RemoteBill[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 20; page++) {
      const response = z
        .object({
          page: z.number().int(),
          totalPages: z.number().int().min(0).max(20),
          results: z.array(schema).max(500),
        })
        .parse(
          await this.request(
            "/bills?" +
              new URLSearchParams({
                accountId: remoteId.parse(account.id),
                page: String(page),
                pageSize: "500",
              }),
          ),
        );
      if (response.page !== page)
        throw new UserError("Paginação de faturas inconsistente.");
      for (const b of response.results) {
        if ((b.accountId && b.accountId !== account.id) || seen.has(b.id))
          throw new UserError("Identidade de fatura inconsistente.");
        seen.add(b.id);
        if (
          b.totalAmountCurrencyCode !== "BRL" ||
          b.financeCharges.some((c) => c.currencyCode !== "BRL") ||
          b.payments.some((p) => p.currencyCode !== "BRL")
        )
          throw new UserError("Fatura com moeda diferente exige revisão.");
        const exact = (amount: string) => {
          try {
            const cents = decimalCents(amount);
            return cents >= 0n ? cents : null;
          } catch {
            return null;
          }
        };
        const total = exact(b.totalAmount),
          chargeValues = b.financeCharges.map((c) => exact(c.amount)),
          paymentValues = b.payments.map((p) => exact(p.amount));
        const charges = chargeValues.some((c) => c === null)
          ? null
          : chargeValues.reduce<bigint>((n, c) => n + c!, 0n);
        if (new Set(b.payments.map((p) => p.id)).size !== b.payments.length)
          throw new UserError(
            "Identificadores de pagamento repetidos na fatura.",
          );
        rows.push({
          remote_id: b.id,
          due_date: dateOnly(b.dueDate.slice(0, 10)),
          close_date: b.billClosingDate
            ? dateOnly(b.billClosingDate.slice(0, 10))
            : null,
          total_cents: total?.toString() ?? null,
          raw_total: b.totalAmount,
          needs_review:
            total === null ||
            charges === null ||
            paymentValues.some((p) => p === null),
          charges_cents: charges?.toString() ?? null,
          payments: b.payments.map((p, index) => ({
            id: p.id,
            date: dateOnly(p.paymentDate.slice(0, 10)),
            cents: paymentValues[index]?.toString() ?? null,
            raw_amount: p.amount,
          })),
        });
      }
      if (page >= response.totalPages) return rows;
    }
    throw new UserError("Limite de faturas excedido.");
  }
  async transactions(account: RemoteAccount, start: string) {
    dateOnly(start);
    const seen = new Set<string>(),
      rows: BankObservation[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({
        accountId: account.id,
        dateFrom: start,
      });
      if (after) query.set("after", after);
      const response = z
        .object({
          results: z.array(z.unknown()).max(500),
          next: z.string().max(6000).nullable(),
        })
        .parse(await this.request("/v2/transactions?" + query));
      for (const raw of response.results) {
        const row = normalizeObservation(raw, account);
        if (row.transaction_date >= start && row.amount_cents !== "0")
          rows.push(row);
      }
      if (!response.next) return rows;
      if (!response.next.startsWith("?"))
        throw new UserError("Paginação bancária inválida.");
      const next = new URLSearchParams(response.next.slice(1));
      after = next.get("after") ?? undefined;
      if (
        next.get("accountId") !== account.id ||
        !after ||
        after.length > 3000 ||
        seen.has(after)
      )
        throw new UserError("Paginação bancária inconsistente.");
      seen.add(after);
    }
    throw new UserError(
      "Há muitos movimentos nesse período. Escolha uma data inicial mais recente.",
    );
  }
}
