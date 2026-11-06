import webpush from "web-push";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validSecret } from "./deployment.ts";
import { asUser, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { UserError } from "./imports.ts";

export function safePushEndpoint(endpoint: string) {
  const u = new URL(endpoint);
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    (u.hostname === "web.push.apple.com" ||
      u.hostname.endsWith(".push.apple.com") ||
      u.hostname === "fcm.googleapis.com" ||
      u.hostname === "updates.push.services.mozilla.com" ||
      u.hostname.endsWith(".notify.windows.com"))
  );
}
async function keys(db: Database) {
  let row = (
    await db.query<{ public_key: string; private_key: string }>(
      "SELECT public_key,private_key FROM notification_keys WHERE id=1",
    )
  ).rows[0];
  if (!row) {
    const pair = webpush.generateVAPIDKeys();
    await db.query(
      "INSERT INTO notification_keys(id,public_key,private_key) VALUES(1,$1,$2) ON CONFLICT DO NOTHING",
      [pair.publicKey, pair.privateKey],
    );
    row = (
      await db.query<typeof row>(
        "SELECT public_key,private_key FROM notification_keys WHERE id=1",
      )
    ).rows[0];
  }
  return row;
}
export async function pushStatus(db: Database, user: Identity) {
  const pair = await keys(db);
  const status = await asUser(
    db,
    user.userId,
    async (tx) =>
      (
        await tx.query<{ devices: number; last_delivery: string | null }>(
          "SELECT count(*)::int AS devices,max(last_sent)::text AS last_delivery FROM push_subscriptions WHERE user_id=$1 AND enabled",
          [user.userId],
        )
      ).rows[0],
  );
  return {
    publicKey: pair.public_key,
    enabledDevices: status.devices,
    lastDelivery: status.last_delivery,
    schedulerReady: validSecret(
      process.env.CRON_SECRET,
      process.env.CRON_SECRET,
    ),
  };
}
export async function subscribePush(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  const input = z
    .object({
      endpoint: z.url().max(2500),
      keys: z.object({
        p256dh: z.string().regex(/^[\w-]{87}$/),
        auth: z.string().regex(/^[\w-]{22}$/),
      }),
    })
    .parse(raw);
  if (!safePushEndpoint(input.endpoint))
    throw new UserError("Serviço de notificações não reconhecido.");
  return asUser(db, user.userId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.userId + "push",
    ]);
    const existing = (
      await tx.query<{ user_id: string; enabled: boolean }>(
        "SELECT user_id,enabled FROM push_subscriptions WHERE endpoint=$1",
        [input.endpoint],
      )
    ).rows[0];
    if (existing && existing.user_id !== user.userId)
      throw new UserError("Este aparelho está vinculado a outro acesso.");
    if (
      (!existing || !existing.enabled) &&
      (
        await tx.query(
          "SELECT 1 FROM push_subscriptions WHERE user_id=$1 AND enabled",
          [user.userId],
        )
      ).rows.length >= 5
    )
      throw new UserError(
        "Limite de aparelhos atingido. Desative um aparelho antes de adicionar outro.",
      );
    const saved = await tx.query(
      "INSERT INTO push_subscriptions(id,household_id,user_id,endpoint,keys) VALUES($1,$2,$3,$4,$5) ON CONFLICT(endpoint) DO UPDATE SET enabled=true,keys=EXCLUDED.keys WHERE push_subscriptions.user_id=$3 RETURNING id",
      [
        randomUUID(),
        user.familyId,
        user.userId,
        input.endpoint,
        JSON.stringify(input.keys),
      ],
    );
    if (!saved.rows.length)
      throw new UserError(
        "Este aparelho precisa ser desvinculado do acesso anterior antes de ativar os alarmes.",
      );
    return { ok: true };
  });
}
export async function unsubscribePush(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  const { endpoint } = z.object({ endpoint: z.string().max(2500) }).parse(raw);
  return asUser(db, user.userId, async (tx) => {
    await tx.query(
      "UPDATE push_subscriptions SET enabled=false WHERE endpoint=$1 AND user_id=$2",
      [endpoint, user.userId],
    );
    return { ok: true };
  });
}
type PushTarget = {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
};
async function deliver(
  pair: { public_key: string; private_key: string },
  target: PushTarget,
  test = false,
) {
  if (!safePushEndpoint(target.endpoint))
    throw new UserError("Serviço de notificações não reconhecido.");
  await webpush.sendNotification(
    { endpoint: target.endpoint, keys: target.keys },
    JSON.stringify({
      type: test ? "test" : "reminder",
      title: "Entre Nós",
      body: "Há compromissos ou faturas para conferir no nosso mês.",
      url: "/?view=month",
    }),
    {
      vapidDetails: {
        subject: process.env.APP_ORIGIN || "https://entre-nos.invalid",
        publicKey: pair.public_key,
        privateKey: pair.private_key,
      },
      TTL: test ? 300 : 43200,
      urgency: test ? "high" : "normal",
      topic: test ? "entre-nos-test" : "entre-nos-reminder",
      timeout: 8000,
    },
  );
}
export async function testPush(db: Database, user: Identity, raw: unknown) {
  const { endpoint } = z
    .object({ endpoint: z.string().max(2500) })
    .strict()
    .parse(raw);
  const token = randomUUID();
  const target = await asUser(
    db,
    user.userId,
    async (tx) =>
      (
        await tx.query<PushTarget>(
          `UPDATE push_subscriptions SET last_test_at=now(),delivery_token=$3,delivery_until=now()+interval '2 minutes' WHERE user_id=$1 AND endpoint=$2 AND enabled AND (last_test_at IS NULL OR last_test_at<now()-interval '1 minute') AND (delivery_until IS NULL OR delivery_until<now()) RETURNING id,endpoint,keys`,
          [user.userId, endpoint, token],
        )
      ).rows[0],
  );
  if (!target)
    throw new UserError(
      "Ative os alarmes neste aparelho ou aguarde um minuto antes de testar novamente.",
    );
  try {
    await deliver(await keys(db), target, true);
    return { ok: true, accepted: true };
  } catch (error) {
    if ([404, 410].includes((error as { statusCode?: number }).statusCode ?? 0))
      await asUser(db, user.userId, (tx) =>
        tx.query(
          "UPDATE push_subscriptions SET enabled=false WHERE id=$1 AND user_id=$2",
          [target.id, user.userId],
        ),
      );
    throw new UserError(
      [404, 410].includes((error as { statusCode?: number }).statusCode ?? 0)
        ? "A inscrição deste aparelho expirou. Ative as notificações novamente."
        : "O serviço de push recusou ou não concluiu o envio. Verifique a configuração e tente novamente.",
    );
  } finally {
    await asUser(db, user.userId, (tx) =>
      tx.query(
        "UPDATE push_subscriptions SET delivery_token=NULL,delivery_until=NULL WHERE id=$1 AND user_id=$2 AND delivery_token=$3",
        [target.id, user.userId, token],
      ),
    );
  }
}
export async function sendDueReminders(db: Database) {
  const users = (
    await db.query<{ user_id: string }>(
      "SELECT DISTINCT user_id FROM members ORDER BY user_id LIMIT 30",
    )
  ).rows;
  let sent = 0,
    failed = 0;
  for (const u of users) {
    const result = await sendMemberReminders(db, u.user_id);
    sent += result.sent;
    failed += result.failed;
  }
  console.info("notification_reminders", { sent, failed });
  return { sent, failed };
}
async function sendMemberReminders(db: Database, userId: string) {
  const pair = await keys(db),
    token = randomUUID();
  const rows = (
    await asUser(db, userId, (tx) =>
      tx.query<PushTarget>(
        `UPDATE push_subscriptions s SET delivery_token=$1,delivery_until=now()+interval '5 minutes' WHERE s.id IN (
 SELECT p.id FROM push_subscriptions p WHERE p.enabled AND (p.last_sent IS NULL OR p.last_sent<(now() AT TIME ZONE 'America/Sao_Paulo')::date) AND (p.delivery_until IS NULL OR p.delivery_until<now()) AND (
 EXISTS(SELECT 1 FROM monthly_items i WHERE i.household_id=p.household_id AND NOT i.archived AND i.purpose IN ('expense','card','benefit') AND i.status<>'done' AND i.due_date BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-7 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date+1)
 OR EXISTS(SELECT 1 FROM manual_card_bills b WHERE b.household_id=p.household_id AND NOT b.paid AND b.amount_cents>0 AND b.due_date BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-7 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date+1)
 OR EXISTS(SELECT 1 FROM bank_accounts a WHERE a.household_id=p.household_id AND a.account_type='CREDIT' AND a.active AND a.balance_cents>0 AND a.credit_due_date BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-7 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date+1)
 OR EXISTS(SELECT 1 FROM card_cycles c JOIN bank_accounts a ON a.household_id=c.household_id AND a.local_account_id=c.account_id CROSS JOIN LATERAL (SELECT (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')+v*interval '1 month')::date AS month FROM generate_series(-1,1) v) months WHERE c.household_id=p.household_id AND a.active AND a.account_type='CREDIT' AND a.balance_cents>0 AND (months.month+(least(c.due_day,extract(day FROM (months.month+interval '1 month'-interval '1 day'))::int)-1))>=c.effective_due_date AND (months.month+(least(c.due_day,extract(day FROM (months.month+interval '1 month'-interval '1 day'))::int)-1)) BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-7 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date+1)) ORDER BY p.id LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING s.id,s.endpoint,s.keys`,
        [token],
      ),
    )
  ).rows;
  let sent = 0,
    failed = 0;
  await Promise.all(
    rows.map(async (s) => {
      try {
        await deliver(pair, s);
        await asUser(db, userId, (tx) =>
          tx.query(
            `UPDATE push_subscriptions SET last_sent=(now() AT TIME ZONE 'America/Sao_Paulo')::date,delivery_until=NULL,delivery_token=NULL WHERE id=$1 AND delivery_token=$2`,
            [s.id, token],
          ),
        );
        sent++;
      } catch (error) {
        failed++;
        const gone = [404, 410].includes(
          (error as { statusCode?: number }).statusCode ?? 0,
        );
        await asUser(db, userId, (tx) =>
          tx.query(
            "UPDATE push_subscriptions SET enabled=CASE WHEN $3 THEN false ELSE enabled END,delivery_token=NULL,delivery_until=NULL WHERE id=$1 AND delivery_token=$2",
            [s.id, token, gone],
          ),
        );
      }
    }),
  );
  return { sent, failed };
}
