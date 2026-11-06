import { randomUUID } from "node:crypto";
import type { Transaction } from "@electric-sql/pglite";
import type { Database } from "./db.ts";
import { z } from "zod";
import { asUser, recordAudit } from "./db.ts";
import type { Identity } from "./auth.ts";
import {
  analyzePending,
  fxEvidence,
  pendingRows,
  type PendingRow,
} from "./pending.ts";
import {
  accountFor,
  addEvent,
  refreshReconciliations,
  type StageRow,
} from "./imports.ts";
import { normalize, type Kind } from "../domain/finance.ts";

const money = z
  .string()
  .regex(/^-?\d{1,16}$/)
  .nullable();
const planningSchema = z.object({
  entries: z
    .array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}-01$/),
        sheet: z.string().max(80),
        cell: z.string().max(20),
        label: z.string().max(300),
        planned_cents: money,
        actual_cents: money,
        purpose: z.enum(["expense", "income", "saving", "card", "benefit"]),
        derived: z.boolean(),
        notes: z.string().max(3000),
        error: z.string().nullable(),
        actual_error: z.string().nullable(),
        formula: z.string().nullable(),
      }),
    )
    .max(2000),
});
export function categoryFor(description: string): {
  name: string;
  strong: boolean;
} {
  const t = normalize(description).split(/AGENCIA:| CONTA:/)[0];
  const rules: [RegExp, string][] = [
    [/WISE CHARGES|TARIFA|TAXA|IMPOST|IOF|IPVA/, "Impostos e tarifas"],
    [/DIZIM|JEJUM|MISSAO|OFERTA|DOAC/, "Doações"],
    [
      /SUPERMERC|MERCADO(?! PAGO| LIVRE)|HORTIFR|ACOUGUE|FEIRA/,
      "Supermercado e feira",
    ],
    [
      /IFOOD|IFD\*|MARMITA|RESTAUR|LANCH|JANTAR|BURGER|MCDONAL|PIZZ/,
      "Alimentação fora",
    ],
    [
      /UNIMED|FARMAC|DROGARIA|TERAPIA|PSICO|IMPLAN|COOPART|COPART|SAUDE|REM[ÉE]D/,
      "Saúde",
    ],
    [/FRALDA|HIGIENE|LENCOS/, "Cuidados infantis"],
    [
      /COMBUST|GASOLINA|POSTO |AUTO POSTO|UBER|BOLT|CARRO|CLIO|SEGURO DO CARRO/,
      "Transporte",
    ],
    [/FACULDADE|UNIT(?!ED)|MATRICULA|MATERIAS|TCC/, "Educação"],
    [/CELULAR|TELEFONICA|VIVO|TELEFON|INTERNET/, "Telefonia e internet"],
    [/ENERG|AGUA|SANEAM|DESO|ALUGUEL|AR-COND/, "Moradia"],
    [/CONTADOR/, "Atividade profissional"],
    [/BABA|MESVERS|FESTA|FOTOGRAF/, "Família"],
    [/ACADEMIA|LAZER|PASSEIO/, "Lazer"],
    [/VESTUARIO|PESSOAL|MOCHILA|MERCADO LIVRE/, "Compras pessoais"],
    [/SALARIO|REMUNERACAO|FREELANC/, "Receitas profissionais"],
    [/REND PAGO|RENDIMENTO|CASHBACK/, "Rendimentos"],
    [/PASSAPORTE|VIAGEM/, "Viagens"],
  ];
  const match = rules.find(([re]) => re.test(t));
  return match
    ? { name: match[1], strong: true }
    : { name: "Outras despesas", strong: false };
}
async function category(tx: Transaction, family: string, name: string) {
  await tx.query(
    "INSERT INTO categories(id,household_id,name,essential) VALUES($1,$2,$3,false) ON CONFLICT(household_id,name) DO NOTHING",
    [randomUUID(), family, name],
  );
  return (
    await tx.query<{ id: string }>(
      "SELECT id FROM categories WHERE household_id=$1 AND name=$2",
      [family, name],
    )
  ).rows[0].id;
}
export async function applyPlanning(
  db: Database,
  user: Identity,
  raw: unknown,
  sha: string,
  filename: string,
) {
  const { entries } = planningSchema.parse(raw);
  return asUser(db, user.userId, async (tx) => {
    const id = randomUUID();
    const inserted = await tx.query(
      "INSERT INTO planning_sources(id,household_id,sha256,filename,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(household_id,sha256) DO NOTHING RETURNING id",
      [id, user.familyId, sha, filename, user.userId],
    );
    if (!inserted.rows.length)
      return { alreadyImported: true, lines: 0, budgets: 0 };
    const totals = new Map<
      string,
      { month: string; cat: string; amount: bigint; blocked: boolean }
    >();
    for (const line of entries) {
      const cat = await category(
        tx,
        user.familyId,
        line.purpose === "income"
          ? "Receitas profissionais"
          : categoryFor(line.label).name,
      );
      await tx.query(
        "INSERT INTO planning_lines(id,household_id,source_id,month,sheet,cell,label,category_id,purpose,planned_cents,actual_cents,derived,notes,error,actual_error,formula) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
        [
          randomUUID(),
          user.familyId,
          id,
          line.month,
          line.sheet,
          line.cell,
          line.label,
          cat,
          line.purpose,
          line.planned_cents,
          line.actual_cents,
          line.derived,
          line.notes,
          line.error,
          line.actual_error,
          line.formula,
        ],
      );
      if (!["expense", "benefit"].includes(line.purpose)) continue;
      const key = line.month + cat;
      const current = totals.get(key) ?? {
        month: line.month,
        cat,
        amount: 0n,
        blocked: false,
      };
      if (
        line.error ||
        (line.planned_cents !== null && BigInt(line.planned_cents) < 0n)
      )
        current.blocked = true;
      if (line.planned_cents !== null && BigInt(line.planned_cents) >= 0n)
        current.amount += BigInt(line.planned_cents);
      // Blank is absent, not a zero budget.
      if (line.planned_cents !== null || line.error) totals.set(key, current);
    }
    let count = 0;
    for (const t of totals.values()) {
      if (t.blocked) continue;
      const result = await tx.query(
        "INSERT INTO budgets(household_id,category_id,month,currency,planned_cents) VALUES($1,$2,$3,'BRL',$4) ON CONFLICT DO NOTHING RETURNING category_id",
        [user.familyId, t.cat, t.month, t.amount.toString()],
      );
      count += result.rows.length;
    }
    await recordAudit(tx, user.familyId, user.userId, "planning.import", id, {
      lines: entries.length,
      budgets: count,
      derivedActualsAuthorized: true,
      totalsNotTransactions: true,
    });
    return { alreadyImported: false, lines: entries.length, budgets: count };
  });
}

