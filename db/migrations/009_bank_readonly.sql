CREATE TABLE bank_credentials (
 household_id uuid NOT NULL, user_id uuid NOT NULL, sealed text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(household_id,user_id),
 FOREIGN KEY(household_id,user_id) REFERENCES members(household_id,user_id)
);
CREATE TABLE bank_connections (
 id uuid PRIMARY KEY, household_id uuid NOT NULL, user_id uuid NOT NULL,
 item_id uuid NOT NULL UNIQUE, label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 owner_label text NOT NULL, start_date date NOT NULL, enabled boolean NOT NULL DEFAULT true,
 provider_status text NOT NULL DEFAULT 'UNKNOWN', consent_expires_at timestamptz,
 provider_updated_at timestamptz, last_read_at timestamptz, last_attempt_at timestamptz,
 lease_until timestamptz, lease_token uuid, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(household_id,id),
 FOREIGN KEY(household_id,user_id) REFERENCES bank_credentials(household_id,user_id)
);
CREATE INDEX bank_connections_owner ON bank_connections(user_id,household_id);
CREATE TABLE bank_accounts (
 id uuid PRIMARY KEY, household_id uuid NOT NULL, connection_id uuid NOT NULL,
 remote_id uuid NOT NULL, label text NOT NULL, last_four text NOT NULL DEFAULT '',
 currency text NOT NULL, account_type text NOT NULL CHECK(account_type IN ('BANK','CREDIT')),
 active boolean NOT NULL DEFAULT true, local_account_id uuid, balance_cents bigint, read_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(connection_id,remote_id), UNIQUE(household_id,id), UNIQUE(household_id,id,local_account_id),
 FOREIGN KEY(household_id,connection_id) REFERENCES bank_connections(household_id,id),
 FOREIGN KEY(household_id,local_account_id) REFERENCES accounts(household_id,id)
);
CREATE UNIQUE INDEX bank_accounts_mapping ON bank_accounts(household_id,local_account_id) WHERE local_account_id IS NOT NULL;
CREATE TABLE bank_transactions (
 id uuid PRIMARY KEY, household_id uuid NOT NULL, bank_account_id uuid NOT NULL,
 local_account_id uuid NOT NULL, remote_id text NOT NULL CHECK(length(remote_id) BETWEEN 1 AND 200),
 provider_id text, transaction_date date NOT NULL, description text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents<>0), currency text NOT NULL CHECK(currency='BRL'),
 provider_status text NOT NULL, operation_type text NOT NULL DEFAULT '',
 payload_hash text NOT NULL, latest_snapshot jsonb, changed boolean NOT NULL DEFAULT false,
 missing boolean NOT NULL DEFAULT false, last_seen_run uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','linked','recorded','ignored')),
 event_id uuid, duplicate_of uuid, review_note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(bank_account_id,remote_id), UNIQUE(household_id,id),
 FOREIGN KEY(household_id,duplicate_of) REFERENCES bank_transactions(household_id,id),
 FOREIGN KEY(household_id,bank_account_id,local_account_id) REFERENCES bank_accounts(household_id,id,local_account_id),
 FOREIGN KEY(household_id,event_id) REFERENCES economic_events(household_id,id),
 CHECK((status IN ('linked','recorded'))=(event_id IS NOT NULL))
);
CREATE INDEX bank_transactions_pending ON bank_transactions(household_id,status,transaction_date DESC);
CREATE INDEX bank_transactions_event ON bank_transactions(household_id,event_id) WHERE event_id IS NOT NULL;
CREATE INDEX bank_transactions_provider ON bank_transactions(household_id,local_account_id,provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX bank_accounts_connection ON bank_accounts(household_id,connection_id);
CREATE INDEX bank_transactions_account ON bank_transactions(household_id,bank_account_id);
CREATE UNIQUE INDEX bank_event_evidence ON bank_transactions(bank_account_id,event_id) WHERE event_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bank_credentials','bank_connections','bank_accounts','bank_transactions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 END LOOP;
END $$;
CREATE POLICY own_credentials ON bank_credentials FOR ALL TO family_app
 USING(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true))
 WITH CHECK(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true));
CREATE POLICY read_connections ON bank_connections FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY insert_connections ON bank_connections FOR INSERT TO family_app WITH CHECK(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true));
CREATE POLICY update_connections ON bank_connections FOR UPDATE TO family_app
 USING(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true))
 WITH CHECK(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true));
CREATE POLICY read_accounts ON bank_accounts FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY write_accounts ON bank_accounts FOR INSERT TO family_app WITH CHECK(current_member(household_id,true) AND EXISTS(SELECT 1 FROM bank_connections c WHERE c.id=connection_id AND c.user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid)));
CREATE POLICY update_accounts ON bank_accounts FOR UPDATE TO family_app USING(current_member(household_id,true) AND EXISTS(SELECT 1 FROM bank_connections c WHERE c.id=connection_id AND c.user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid))) WITH CHECK(current_member(household_id,true) AND EXISTS(SELECT 1 FROM bank_connections c WHERE c.id=connection_id AND c.user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid)));
CREATE POLICY read_transactions ON bank_transactions FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY insert_transactions ON bank_transactions FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
CREATE POLICY update_transactions ON bank_transactions FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT,UPDATE ON bank_credentials,bank_connections,bank_accounts,bank_transactions TO family_app;

CREATE INDEX bank_transactions_duplicate ON bank_transactions(household_id,duplicate_of) WHERE duplicate_of IS NOT NULL;
