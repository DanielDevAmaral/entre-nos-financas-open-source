ALTER TABLE bank_transactions ADD COLUMN analysis jsonb NOT NULL DEFAULT '{}', ADD COLUMN analyzed_at timestamptz;
CREATE INDEX bank_analysis_groups ON bank_transactions(household_id,(analysis->>'group'),transaction_date DESC);
CREATE TABLE income_rules (
 id uuid PRIMARY KEY, household_id uuid NOT NULL, account_id uuid NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 180), match_text text NOT NULL CHECK(length(match_text) BETWEEN 3 AND 120),
 day integer NOT NULL CHECK(day BETWEEN 1 AND 28), expected_cents bigint NOT NULL CHECK(expected_cents>0),
 effective_month date NOT NULL CHECK(extract(day FROM effective_month)=1), enabled boolean NOT NULL DEFAULT true,
 receipt_mode text NOT NULL DEFAULT 'fixed' CHECK(receipt_mode IN ('fixed','business_window')),
 budget_offset integer NOT NULL DEFAULT 1 CHECK(budget_offset IN (0,1)),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(household_id,id), UNIQUE(household_id,account_id,match_text),
 FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id),
 FOREIGN KEY(household_id,created_by) REFERENCES members(household_id,user_id)
);
CREATE TABLE income_occurrences (
 id uuid PRIMARY KEY, household_id uuid NOT NULL, rule_id uuid NOT NULL, pay_month date NOT NULL,
 expected_date date NOT NULL, budget_month date NOT NULL, monthly_item_id uuid NOT NULL,
 bank_transaction_id uuid, state text NOT NULL CHECK(state IN ('planned','detected','review')),
 note text NOT NULL DEFAULT '', UNIQUE(rule_id,pay_month), UNIQUE(household_id,monthly_item_id),
 FOREIGN KEY(household_id,rule_id) REFERENCES income_rules(household_id,id),
 FOREIGN KEY(household_id,monthly_item_id) REFERENCES monthly_items(household_id,id),
 FOREIGN KEY(household_id,bank_transaction_id) REFERENCES bank_transactions(household_id,id)
);
CREATE INDEX income_rules_account ON income_rules(household_id,account_id);
CREATE INDEX income_occurrences_bank ON income_occurrences(household_id,bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['income_rules','income_occurrences'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 EXECUTE format('CREATE POLICY family_read ON %I FOR SELECT TO family_app USING(current_member(household_id,false))',t);
 EXECUTE format('CREATE POLICY family_insert ON %I FOR INSERT TO family_app WITH CHECK(current_member(household_id,true))',t);
 EXECUTE format('CREATE POLICY family_update ON %I FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true))',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO family_app',t);
 END LOOP;
END $$;