export async function prefillAndRecord(
  db: Database,
  user: Identity,
  record: boolean,
) {
  return asUser(db, user.userId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.familyId + "history-reconciliation",
    ]);
    const rows = await pendingRows(tx, user.familyId, true);
    const merchantRules = (
      await tx.query<{ match_text: string; category_name: string }>(
        "SELECT match_text,category_name FROM merchant_rules WHERE household_id=$1",
        [user.familyId],
      )
    ).rows;
    const evidence = analyzePending(rows, user.name);
    const hold = new Set(
      evidence.findings
        .filter(
          (f) =>
            f.group === "Duplicidades" &&
            (f.title === "Identificador reutilizado" ||
              new Set(f.rows.map((r) => r.bank_id).filter(Boolean)).size <
                f.rows.length),
        )
        .flatMap((f) => f.rows.map((r) => r.id)),
    );
    const actions = new Map<
      string,
      {
        kind: Kind;
        cat: string | null;
        counter: string | null;
        peer?: PendingRow;
        reason: string;
      }
    >();
    const untouched = (r: PendingRow) =>
      !r.reviewed &&
      r.decision === "pending" &&
      !r.review_note.trim() &&
      !hold.has(r.id);
    for (const c of fxEvidence(rows).filter((c) => c.safe)) {
      if (!c.legs.every(untouched)) continue;
      for (const r of c.legs) {
        const peer = c.legs.find((p) => p.id !== r.id)!;
        if (
          r.counter_amount_cents !== peer.amount_cents ||
          r.counter_account_id !== peer.account_id
        )
          continue;
        actions.set(r.id, {
          kind: "fx",
          cat: null,
          counter: peer.account_id,
          peer,
          reason:
            "Câmbio comprovado por ID recíproco. Usuário esclareceu recebimentos USD, conversões BRL e EUR para viagem à Europa.",
        });
      }
    }
    for (const f of evidence.findings.filter(
      (f) => f.group === "Transferências",
    )) {
      if (
        !f.rows.every(untouched) ||
        f.rows.some(
          (r) =>
            evidence.findings.filter(
              (g) =>
                g.group === "Transferências" &&
                g.rows.some((p) => p.id === r.id),
            ).length !== 1,
        )
      )
        continue;
      for (const r of f.rows) {
        const peer = f.rows.find((p) => p.id !== r.id)!;
        actions.set(r.id, {
          kind: "transfer",
          cat: null,
          counter: peer.account_id,
          peer,
          reason:
            "Mesma moeda, valores opostos, titular identificado e conta ou instituição recíproca; contrapartidas únicas.",
        });
      }
    }
    const investmentAccounts = new Map<string, string>();
    const ensureAccount = async (
      name: string,
      institution: string,
      kind: string,
      currency: string,
    ) => {
      const found = (
        await tx.query<{ id: string }>(
          "SELECT id FROM accounts WHERE household_id=$1 AND name=$2 AND kind=$3 AND currency=$4",
          [user.familyId, name, kind, currency],
        )
      ).rows;
      if (found.length) return found[0].id;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, user.familyId, name, institution, currency, kind, user.userId],
      );
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "account.from.source",
        id,
        { source: "Extrato/planilha", opening: "unknown" },
      );
      return id;
    };
    let prefilled = 0;
    for (const r of rows) {
      if (!untouched(r)) continue;
      const t = normalize(r.original_description);
      let kind = r.kind as Kind,
        mapped = categoryFor(r.description),
        ready = false,
        counter: string | null = null;
      const rule = merchantRules.find((rule) =>
        t.includes(normalize(rule.match_text)),
      );
      if (rule && BigInt(r.amount_cents) < 0n)
        mapped = { name: rule.category_name, strong: true };
      if (
        r.bank_id?.startsWith("FEE-") &&
        /^WISE CHARGES FOR:/i.test(r.original_description)
      ) {
        kind = "fee";
        mapped = { name: "Impostos e tarifas", strong: true };
        ready = true;
      } else if (
        /REMUNERACAO\/SALARIO/.test(t) &&
        BigInt(r.amount_cents) > 0n
      ) {
        kind = "income";
        mapped = { name: "Receitas profissionais", strong: true };
        ready = true;
      } else if (
        /REND PAGO|RENDIMENTO|CASHBACK/.test(t) &&
        BigInt(r.amount_cents) > 0n
      ) {
        kind = "yield";
        mapped = { name: "Rendimentos", strong: true };
        ready = true;
      } else if (
        /^(APLICACAO|RESGATE) RDB/.test(t) &&
        r.account_name.toUpperCase().includes("NUBANK")
      ) {
        kind = t.startsWith("RESGATE") ? "investment_sell" : "investment_buy";
        counter =
          investmentAccounts.get(r.account_id) ??
          (await ensureAccount(
            "RDB Nubank",
            "Nubank",
            "investment",
            r.currency,
          ));
        investmentAccounts.set(r.account_id, counter);
        ready = true;
      } else if (kind === "card_payment") {
        const matches = (
          await tx.query<{ label: string }>(
            "SELECT label FROM planning_lines WHERE household_id=$1 AND month=date_trunc('month',$2::date)::date AND purpose='card' AND actual_cents=$3",
            [
              user.familyId,
              r.transaction_date,
              (-BigInt(r.amount_cents)).toString(),
            ],
          )
        ).rows.filter(
          (l) =>
            normalize(l.label).includes("NUBANK") &&
            normalize(l.label).includes(normalize(user.name).split(" ")[0]),
        );
        if (matches.length === 1) {
          counter = await ensureAccount(
            "Cartão Nubank · " + user.name.split(" ")[0],
            "Nubank",
            "card",
            r.currency,
          );
          ready = true;
        }
      } else if (
        BigInt(r.amount_cents) < 0n &&
        ["expense", "card_purchase"].includes(kind) &&
        mapped.strong &&
        !t.includes(normalize(user.name))
      ) {
        kind = "expense";
        ready = true;
      }
      const cat = [
        "income",
        "expense",
        "card_purchase",
        "fee",
        "yield",
      ].includes(kind)
        ? await category(tx, user.familyId, mapped.name)
        : null;
      if (!actions.has(r.id) && ready)
        actions.set(r.id, {
          kind,
          cat,
          counter,
          reason:
            "Classificação baseada na descrição bancária e/ou correspondência exata com a planilha. Autorização do usuário para registrar evidências claras.",
        });
      if (!r.category_id && mapped.strong && !actions.has(r.id)) {
        await tx.query(
          "UPDATE staged_transactions SET category_id=$1,version=version+1 WHERE id=$2",
          [cat, r.id],
        );
        prefilled++;
        await recordAudit(
          tx,
          user.familyId,
          user.userId,
          "import.category.prefill",
          r.id,
          { category_id: cat, decision: "pending" },
        );
      }
    }
    let created = 0,
      linked = 0;
    const handled = new Set<string>();
    for (const r of rows) {
      const a = actions.get(r.id);
      if (!a || handled.has(r.id)) continue;
      if (!record) {
        await tx.query(
          "UPDATE staged_transactions SET kind=$1,category_id=$2,counter_account_id=$3,version=version+1 WHERE id=$4",
          [a.kind, a.cat, a.counter, r.id],
        );
        prefilled++;
        continue;
      }
      const batch = (
        await tx.query<{ checks: { passed: boolean }[] }>(
          "SELECT checks FROM import_batches WHERE id=$1",
          [r.batch_id],
        )
      ).rows[0];
      if (!batch.checks.length || batch.checks.some((c) => !c.passed)) continue;
      const stage = {
        ...r,
        kind: a.kind,
        category_id: a.cat,
        counter_account_id: a.counter,
        reviewed: true,
        decision: "accept",
        review_note: a.reason,
        duplicate_hint: false,
        suggested_kind: a.kind,
        processing_date: null,
        due_date: null,
        related_event_id: null,
        link_event_id: null,
        confidence: 1,
      } as StageRow;
      const event = await addEvent(
        tx,
        user,
        await accountFor(tx, user.familyId, r.account_id),
        stage,
      );
      await tx.query(
        "INSERT INTO event_sources(household_id,event_id,staged_id) VALUES($1,$2,$3)",
        [user.familyId, event, r.id],
      );
      await tx.query(
        "UPDATE staged_transactions SET kind=$1,category_id=$2,counter_account_id=$3,decision='accept',reviewed=true,review_note=$4,version=version+1 WHERE id=$5",
        [a.kind, a.cat, a.counter, a.reason, r.id],
      );
      handled.add(r.id);
      created++;
      if (a.peer && actions.has(a.peer.id)) {
        const p = a.peer;
        await tx.query(
          "UPDATE ledger_entries SET transaction_date=$1 WHERE event_id=$2 AND account_id=$3",
          [p.transaction_date, event, p.account_id],
        );
        await tx.query(
          "INSERT INTO event_sources(household_id,event_id,staged_id) VALUES($1,$2,$3)",
          [user.familyId, event, p.id],
        );
        await tx.query(
          "UPDATE staged_transactions SET kind=$1,category_id=NULL,counter_account_id=$2,decision='link',reviewed=true,link_event_id=$3,review_note=$4,version=version+1 WHERE id=$5",
          [a.kind, r.account_id, event, a.reason, p.id],
        );
        handled.add(p.id);
        linked++;
      }
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "import.assisted.record",
        event,
        {
          source_ids: [r.id, ...(a.peer ? [a.peer.id] : [])],
          reason: a.reason,
        },
      );
    }
    if (record) {
      await tx.query(
        "UPDATE import_batches b SET status='confirmed',confirmed_at=now() WHERE b.household_id=$1 AND b.status='preview' AND EXISTS(SELECT 1 FROM staged_transactions s WHERE s.batch_id=b.id) AND NOT EXISTS(SELECT 1 FROM staged_transactions s WHERE s.batch_id=b.id AND NOT EXISTS(SELECT 1 FROM event_sources es WHERE es.staged_id=s.id))",
        [user.familyId],
      );
      await refreshReconciliations(tx, user.familyId);
    }
    return {
      created,
      linked,
      prefilled,
      remaining: rows.length - handled.size,
    };
  });
}

