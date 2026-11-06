export type ReminderItem = {
  id: string;
  label: string;
  purpose: string;
  status: string;
  due_date: string | null;
  planned_cents: string | null;
  paid_cents: string | null;
};
export function paymentReminders(items: ReminderItem[], today: string) {
  const unpaid = items.filter(
    (i) =>
      ["expense", "card", "benefit"].includes(i.purpose) && i.status !== "done",
  );
  const dated = unpaid
    .filter((i) => i.due_date)
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!));
  return {
    missingDates: unpaid.filter((i) => !i.due_date),
    dated: dated.map((i) => ({
      ...i,
      urgency:
        i.due_date! < today
          ? "overdue"
          : i.due_date === today
            ? "today"
            : "upcoming",
      remaining_cents: (BigInt(i.planned_cents ?? "0") >
      BigInt(i.paid_cents ?? "0")
        ? BigInt(i.planned_cents ?? "0") - BigInt(i.paid_cents ?? "0")
        : 0n
      ).toString(),
    })),
  };
}
