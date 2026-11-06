-- Nullable preserves existing plans; suggestions are calculated only for display.
ALTER TABLE monthly_items ADD COLUMN cost_type text
  CHECK(cost_type IN ('fixed','variable'));