export async function prepareOpenings(db: Database, user: Identity) {
  return asUser(db, user.userId, async (tx) => {
    const accounts = (
      await tx.query<{ id: string }>(
        "SELECT id FROM accounts WHERE household_id=$1 AND opening_cents IS NULL FOR UPDATE",
        [user.familyId],
      )
    ).rows;
    let changed = 0;
    for (const a of accounts) {
      const candidate = (
        await tx.query<{
          id: string;
          context: { opening: { date: string; cents: string } };
        }>(
          "SELECT id,context FROM import_batches WHERE household_id=$1 AND account_id=$2 AND context->'opening' IS NOT NULL AND jsonb_array_length(checks)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(checks) c WHERE (c->>'passed')::boolean=false) ORDER BY context->'opening'->>'date' ASC LIMIT 1",
          [user.familyId, a.id],
        )
      ).rows[0];
      const o = candidate?.context.opening;
      if (!o) continue;
      const dates = (
        await tx.query<{ first: string | null }>(
          "SELECT min(s.transaction_date)::text AS first FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id WHERE b.household_id=$1 AND b.account_id=$2",
          [user.familyId, a.id],
        )
      ).rows[0];
      if (!dates.first || o.date >= dates.first) continue;
      await tx.query(
        "UPDATE accounts SET opening_cents=$1,opening_date=$2 WHERE household_id=$3 AND id=$4",
        [o.cents, o.date, user.familyId, a.id],
      );
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "account.opening.from.source",
        a.id,
        { source_batch: candidate.id, date: o.date, cents: o.cents },
      );
      changed++;
    }
    await refreshReconciliations(tx, user.familyId);
    return { changed };
  });
}
