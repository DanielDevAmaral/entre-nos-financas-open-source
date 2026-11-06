CREATE TABLE manual_card_settings (
 household_id uuid NOT NULL,account_id uuid NOT NULL,limit_cents bigint CHECK(limit_cents>=0),
 updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,account_id),
 FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id),
 FOREIGN KEY(household_id,updated_by) REFERENCES members(household_id,user_id)
);
CREATE TABLE manual_card_bills (
 household_id uuid NOT NULL,account_id uuid NOT NULL,month date NOT NULL CHECK(extract(day FROM month)=1),
 amount_cents bigint NOT NULL CHECK(amount_cents>=0),due_date date NOT NULL,
 paid boolean NOT NULL DEFAULT false,updated_by uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,account_id,month),
 FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id),
 FOREIGN KEY(household_id,updated_by) REFERENCES members(household_id,user_id),
 CHECK(date_trunc('month',due_date)::date=month)
);
ALTER TABLE manual_card_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_card_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE manual_card_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_card_bills FORCE ROW LEVEL SECURITY;
REVOKE ALL ON manual_card_settings,manual_card_bills FROM PUBLIC;
CREATE POLICY family_read ON manual_card_settings FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY family_insert ON manual_card_settings FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
CREATE POLICY family_update ON manual_card_settings FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true));
CREATE POLICY family_read ON manual_card_bills FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY family_insert ON manual_card_bills FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
CREATE POLICY family_update ON manual_card_bills FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT,UPDATE ON manual_card_settings,manual_card_bills TO family_app;
CREATE INDEX manual_card_due_open ON manual_card_bills(due_date,household_id) WHERE NOT paid AND amount_cents>0;
