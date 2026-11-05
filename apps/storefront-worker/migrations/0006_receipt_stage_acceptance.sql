/* Trusted acceptance is separate from container-reported payload time.
   Legacy receipts have no row here and therefore no trusted time.
   CREATE IF NOT EXISTS preserves bounded migration replay idempotence. */
CREATE TABLE IF NOT EXISTS origin_receipt_acceptance (
  receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES origin_receipts(receipt_id),
  payload_digest TEXT NOT NULL CHECK(length(payload_digest) = 64),
  accepted_at TEXT NOT NULL
);
