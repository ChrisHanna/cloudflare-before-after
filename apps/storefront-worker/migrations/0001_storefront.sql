CREATE TABLE IF NOT EXISTS catalog (
  product_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail_key TEXT NOT NULL,
  image_key TEXT NOT NULL,
  content_digest TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS catalog_no_update BEFORE UPDATE ON catalog
BEGIN SELECT RAISE(ABORT, 'Catalog seeds are immutable'); END;
CREATE TRIGGER IF NOT EXISTS catalog_no_delete BEFORE DELETE ON catalog
BEGIN SELECT RAISE(ABORT, 'Catalog seeds are immutable'); END;
CREATE TABLE IF NOT EXISTS registrations (
  environment TEXT NOT NULL CHECK(environment IN ('before', 'after')),
  scenario_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK(display_name LIKE 'synthetic-%'),
  note TEXT NOT NULL,
  PRIMARY KEY (environment, scenario_id, run_id, record_id)
);
