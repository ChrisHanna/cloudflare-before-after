CREATE TABLE IF NOT EXISTS turnstile_claims (
  token_digest TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS turnstile_verifications (
  request_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK(environment IN ('before','after')),
  scenario_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turnstile_verifications_scope ON turnstile_verifications(environment,scenario_id,run_id);
