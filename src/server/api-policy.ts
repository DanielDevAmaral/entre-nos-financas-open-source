const reads = new Set([
  "admin/families",
  "auth/status",
  "banks",
  "investments",
  "family/month",
  "routine",
  "notifications",
  "state",
  "members",
  "export",
  "export/family",
  "profile/preferences",
  "profile/photo",
  "help/status",
  "help/conversations",
  "cron/reminders",
]);
const writes = new Set([
  "admin/families",
  "auth/setup",
  "auth/login",
  "auth/logout",
  "auth/password",
  "profile/preferences",
  "profile/onboarding",
  "help",
  "help/conversations",
  "help/conversations/open",
  "help/conversations/send",
  "help/actions",
  "cards/manual",
  "cards/cycle",
  "banks/analyze",
  "income/rule",
  "banks/credentials",
  "banks/connect",
  "banks/renew",
  "banks/map",
  "banks/pause",
  "banks/read",
  "banks/read-due",
  "banks/review",
  "routine/item",
  "routine/check",
  "routine/copy",
  "notifications/subscribe",
  "notifications/test",
  "notifications/unsubscribe",
  "accounts/prepare-openings",
  "planning/import",
  "pending/assisted",
  "pending/prepare",
  "accounts",
  "accounts/opening",
  "categories",
  "budgets",
  "events",
  "members",
  "imports/preview",
]);
export function allowedMethods(route: string): string[] {
  const methods: string[] = [];
  if (reads.has(route) || /^imports\/[a-f0-9-]{36}$/i.test(route))
    methods.push("GET");
  if (
    writes.has(route) ||
    /^imports\/[a-f0-9-]{36}\/(review|account|confirm)$/i.test(route)
  )
    methods.push("POST");
  return methods;
}
export function logSecurity(
  event:
    | "rate_limited"
    | "login_failed"
    | "login_ok"
    | "input_rejected"
    | "access_rejected"
    | "internal_error",
  requestId: string,
  status: number,
) {
  // Deliberately excludes credentials, IP, email, body, URL/query and financial data.
  console.warn(
    JSON.stringify({ event: "security." + event, requestId, status }),
  );
}
