CREATE TABLE user_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id),
 accent text NOT NULL DEFAULT '#c5ab8b' CHECK(accent ~ '^#[0-9a-fA-F]{6}$'),
 theme text NOT NULL DEFAULT 'system' CHECK(theme IN ('system','light','dark')),
 card_order jsonb NOT NULL DEFAULT '["summary","receipts","alerts","cards","income","fixed","variable","saving","categories"]'::jsonb CHECK(jsonb_typeof(card_order)='array' AND jsonb_array_length(card_order)=9),
 hidden_cards jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(hidden_cards)='array' AND jsonb_array_length(hidden_cards)<=9),
 photo bytea CHECK(octet_length(photo)<=100000),
 onboarding_completed_at timestamptz, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON user_preferences FROM PUBLIC;
CREATE POLICY own_read ON user_preferences FOR SELECT TO family_app USING(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY own_insert ON user_preferences FOR INSERT TO family_app WITH CHECK(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE POLICY own_update ON user_preferences FOR UPDATE TO family_app USING(user_id=nullif(current_setting('app.user_id',true),'')::uuid) WITH CHECK(user_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON user_preferences TO family_app;
