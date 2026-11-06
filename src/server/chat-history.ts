import { z } from "zod";
import { asUser, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { askHelp } from "./help.ts";
import { UserError } from "./imports.ts";
import { dateOnly, type Currency } from "../domain/finance.ts";
import type { ActionView } from "./chat-actions.ts";

export type Conversation = {
  id: string;
  title: string;
  month: string;
  currency: Currency;
  updated_at: string;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  source?: string;
  coverage?: string;
  action?: ActionView;
  pending?: boolean;
  error?: boolean;
};
type Turn = {
  id: string;
  ordinal: number;
  question: string;
  status: string;
  answer: string | null;
  source: string | null;
  coverage: string | null;
  action_id: string | null;
  action_status: string | null;
  action_view: Omit<ActionView, "id" | "status"> | null;
};
const columns =
  "id,title,to_char(month,'YYYY-MM') AS month,currency,updated_at::text";
const turnColumns = `t.id,t.ordinal,t.question,t.status,t.answer,t.source,t.coverage,t.action_id,
 CASE WHEN a.status='pending' AND a.expires_at<now() THEN 'expired' ELSE a.status END AS action_status,
 a.payload->'view' AS action_view`;
const turnJoin =
  "chat_turns t LEFT JOIN chat_actions a ON a.id=t.action_id AND a.household_id=t.household_id AND a.user_id=t.user_id";
function messages(turn: Turn): ChatMessage[] {
  return [
    { id: turn.id + "-u", role: "user", text: turn.question },
    {
      id: turn.id + "-a",
      role: "assistant",
      text:
        turn.answer ??
        "Esta resposta ainda está em andamento. Atualize a conversa em alguns instantes.",
      pending: turn.status === "pending",
      error: turn.status === "failed",
      source: turn.source ?? undefined,
      coverage: turn.coverage ?? undefined,
      ...(turn.action_id && turn.action_view && turn.action_status
        ? {
            action: {
              id: turn.action_id,
              ...turn.action_view,
              status: turn.action_status,
            },
          }
        : {}),
    },
  ];
}
export async function listConversations(
  db: Database,
  user: Identity,
  offset = 0,
) {
  const skip = z.number().int().min(0).max(100000).parse(offset);
  return asUser(db, user.userId, async (tx) => {
    const rows = (
      await tx.query<Conversation>(
        `SELECT ${columns} FROM chat_conversations WHERE household_id=$1 AND user_id=$2 ORDER BY opened_at DESC,id DESC LIMIT 31 OFFSET $3`,
        [user.familyId, user.userId, skip],
      )
    ).rows;
    return { conversations: rows.slice(0, 30), hasMore: rows.length > 30 };
  });
}
export async function createConversation(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  const input = z
    .object({
      id: z.uuid(),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      currency: z.enum(["BRL", "USD", "EUR"]),
    })
    .strict()
    .parse(raw);
  dateOnly(input.month + "-01");
  return asUser(db, user.userId, async (tx) => {
    // An unknown/reused ID must never grant access to another person's conversation.
    await tx.query(
      "INSERT INTO chat_conversations(id,household_id,user_id,month,currency) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING",
      [
        input.id,
        user.familyId,
        user.userId,
        input.month + "-01",
        input.currency,
      ],
    );
    const row = (
      await tx.query<Conversation>(
        `SELECT ${columns} FROM chat_conversations WHERE id=$1 AND household_id=$2 AND user_id=$3`,
        [input.id, user.familyId, user.userId],
      )
    ).rows[0];
    if (!row || row.month !== input.month || row.currency !== input.currency)
      throw new UserError("Conversa indisponível para este acesso.");
    return row;
  });
}
export async function openConversation(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  const input = z
    .object({ id: z.uuid(), before: z.number().int().positive().optional() })
    .strict()
    .parse(raw);
  return asUser(db, user.userId, async (tx) => {
    const row = (
      await tx.query<Conversation>(
        `SELECT ${columns} FROM chat_conversations WHERE id=$1 AND household_id=$2 AND user_id=$3`,
        [input.id, user.familyId, user.userId],
      )
    ).rows[0];
    if (!row) throw new UserError("Conversa indisponível para este acesso.");
    if (!input.before) {
      await tx.query(
        "UPDATE chat_conversations SET opened_at=now() WHERE id=$1 AND household_id=$2 AND user_id=$3",
        [input.id, user.familyId, user.userId],
      );
      await tx.query(
        "UPDATE chat_turns SET status='failed',answer='A resposta foi interrompida. Você pode enviar sua mensagem novamente.',completed_at=now() WHERE conversation_id=$1 AND household_id=$2 AND user_id=$3 AND status='pending' AND created_at<now()-interval '2 minutes'",
        [input.id, user.familyId, user.userId],
      );
    }
    const turns = (
      await tx.query<Turn>(
        `SELECT ${turnColumns} FROM ${turnJoin} WHERE t.conversation_id=$1 AND t.household_id=$2 AND t.user_id=$3 AND ($4::integer IS NULL OR t.ordinal<$4) ORDER BY t.ordinal DESC LIMIT 31`,
        [input.id, user.familyId, user.userId, input.before ?? null],
      )
    ).rows;
    const page = turns.slice(0, 30).reverse();
    return {
      conversation: row,
      messages: page.flatMap(messages),
      hasOlder: turns.length > 30,
      before: page[0]?.ordinal ?? null,
    };
  });
}
export async function sendChat(db: Database, user: Identity, raw: unknown) {
  const input = z
    .object({
      id: z.uuid(),
      request_id: z.uuid(),
      question: z.string().trim().min(3).max(600),
      external: z.boolean().default(false),
    })
    .strict()
    .parse(raw);
  const start = await asUser(db, user.userId, async (tx) => {
    const c = (
      await tx.query<Conversation>(
        `SELECT ${columns} FROM chat_conversations WHERE id=$1 AND household_id=$2 AND user_id=$3 FOR UPDATE`,
        [input.id, user.familyId, user.userId],
      )
    ).rows[0];
    if (!c) throw new UserError("Conversa indisponível para este acesso.");
    const existing = (
      await tx.query<Turn & { external: boolean }>(
        `SELECT ${turnColumns},t.external FROM ${turnJoin} WHERE t.id=$1 AND t.conversation_id=$2 AND t.household_id=$3 AND t.user_id=$4`,
        [input.request_id, input.id, user.familyId, user.userId],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.question !== input.question ||
        existing.external !== input.external
      )
        throw new UserError("Essa mensagem já foi enviada com outro conteúdo.");
      return { conversation: c, existing, history: [] };
    }
    await tx.query(
      "UPDATE chat_turns SET status='failed',answer='A resposta foi interrompida. Você pode enviar sua mensagem novamente.',completed_at=now() WHERE conversation_id=$1 AND status='pending' AND created_at<now()-interval '2 minutes'",
      [c.id],
    );
    if (
      (
        await tx.query(
          "SELECT id FROM chat_turns WHERE conversation_id=$1 AND status='pending'",
          [c.id],
        )
      ).rows.length
    )
      throw new UserError(
        "Já há uma resposta em andamento nesta conversa. Atualize antes de enviar outra mensagem.",
      );
    const previous = (
      await tx.query<Turn>(
        `SELECT ${turnColumns} FROM ${turnJoin} WHERE t.conversation_id=$1 AND t.status='complete' ORDER BY t.ordinal DESC LIMIT 4`,
        [c.id],
      )
    ).rows.reverse();
    const history = previous.flatMap((t) => [
      { role: "user" as const, text: t.question },
      {
        role: "assistant" as const,
        text: (
          (t.action_status
            ? `Situação real da prévia: ${t.action_status}.\n`
            : "") + (t.answer ?? "")
        ).slice(0, 1500),
      },
    ]);
    await tx.query(
      "INSERT INTO chat_turns(id,household_id,user_id,conversation_id,ordinal,question,external) SELECT $1,$2,$3,$4,coalesce(max(ordinal),0)+1,$5,$6 FROM chat_turns WHERE conversation_id=$4",
      [
        input.request_id,
        user.familyId,
        user.userId,
        c.id,
        input.question,
        input.external,
      ],
    );
    await tx.query(
      "UPDATE chat_conversations SET title=CASE WHEN title='Nova conversa' THEN $1 ELSE title END,updated_at=now(),opened_at=now() WHERE id=$2",
      [input.question.slice(0, 100), c.id],
    );
    return { conversation: c, existing: null, history };
  });
  if (start.existing)
    return {
      messages: messages(start.existing),
      pending: start.existing.status === "pending",
    };
  let answer: {
    text: string;
    source?: string;
    coverage?: string;
    action?: ActionView;
  };
  let status = "complete";
  try {
    answer = await askHelp(db, user, {
      question: input.question,
      month: start.conversation.month,
      currency: start.conversation.currency,
      external: input.external,
      chat: true,
      history: start.history,
    });
  } catch (error) {
    status = "failed";
    answer = {
      text:
        error instanceof UserError
          ? error.message
          : "Não foi possível responder agora. Você pode enviar novamente; nenhum lançamento foi confirmado.",
    };
  }
  return asUser(db, user.userId, async (tx) => {
    // A terminated request cannot overwrite a turn already marked interrupted on another device.
    await tx.query(
      "UPDATE chat_turns SET status=$1,answer=$2,source=$3,coverage=$4,action_id=$5,completed_at=now() WHERE id=$6 AND household_id=$7 AND user_id=$8 AND status='pending'",
      [
        status,
        answer.text,
        answer.source ?? null,
        answer.coverage ?? null,
        answer.action?.id ?? null,
        input.request_id,
        user.familyId,
        user.userId,
      ],
    );
    await tx.query(
      "UPDATE chat_conversations SET updated_at=now() WHERE id=$1 AND household_id=$2 AND user_id=$3",
      [input.id, user.familyId, user.userId],
    );
    const turn = (
      await tx.query<Turn>(
        `SELECT ${turnColumns} FROM ${turnJoin} WHERE t.id=$1 AND t.household_id=$2 AND t.user_id=$3`,
        [input.request_id, user.familyId, user.userId],
      )
    ).rows[0];
    return { messages: messages(turn), pending: false };
  });
}
