DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='family_runtime') THEN
  CREATE ROLE family_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO family_runtime;
GRANT family_app TO family_runtime WITH INHERIT FALSE, SET TRUE;
GRANT SELECT ON schema_migrations TO family_runtime;
GRANT SELECT,INSERT,UPDATE ON users TO family_runtime;
GRANT SELECT,INSERT ON households,members TO family_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON sessions,auth_attempts,security_rate_buckets TO family_runtime;
GRANT SELECT,INSERT ON notification_keys TO family_runtime;
CREATE TABLE platform_administrators(user_id uuid PRIMARY KEY REFERENCES users(id));
REVOKE ALL ON platform_administrators FROM PUBLIC,family_app;
GRANT SELECT ON platform_administrators TO family_runtime;
CREATE TABLE administered_families(
 household_id uuid PRIMARY KEY REFERENCES households(id),
 created_by uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON administered_families FROM PUBLIC,family_app;
GRANT SELECT,INSERT ON administered_families TO family_runtime;
