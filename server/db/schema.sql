-- Rewind — Neon Postgres schema.
--
-- STATUS: applied to Neon (PostgreSQL 18.6) for production on 2026-09-14, and applied by
-- `server/db/postgres.integration.test.ts` to an embedded Postgres on every test run. One later
-- change reached Neon as a migration rather than a re-run of this file (2026-09-15, PR #6):
-- `refund_executions_refund_to_not_self` was replaced by
-- `refund_executions_treasury_refund_not_self`. Keep the two in step by hand.
--
-- The constraints below are not decoration. They are where the money safety actually lives:
-- the application deliberately races into them and handles the violation, because a unique
-- index is the only thing that settles a race correctly.

BEGIN;

-- ---------------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchants (
  id                    TEXT PRIMARY KEY,
  name                  TEXT        NOT NULL,
  address               TEXT        NOT NULL,
  -- Only the built-in Demo Store may draw on the capped server treasury.
  allow_treasury_refund BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  state                 TEXT        NOT NULL,
  merchant_id           TEXT        NOT NULL REFERENCES merchants (id),
  -- Snapshotted at creation so editing a merchant cannot rewrite a past order.
  merchant_address      TEXT        NOT NULL,
  item_label            TEXT        NOT NULL,
  amount_luna           BIGINT      NOT NULL CHECK (amount_luna > 0),
  network_id            TEXT        NOT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,

  -- Set only from a verified chain record.
  payment_tx_hash       TEXT,
  payer_address         TEXT,
  paid_at               TIMESTAMPTZ,
  payment_block_number  BIGINT,

  -- Unverified hint from the wallet. Never a source of truth.
  claimed_payment_tx_hash TEXT,

  refund_source         TEXT        NOT NULL CHECK (refund_source IN ('MERCHANT_WALLET', 'DEMO_TREASURY')),
  refunder_address      TEXT        NOT NULL,
  last_error            TEXT,

  CONSTRAINT orders_state_check CHECK (state IN (
    'CREATED', 'PAYMENT_PENDING', 'PAID', 'REFUND_REQUESTED', 'REFUND_APPROVED',
    'REFUND_BROADCAST', 'REFUNDED', 'REFUND_FAILED', 'REJECTED', 'EXPIRED'
  )),
  -- A refund to the payer must not be a self-transfer; the protocol refuses those.
  CONSTRAINT orders_payer_not_refunder CHECK (
    payer_address IS NULL OR payer_address <> refunder_address
  ),
  -- Once paid, both facts must be present together.
  CONSTRAINT orders_payment_complete CHECK (
    (payment_tx_hash IS NULL AND payer_address IS NULL)
    OR (payment_tx_hash IS NOT NULL AND payer_address IS NOT NULL)
  )
);

-- One order per verified direct payment. This is the constraint that stops the same
-- payment being claimed by two orders and refunded twice.
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_tx_hash_key
  ON orders (payment_tx_hash) WHERE payment_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_state_idx ON orders (state);
CREATE INDEX IF NOT EXISTS orders_payer_idx ON orders (payer_address);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at DESC);

