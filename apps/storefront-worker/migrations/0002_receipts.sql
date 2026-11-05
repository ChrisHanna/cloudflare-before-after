CREATE TABLE IF NOT EXISTS origin_receipts (
  receipt_id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  environment TEXT NOT NULL CHECK(environment IN ('before', 'after')),
  scenario_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('entry', 'completion')),
  observed_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(producer_id, sequence),
  UNIQUE(producer_id, run_id, request_id, stage)
);
CREATE INDEX IF NOT EXISTS receipt_run_scope ON origin_receipts(environment, scenario_id, run_id, observed_at);
CREATE TABLE IF NOT EXISTS producer_checkpoints (
  producer_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  last_attempted_sequence INTEGER NOT NULL CHECK(last_attempted_sequence >= 0),
  healthy INTEGER NOT NULL CHECK(healthy IN (0, 1)),
  watermark TEXT NOT NULL
);
