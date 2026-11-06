ALTER TABLE ledger_entries ADD COLUMN transaction_date date;
UPDATE ledger_entries l SET transaction_date=e.transaction_date FROM economic_events e WHERE e.id=l.event_id;
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE ledger_entries ALTER COLUMN transaction_date SET NOT NULL;
CREATE INDEX ledger_account_date ON ledger_entries(household_id,account_id,transaction_date);
