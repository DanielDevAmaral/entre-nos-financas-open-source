ALTER TABLE chat_actions ADD UNIQUE(household_id,user_id,id);
CREATE TABLE chat_conversations (
 id uuid PRIMARY KEY,
 household_id uuid NOT NULL REFERENCES households(id),
 user_id uuid NOT NULL REFERENCES users(id),
 month date NOT NULL CHECK(extract(day FROM month)=1),
 currency text NOT NULL CHECK(currency IN ('BRL','USD','EUR')),
 title text NOT NULL DEFAULT 'Nova conversa' CHECK(length(title) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 opened_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(household_id,user_id,id)
);
CREATE INDEX chat_conversations_recent ON chat_conversations(user_id,household_id,opened_at DESC,id DESC);
CREATE TABLE chat_turns (
 id uuid PRIMARY KEY,
 household_id uuid NOT NULL,
 user_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal>0),
 question text NOT NULL CHECK(length(question) BETWEEN 3 AND 600),
 external boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','failed')),
 answer text CHECK(length(answer)<=8000),
 source text, coverage text, action_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 UNIQUE(conversation_id,ordinal),
 FOREIGN KEY(household_id,user_id,conversation_id) REFERENCES chat_conversations(household_id,user_id,id),
 FOREIGN KEY(household_id,user_id,action_id) REFERENCES chat_actions(household_id,user_id,id)
);
CREATE UNIQUE INDEX chat_turns_pending ON chat_turns(conversation_id) WHERE status='pending';
CREATE INDEX chat_turns_owner ON chat_turns(user_id,household_id,conversation_id);
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY own_history ON chat_conversations FOR ALL TO family_app
 USING(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,false))
 WITH CHECK(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,false));
CREATE POLICY own_history ON chat_turns FOR ALL TO family_app
 USING(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,false))
 WITH CHECK(user_id=(SELECT nullif(current_setting('app.user_id',true),'')::uuid) AND current_member(household_id,false));
REVOKE ALL ON chat_conversations,chat_turns FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON chat_conversations,chat_turns TO family_app;
