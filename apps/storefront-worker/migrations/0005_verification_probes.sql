CREATE TABLE IF NOT EXISTS verification_probes (
  environment TEXT NOT NULL CHECK(environment IN ('before','after')),
  scenario_id TEXT NOT NULL CHECK(scenario_id = 'waf-custom'),
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  probe_id TEXT NOT NULL,
  marker TEXT NOT NULL CHECK(marker = 'synthetic-d1-probe-v1'),
  PRIMARY KEY(environment,scenario_id,run_id,request_id,probe_id)
);
