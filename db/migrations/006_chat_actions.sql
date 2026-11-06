CREATE TABLE chat_actions (
 id uuid PRIMARY KEY,
 household_id uuid NOT NULL REFERENCES households(id),
 user_id uuid NOT NULL REFERENCES users(id),
 payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE INDEX chat_actions_owner ON chat_actions(user_id,household_id,created_at);
ALTER TABLE chat_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY own_actions ON chat_actions FOR ALL TO family_app
 USING(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true))
 WITH CHECK(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,true));
REVOKE ALL ON chat_actions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON chat_actions TO family_app;
