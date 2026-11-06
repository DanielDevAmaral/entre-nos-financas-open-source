-- Shared across serverless instances. No browser or family role has access.
CREATE TABLE security_rate_buckets (
 scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 40),
 key_hash text NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
 hits integer NOT NULL CHECK (hits > 0),
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(scope,key_hash)
);
CREATE INDEX security_rate_expiry ON security_rate_buckets(expires_at);
REVOKE ALL ON security_rate_buckets FROM PUBLIC, family_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
