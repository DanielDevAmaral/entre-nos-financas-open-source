CREATE TABLE planning_sources (id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES households(id),sha256 text NOT NULL,filename text NOT NULL,created_by uuid NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(household_id,sha256),UNIQUE(household_id,id));
CREATE TABLE planning_lines (id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES households(id),source_id uuid NOT NULL,month date NOT NULL,sheet text NOT NULL,cell text NOT NULL,label text NOT NULL,category_id uuid NOT NULL,purpose text NOT NULL,planned_cents bigint,actual_cents bigint,derived boolean NOT NULL,notes text NOT NULL,error text,actual_error text,formula text,UNIQUE(source_id,sheet,cell,label),FOREIGN KEY(household_id,source_id) REFERENCES planning_sources(household_id,id),FOREIGN KEY(household_id,category_id) REFERENCES categories(household_id,id));
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['planning_sources','planning_lines'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY read_family ON %I FOR SELECT TO family_app USING (current_member(household_id,false))',t);
  EXECUTE format('CREATE POLICY insert_family ON %I FOR INSERT TO family_app WITH CHECK (current_member(household_id,true))',t);
  EXECUTE format('CREATE POLICY update_family ON %I FOR UPDATE TO family_app USING (current_member(household_id,true)) WITH CHECK (current_member(household_id,true))',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO family_app',t);
 END LOOP;
END $$;
