ALTER TABLE planning_lines ADD UNIQUE(household_id,id);
CREATE TABLE monthly_items (
 id uuid PRIMARY KEY, household_id uuid NOT NULL REFERENCES households(id),
 source_line_id uuid UNIQUE, month date NOT NULL CHECK(extract(day FROM month)=1),
 label text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('expense','income','saving','card','benefit')),
 currency text NOT NULL CHECK(currency IN ('BRL','USD','EUR')), planned_cents bigint CHECK(planned_cents>=0),
 actual_reference_cents bigint, category_id uuid, due_date date,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','partial')),
 paid_cents bigint CHECK(paid_cents>=0), paid_date date, event_id uuid,
 notes text NOT NULL DEFAULT '', source_note text NOT NULL DEFAULT '', derived boolean NOT NULL DEFAULT false,
 archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(household_id,id), FOREIGN KEY(household_id,category_id) REFERENCES categories(household_id,id),
 FOREIGN KEY(household_id,event_id) REFERENCES economic_events(household_id,id),
 FOREIGN KEY(household_id,source_line_id) REFERENCES planning_lines(household_id,id),
 CHECK(due_date IS NULL OR date_trunc('month',due_date)::date=month)
);
CREATE INDEX monthly_items_period ON monthly_items(household_id,month) WHERE NOT archived;
CREATE UNIQUE INDEX monthly_item_event ON monthly_items(household_id,event_id) WHERE event_id IS NOT NULL AND NOT archived;
ALTER TABLE monthly_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_items FORCE ROW LEVEL SECURITY;
CREATE POLICY read_family ON monthly_items FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY insert_family ON monthly_items FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
CREATE POLICY update_family ON monthly_items FOR UPDATE TO family_app USING(current_member(household_id,true)) WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT,UPDATE ON monthly_items TO family_app;
INSERT INTO monthly_items(id,household_id,source_line_id,month,label,purpose,currency,planned_cents,actual_reference_cents,category_id,status,notes,source_note,derived,created_by,due_date,paid_cents)
 SELECT p.id,p.household_id,p.id,p.month,p.label,p.purpose,'BRL',CASE WHEN p.error IS NULL AND p.planned_cents>=0 THEN p.planned_cents ELSE NULL END,p.actual_cents,p.category_id,
 CASE WHEN upper(p.notes) LIKE '%METADE PAGO%' THEN 'partial' WHEN upper(p.notes) ~ '(^|[^A-Z])PAGO([^A-Z]|$)' AND upper(p.notes) NOT LIKE '%NÃO PAGO%' AND upper(p.notes) NOT LIKE '%NAO PAGO%' THEN 'done' ELSE 'open' END,
 coalesce(p.error,''),p.notes,p.derived,m.user_id,
 CASE WHEN p.notes ~ '^\d{4}-\d{2}-\d{2} 00:00:00$' AND left(p.notes,7)=to_char(p.month,'YYYY-MM') THEN left(p.notes,10)::date ELSE NULL END,
 CASE WHEN upper(p.notes) ~ '(^|[^A-Z])PAGO([^A-Z]|$)' AND upper(p.notes) NOT LIKE '%METADE%' AND upper(p.notes) NOT LIKE '%NÃO PAGO%' AND upper(p.notes) NOT LIKE '%NAO PAGO%' AND p.actual_error IS NULL AND p.actual_cents>=0 THEN p.actual_cents ELSE NULL END
 FROM planning_lines p JOIN members m ON m.household_id=p.household_id AND m.role='owner';
CREATE TABLE push_subscriptions(id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES households(id),user_id uuid NOT NULL REFERENCES users(id),endpoint text NOT NULL UNIQUE,keys jsonb NOT NULL,enabled boolean NOT NULL DEFAULT true,last_sent date,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY own_device ON push_subscriptions FOR ALL TO family_app USING(user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_member(household_id,false)) WITH CHECK(user_id=nullif(current_setting('app.user_id',true),'')::uuid AND current_member(household_id,false));
GRANT SELECT,INSERT,UPDATE ON push_subscriptions TO family_app;
CREATE INDEX push_family ON push_subscriptions(household_id) WHERE enabled;
CREATE TABLE notification_keys(id integer PRIMARY KEY CHECK(id=1),public_key text NOT NULL,private_key text NOT NULL);
REVOKE ALL ON notification_keys FROM PUBLIC,family_app;
CREATE TABLE operation_keys(household_id uuid NOT NULL REFERENCES households(id),request_id uuid NOT NULL,event_id uuid NOT NULL,PRIMARY KEY(household_id,request_id),FOREIGN KEY(household_id,event_id) REFERENCES economic_events(household_id,id));
ALTER TABLE operation_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY read_family ON operation_keys FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY insert_family ON operation_keys FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT ON operation_keys TO family_app;
CREATE TABLE merchant_rules(id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES households(id),match_text text NOT NULL,category_name text NOT NULL,note text NOT NULL DEFAULT '',UNIQUE(household_id,match_text));
ALTER TABLE merchant_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY read_family ON merchant_rules FOR SELECT TO family_app USING(current_member(household_id,false));
CREATE POLICY insert_family ON merchant_rules FOR INSERT TO family_app WITH CHECK(current_member(household_id,true));
GRANT SELECT,INSERT ON merchant_rules TO family_app;
