CREATE TABLE IF NOT EXISTS producer_registry (
  producer_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK(environment IN ('before', 'after')),
  scenario_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  release_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS producer_run_scope ON producer_registry(environment, run_id, scenario_id);
