/** Extract an identifier only; never fetch or navigate to a pasted URL. */
export function pluggyItemId(raw: string): string {
  const value = raw.trim();
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuid.test(value)) return value.toLowerCase();
  if (value.length <= 2048) {
    try {
      const url = new URL(value);
      const ids = url.searchParams.getAll("itemId");
      if (
        url.protocol === "https:" &&
        url.hostname === "dashboard.pluggy.ai" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.hash &&
        ids.length === 1 &&
        uuid.test(ids[0])
      )
        return ids[0].toLowerCase();
    } catch {
      /* Show the same non-sensitive guidance for any invalid input. */
    }
  }
  throw new Error(
    "Cole o itemId ou o link da conexão no painel dashboard.pluggy.ai que contém itemId.",
  );
}

/** Resume from persisted state, considering only the signed-in person's banks. */
export function bankSetupStage(data: {
  hasCredentials: boolean;
  connections: { id: string; own: boolean; enabled: boolean }[];
  accounts: {
    connection_id: string;
    currency: string;
    local_account_id: string | null;
  }[];
}): number {
  if (!data.hasCredentials) return 1;
  const own = new Set(
    data.connections.filter((c) => c.own && c.enabled).map((c) => c.id),
  );
  if (!own.size) return 3;
  if (
    !data.accounts.some((a) => own.has(a.connection_id) && a.currency === "BRL")
  )
    return 4;
  if (
    data.accounts.some(
      (a) =>
        own.has(a.connection_id) && a.currency === "BRL" && !a.local_account_id,
    )
  )
    return 4;
  return 5;
}
