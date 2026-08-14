-- nightbell control plane schema.
--
-- The media server is stateless and disposable; everything that must survive a
-- deploy lives here. Two things drive the design:
--
--   1. A call record is written once, at the end of the call, and read many
--      times afterwards. Writes are rare and reads are dashboard queries, so
--      indexes favour reads.
--
--   2. The transcript is the product. Contractors do not trust an agent they
--      cannot audit, and the fastest way to lose an account is to book a job
--      the owner cannot reconstruct. So the full transcript and the triage
--      reasoning are stored verbatim rather than summarised.

CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,
  business_name   TEXT NOT NULL,
  service_area    TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'America/Chicago',
  -- The number callers dial. One per tenant for now; a second row per tenant
  -- would let a contractor run separate day and night numbers.
  phone_number    TEXT NOT NULL UNIQUE,
  -- Where an emergency page goes. The single most safety-critical field in the
  -- system, and the one contractors change most often.
  on_call_number  TEXT NOT NULL,
  greeting        TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tenants_phone ON tenants(phone_number) WHERE active = 1;

CREATE TABLE calls (
  call_sid        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  from_number     TEXT,
  -- booked | transferred | abandoned | in_progress
  outcome         TEXT NOT NULL,
  -- routine | priority | dispatch_now | transfer_human
  urgency         TEXT NOT NULL,
  -- cat1 | cat2 | cat3, when triage identified one
  water_category  TEXT,
  -- Full turn-by-turn transcript, as JSON.
  transcript      TEXT NOT NULL,
  -- Collected intake fields, as JSON.
  collected       TEXT NOT NULL,
  -- Which triage rules fired and why. Kept so an escalation is always
  -- explainable after the fact rather than a black box.
  triage_hits     TEXT NOT NULL,
  -- Time-to-first-audio per turn, as JSON. Feeds docs/latency.md.
  latencies_ms    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_calls_tenant_time ON calls(tenant_id, started_at DESC);
CREATE INDEX idx_calls_urgency ON calls(tenant_id, urgency, started_at DESC);
CREATE INDEX idx_calls_outcome ON calls(tenant_id, outcome, started_at DESC);

-- A booked job, denormalised out of the call for the crew's benefit.
--
-- Separate from `calls` because its lifecycle is different: a job gets
-- rescheduled, assigned, and completed long after the call ended, and a
-- contractor's office edits it directly.
CREATE TABLE jobs (
  id                TEXT PRIMARY KEY,
  call_sid          TEXT NOT NULL REFERENCES calls(call_sid),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  caller_name       TEXT NOT NULL,
  callback_number   TEXT NOT NULL,
  property_address  TEXT NOT NULL,
  property_type     TEXT,
  urgency           TEXT NOT NULL,
  water_category    TEXT,
  situation         TEXT,
  source            TEXT,
  affected_areas    TEXT,
  insurance_carrier TEXT,
  claim_number      TEXT,
  -- scheduled | dispatched | complete | cancelled
  status            TEXT NOT NULL DEFAULT 'scheduled',
  scheduled_for     TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_tenant_status ON jobs(tenant_id, status, created_at DESC);
