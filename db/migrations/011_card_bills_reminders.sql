ALTER TABLE bank_accounts ADD COLUMN credit_due_date date, ADD COLUMN credit_close_date date, ADD COLUMN bills_read_at timestamptz, ADD COLUMN bills_read_ok boolean;
ALTER TABLE bank_transactions ADD COLUMN card_meta jsonb NOT NULL DEFAULT '{}';
CREATE TABLE bank_card_bills (
 id uuid PRIMARY KEY,household_id uuid NOT NULL,bank_account_id uuid NOT NULL,remote_id uuid NOT NULL,
 due_date date NOT NULL,close_date date,total_cents bigint NOT NULL CHECK(total_cents>=0),
 currency text NOT NULL CHECK(currency='BRL'),charges_cents bigint NOT NULL CHECK(charges_cents>=0),
 payments jsonb NOT NULL DEFAULT '[]',read_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bank_account_id,remote_id),UNIQUE(household_id,id),
 FOREIGN KEY(household_id,bank_account_id) REFERENCES bank_accounts(household_id,id)
);
CREATE INDEX bank_card_bills_period ON bank_card_bills(household_id,due_date,bank_account_id);
ALTER TABLE bank_card_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_card_bills FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bank_card_bills FROM PUBLIC;
CREATE POLICY family_read ON bank_card_bills FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY family_insert ON bank_card_bills FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
CREATE POLICY family_update ON bank_card_bills FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT,UPDATE ON bank_card_bills TO family_app;
ALTER TABLE push_subscriptions ADD COLUMN last_test_at timestamptz,ADD COLUMN delivery_token uuid,ADD COLUMN delivery_until timestamptz;
