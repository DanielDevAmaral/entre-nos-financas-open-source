ALTER TABLE staged_transactions ADD COLUMN fingerprint text;
CREATE INDEX stage_fingerprint ON staged_transactions(household_id,fingerprint);
