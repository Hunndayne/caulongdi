ALTER TABLE payments ADD COLUMN payer_marked_paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN payer_marked_paid_at TEXT;

UPDATE payments
SET payer_marked_paid = 1,
    payer_marked_paid_at = COALESCE(payer_marked_paid_at, paid_at)
WHERE paid = 1;