-- ---------------------------------------------------------------------------
-- refund_challenges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_challenges (
  -- The nonce IS the primary key, so replay is refused by the index, not by a lookup.
  nonce                 TEXT PRIMARY KEY,
  order_id              TEXT        NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  -- The exact bytes the buyer signed. Stored verbatim; never re-derived for comparison.
  message               TEXT        NOT NULL,
  refund_to             TEXT        NOT NULL,
  amount_luna           BIGINT      NOT NULL CHECK (amount_luna > 0),
  payment_tx_hash       TEXT        NOT NULL,
  expires_at_sec        BIGINT      NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  consumed_at           TIMESTAMPTZ,
  signature_public_key  TEXT,
  signature_hex         TEXT,
  signer_address        TEXT,

  CONSTRAINT refund_challenges_consumed_complete CHECK (
    consumed_at IS NULL
    OR (signature_public_key IS NOT NULL AND signature_hex IS NOT NULL AND signer_address IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS refund_challenges_order_idx ON refund_challenges (order_id, created_at DESC);
-- At most one consumed (i.e. successfully signed) challenge per order.
CREATE UNIQUE INDEX IF NOT EXISTS refund_challenges_one_consumed_per_order
  ON refund_challenges (order_id) WHERE consumed_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- refund_executions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refund_executions (
  id                    TEXT PRIMARY KEY,
  -- THE constraint. One refund obligation per order, decided by Postgres under concurrency.
  order_id              TEXT        NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
  challenge_nonce       TEXT        NOT NULL REFERENCES refund_challenges (nonce),
  refund_to             TEXT        NOT NULL,
  amount_luna           BIGINT      NOT NULL CHECK (amount_luna > 0),
  refunder_address      TEXT        NOT NULL,
  source                TEXT        NOT NULL CHECK (source IN ('MERCHANT_WALLET', 'DEMO_TREASURY')),

  -- Written BEFORE the broadcast. A crash mid-send leaves the exact bytes behind.
  intended_tx_hash      TEXT,
  serialized_tx         TEXT,
  validity_start_height BIGINT,
  prepared_at           TIMESTAMPTZ,
  broadcast_at          TIMESTAMPTZ,

  -- Written only from a verified chain record.
  refund_tx_hash        TEXT,
  refund_block_number   BIGINT,
  confirmed_at          TIMESTAMPTZ,

  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The treasury signs from its own address, and the protocol refuses a transfer to oneself.
  -- A shop's refund leaves through its Nimiq Pay HTLC, so a shop may refund its own wallet.
  CONSTRAINT refund_executions_treasury_refund_not_self CHECK (
    source = 'MERCHANT_WALLET' OR refund_to <> refunder_address
  ),
  CONSTRAINT refund_executions_confirmed_needs_hash CHECK (
    confirmed_at IS NULL OR refund_tx_hash IS NOT NULL
  ),
  -- A confirmed refund cannot also be a failed one.
  CONSTRAINT refund_executions_not_both CHECK (
    confirmed_at IS NULL OR failure_reason IS NULL
  )
);

-- The same refund transaction may never settle two orders.
CREATE UNIQUE INDEX IF NOT EXISTS refund_executions_refund_tx_hash_key
  ON refund_executions (refund_tx_hash) WHERE refund_tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS refund_executions_intended_tx_hash_key
  ON refund_executions (intended_tx_hash) WHERE intended_tx_hash IS NOT NULL;
-- The recovery worklist: prepared or broadcast, never settled.
CREATE INDEX IF NOT EXISTS refund_executions_unsettled_idx
  ON refund_executions (created_at) WHERE confirmed_at IS NULL AND failure_reason IS NULL;

-- ---------------------------------------------------------------------------
-- merchant_nonces — one row per issued merchant challenge (closes gap S3)
--
-- The merchant challenge used to be stateless, so the same signed text could be replayed
-- inside its validity window. Now the server records the challenge when it issues it and
-- consumes the row when it accepts the signature, so a second presentation of the same
-- bytes finds a consumed row and is refused.
--
-- `nonce` is the SHA-256 of `message`. The canonical challenge text is unchanged; the digest
-- of those exact bytes is the key, and the verifier recomputes it from what it was handed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS merchant_nonces (
  nonce                 TEXT PRIMARY KEY,
  merchant_id           TEXT        NOT NULL REFERENCES merchants (id),
  merchant_address      TEXT        NOT NULL,
  -- Neon's copy of this CHECK still allows 'record-tx', an action removed on 2026-09-15; a looser
  -- CHECK is harmless, so no migration was run.
  action                TEXT        NOT NULL CHECK (action IN ('approve', 'reject', 'list')),
  -- The order the challenge is bound to. A 'list' challenge is bound to no order and uses
  -- the all-zero sentinel, which is shape-valid and which no generated order id will be.
  order_id              TEXT        NOT NULL,
  message               TEXT        NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at_sec        BIGINT      NOT NULL,
  consumed_at           TIMESTAMPTZ,
  signer_address        TEXT,

  CONSTRAINT merchant_nonces_consumed_complete CHECK (
    consumed_at IS NULL OR signer_address IS NOT NULL
  )
);

-- Housekeeping scan, and the merchant board's own lookups.
CREATE INDEX IF NOT EXISTS merchant_nonces_expiry_idx ON merchant_nonces (expires_at_sec);
CREATE INDEX IF NOT EXISTS merchant_nonces_merchant_idx ON merchant_nonces (merchant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- demo_refunds — the treasury ledger the caps are computed from
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_refunds (
  id                    TEXT PRIMARY KEY,
  -- One ledger row per order, so a retry can never be counted, or spent, twice.
  order_id              TEXT        NOT NULL UNIQUE REFERENCES orders (id) ON DELETE CASCADE,
  wallet_address        TEXT        NOT NULL,
  amount_luna           BIGINT      NOT NULL CHECK (amount_luna > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per wallet, per rolling window.
CREATE INDEX IF NOT EXISTS demo_refunds_wallet_idx ON demo_refunds (wallet_address, created_at DESC);
-- Global hourly.
CREATE INDEX IF NOT EXISTS demo_refunds_created_idx ON demo_refunds (created_at DESC);

-- ---------------------------------------------------------------------------
-- merchants are not seeded here. The Demo Store row is inserted once per database with the
-- treasury's own address and allow_treasury_refund TRUE (id 'demo-store'); every other
-- merchant is created by a wallet signature through POST /api/merchant/register.
-- ---------------------------------------------------------------------------

COMMIT;
