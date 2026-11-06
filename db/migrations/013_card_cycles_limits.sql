CREATE TABLE card_cycles (
 household_id uuid NOT NULL,account_id uuid NOT NULL,
 closing_day integer NOT NULL CHECK(closing_day BETWEEN 1 AND 31),
 due_day integer NOT NULL CHECK(due_day BETWEEN 1 AND 31),
 due_month_offset integer NOT NULL CHECK(due_month_offset IN (0,1)),
 effective_close_date date NOT NULL,effective_due_date date NOT NULL,
 created_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,account_id),
 FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id),
 FOREIGN KEY(household_id,created_by) REFERENCES members(household_id,user_id),
 CHECK(effective_due_date>effective_close_date),
 CHECK(extract(day FROM effective_close_date)=closing_day AND extract(day FROM effective_due_date)=due_day)
);
ALTER TABLE card_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_cycles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON card_cycles FROM PUBLIC;
CREATE POLICY family_read ON card_cycles FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY family_insert ON card_cycles FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
CREATE POLICY family_update ON card_cycles FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT,UPDATE ON card_cycles TO family_app;
ALTER TABLE bank_accounts ADD COLUMN credit_limit_cents bigint CHECK(credit_limit_cents>=0),ADD COLUMN available_credit_cents bigint CHECK(available_credit_cents>=0),ADD COLUMN credit_limits_review boolean NOT NULL DEFAULT false,ADD COLUMN credit_limits_evidence jsonb NOT NULL DEFAULT '{}';
