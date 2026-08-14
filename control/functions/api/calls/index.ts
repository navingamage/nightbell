/**
 * Call record ingestion and listing.
 *
 * POST is written by the media server when a call ends. It is idempotent on
 * call_sid, because the media server retries on failure and a dropped socket
 * can produce a second close — booking the same job twice because a network
 * blip caused a retry would be a genuinely expensive bug.
 *
 * GET backs the owner's dashboard.
 */

import { type Env, json, requireServiceToken } from "../../lib/auth.js";

interface IncomingCall {
  callSid: string;
  tenantId: string;
  startedAt: string;
  endedAt?: string;
  fromNumber?: string;
  outcome: string;
  transcript: Array<{ speaker: string; text: string; at: number }>;
  collected: Record<string, unknown>;
  triage: {
    urgency: string;
    category?: string;
    hits: Array<{ ruleId: string; reason: string; evidence: string }>;
  };
  turnLatenciesMs?: number[];
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const unauthorized = requireServiceToken(request, env);
  if (unauthorized) return unauthorized;

  let body: IncomingCall;
  try {
    body = await request.json<IncomingCall>();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  if (!body.callSid || !body.tenantId) {
    return json({ error: "callSid and tenantId are required" }, 400);
  }

  const statements = [
    // ON CONFLICT rather than INSERT OR IGNORE: a retry after a partial write
    // should correct the record, not silently keep the older one.
    env.DB.prepare(
      `INSERT INTO calls (
         call_sid, tenant_id, started_at, ended_at, from_number, outcome,
         urgency, water_category, transcript, collected, triage_hits, latencies_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(call_sid) DO UPDATE SET
         ended_at = excluded.ended_at,
         outcome = excluded.outcome,
         urgency = excluded.urgency,
         water_category = excluded.water_category,
         transcript = excluded.transcript,
         collected = excluded.collected,
         triage_hits = excluded.triage_hits,
         latencies_ms = excluded.latencies_ms`,
    ).bind(
      body.callSid,
      body.tenantId,
      body.startedAt,
      body.endedAt ?? null,
      body.fromNumber ?? null,
      body.outcome,
      body.triage?.urgency ?? "routine",
      body.triage?.category ?? null,
      JSON.stringify(body.transcript ?? []),
      JSON.stringify(body.collected ?? {}),
      JSON.stringify(body.triage?.hits ?? []),
      JSON.stringify(body.turnLatenciesMs ?? []),
    ),
  ];

  // A booked call also produces a job row, so the crew has a ticket rather than
  // a transcript to read. Same idempotency argument as above.
  if (body.outcome === "booked") {
    const c = body.collected ?? {};
    statements.push(
      env.DB.prepare(
        `INSERT INTO jobs (
           id, call_sid, tenant_id, caller_name, callback_number, property_address,
           property_type, urgency, water_category, situation, source, affected_areas,
           insurance_carrier, claim_number
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).bind(
        `job_${body.callSid}`,
        body.callSid,
        body.tenantId,
        String(c["caller_name"] ?? ""),
        String(c["callback_number"] ?? ""),
        String(c["property_address"] ?? ""),
        c["property_type"] ? String(c["property_type"]) : null,
        body.triage?.urgency ?? "routine",
        body.triage?.category ?? null,
        c["situation"] ? String(c["situation"]) : null,
        c["source"] ? String(c["source"]) : null,
        c["affected_areas"] ? String(c["affected_areas"]) : null,
        c["insurance_carrier"] ? String(c["insurance_carrier"]) : null,
        c["claim_number"] ? String(c["claim_number"]) : null,
      ),
    );
  }

  await env.DB.batch(statements);
  return json({ ok: true, callSid: body.callSid });
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const unauthorized = requireServiceToken(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenant");
  if (!tenantId) return json({ error: "tenant is required" }, 400);

  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const urgency = url.searchParams.get("urgency");

  const query = urgency
    ? env.DB.prepare(
        `SELECT call_sid, started_at, ended_at, outcome, urgency, water_category, collected
           FROM calls WHERE tenant_id = ? AND urgency = ?
          ORDER BY started_at DESC LIMIT ?`,
      ).bind(tenantId, urgency, limit)
    : env.DB.prepare(
        `SELECT call_sid, started_at, ended_at, outcome, urgency, water_category, collected
           FROM calls WHERE tenant_id = ?
          ORDER BY started_at DESC LIMIT ?`,
      ).bind(tenantId, limit);

  const { results } = await query.all();
  return json({ calls: results });
};
