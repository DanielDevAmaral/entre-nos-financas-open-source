CREATE ROLE family_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE auth_attempts (email_hash text PRIMARY KEY, failures integer NOT NULL, blocked_until timestamptz, last_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE households (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (household_id uuid REFERENCES households(id), user_id uuid REFERENCES users(id), role text NOT NULL CHECK(role IN ('owner','editor','reader')), PRIMARY KEY(household_id,user_id));
CREATE FUNCTION current_member(family uuid, writing boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM members WHERE household_id=family AND user_id=nullif(current_setting('app.user_id',true),'')::uuid AND (NOT writing OR role IN ('owner','editor')))
$$;
REVOKE ALL ON FUNCTION current_member(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_member(uuid,boolean) TO family_app;
CREATE TABLE accounts (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), name text NOT NULL, institution text NOT NULL, currency text NOT NULL CHECK(currency IN ('BRL','USD','EUR')), kind text NOT NULL CHECK(kind IN ('checking','card','investment','benefit')), opening_cents bigint, opening_date date, created_by uuid NOT NULL REFERENCES users(id), UNIQUE(household_id,id), CHECK((opening_cents IS NULL)=(opening_date IS NULL)));
CREATE TABLE categories (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), name text NOT NULL, essential boolean NOT NULL DEFAULT false, UNIQUE(household_id,id), UNIQUE(household_id,name));
CREATE TABLE source_files (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), sha256 text NOT NULL, filename text NOT NULL, bytes integer NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(household_id,sha256), UNIQUE(household_id,id));
CREATE TABLE import_batches (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), source_id uuid NOT NULL, account_id uuid NOT NULL, status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','confirmed')), parser text NOT NULL, checks jsonb NOT NULL, warnings jsonb NOT NULL, period_start date, period_end date, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, UNIQUE(household_id,id), UNIQUE(source_id), FOREIGN KEY(household_id,source_id) REFERENCES source_files(household_id,id), FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id));
CREATE TABLE economic_events (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), account_id uuid NOT NULL, counter_account_id uuid, kind text NOT NULL CHECK(kind IN ('income','expense','transfer','card_purchase','card_payment','investment_buy','investment_sell','yield','refund','fee')), transaction_date date NOT NULL, processing_date date, due_date date, description text NOT NULL, original_description text NOT NULL, amount_cents bigint NOT NULL CHECK(amount_cents<>0), currency text NOT NULL CHECK(currency IN ('BRL','USD','EUR')), category_id uuid, related_event_id uuid, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(household_id,id), FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id), FOREIGN KEY(household_id,counter_account_id) REFERENCES accounts(household_id,id), FOREIGN KEY(household_id,category_id) REFERENCES categories(household_id,id), FOREIGN KEY(household_id,related_event_id) REFERENCES economic_events(household_id,id));
CREATE TABLE ledger_entries (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), event_id uuid NOT NULL, account_id uuid, nominal text, currency text NOT NULL, amount_cents bigint NOT NULL, CHECK((account_id IS NULL)<>(nominal IS NULL)), FOREIGN KEY(household_id,event_id) REFERENCES economic_events(household_id,id), FOREIGN KEY(household_id,account_id) REFERENCES accounts(household_id,id));
CREATE TABLE staged_transactions (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), batch_id uuid NOT NULL, ordinal integer NOT NULL, locator text NOT NULL, transaction_date date NOT NULL, processing_date date, due_date date, original_description text NOT NULL, description text NOT NULL, amount_cents bigint NOT NULL, currency text NOT NULL, bank_id text, suggested_kind text NOT NULL, confidence numeric NOT NULL, kind text, category_id uuid, counter_account_id uuid, related_event_id uuid, link_event_id uuid, decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','accept','skip','link')), reviewed boolean NOT NULL DEFAULT false, duplicate_hint boolean NOT NULL DEFAULT false, review_note text NOT NULL DEFAULT '', version integer NOT NULL DEFAULT 1, UNIQUE(household_id,id), UNIQUE(batch_id,ordinal), FOREIGN KEY(household_id,batch_id) REFERENCES import_batches(household_id,id), FOREIGN KEY(household_id,category_id) REFERENCES categories(household_id,id), FOREIGN KEY(household_id,counter_account_id) REFERENCES accounts(household_id,id), FOREIGN KEY(household_id,related_event_id) REFERENCES economic_events(household_id,id), FOREIGN KEY(household_id,link_event_id) REFERENCES economic_events(household_id,id));
CREATE TABLE event_sources (household_id uuid NOT NULL REFERENCES households(id), event_id uuid NOT NULL, staged_id uuid NOT NULL UNIQUE, FOREIGN KEY(household_id,event_id) REFERENCES economic_events(household_id,id), FOREIGN KEY(household_id,staged_id) REFERENCES staged_transactions(household_id,id));
CREATE TABLE budgets (household_id uuid NOT NULL REFERENCES households(id), category_id uuid NOT NULL, month date NOT NULL CHECK(extract(day FROM month)=1), currency text NOT NULL CHECK(currency IN ('BRL','USD','EUR')), planned_cents bigint NOT NULL CHECK(planned_cents>=0), PRIMARY KEY(household_id,category_id,month,currency), FOREIGN KEY(household_id,category_id) REFERENCES categories(household_id,id));
CREATE TABLE audit_events (id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id), actor_id uuid NOT NULL REFERENCES users(id), action text NOT NULL, entity_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX event_period ON economic_events(household_id,transaction_date);
CREATE INDEX stage_bank_id ON staged_transactions(household_id,bank_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
ALTER TABLE economic_events DROP CONSTRAINT economic_events_kind_check;
ALTER TABLE economic_events ADD CHECK(kind IN ('income','expense','transfer','card_purchase','card_payment','investment_buy','investment_sell','yield','refund','fee','fx'));
ALTER TABLE economic_events ADD COLUMN counter_currency text;
ALTER TABLE economic_events ADD COLUMN counter_amount_cents bigint;
ALTER TABLE staged_transactions ADD COLUMN counter_currency text;
ALTER TABLE staged_transactions ADD COLUMN counter_amount_cents bigint;
ALTER TABLE import_batches ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['accounts','categories','source_files','import_batches','economic_events','ledger_entries','staged_transactions','event_sources','budgets'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY read_family ON %I FOR SELECT TO family_app USING (current_member(household_id,false))',t);
  EXECUTE format('CREATE POLICY insert_family ON %I FOR INSERT TO family_app WITH CHECK (current_member(household_id,true))',t);
  EXECUTE format('CREATE POLICY update_family ON %I FOR UPDATE TO family_app USING (current_member(household_id,true)) WITH CHECK (current_member(household_id,true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO family_app',t);
 END LOOP;
END $$;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY read_audit ON audit_events FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY insert_audit ON audit_events FOR INSERT TO family_app WITH CHECK(current_member(household_id,true) AND actor_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT ON audit_events TO family_app;
CREATE FUNCTION check_balanced_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; count_entries integer; BEGIN
 IF TG_TABLE_NAME='economic_events' THEN target := NEW.id; ELSE target := NEW.event_id; END IF;
 SELECT count(*) INTO count_entries FROM ledger_entries WHERE event_id=target;
 IF count_entries<2 OR EXISTS(SELECT 1 FROM ledger_entries WHERE event_id=target GROUP BY currency HAVING sum(amount_cents)<>0) OR EXISTS(SELECT 1 FROM ledger_entries l JOIN economic_events e ON e.id=l.event_id WHERE l.event_id=target AND l.currency<>e.currency AND e.kind<>'fx') THEN
   RAISE EXCEPTION 'Evento contábil não balanceado';
 END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER balanced_event AFTER INSERT OR UPDATE ON economic_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_event();
CREATE CONSTRAINT TRIGGER balanced_entry AFTER INSERT OR UPDATE ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_balanced_event();
