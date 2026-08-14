/**
 * Tenant lookup by dialled number.
 *
 * Called by the media server at the start of every call, so it is on the
 * critical path for answering the phone. Kept to a single indexed query for
 * that reason — anything slower here is dead air before the greeting.
 */

import { type Env, json, requireServiceToken } from "../lib/auth.js";

interface TenantRow {
  id: string;
  business_name: string;
  service_area: string;
  timezone: string;
  on_call_number: string;
  greeting: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const unauthorized = requireServiceToken(request, env);
  if (unauthorized) return unauthorized;

  const number = new URL(request.url).searchParams.get("number");
  if (!number) return json({ error: "number is required" }, 400);

  const row = await env.DB.prepare(
    `SELECT id, business_name, service_area, timezone, on_call_number, greeting
       FROM tenants
      WHERE phone_number = ? AND active = 1`,
  )
    .bind(number)
    .first<TenantRow>();

  if (!row) return json({ error: "no tenant for that number" }, 404);

  return json({
    tenantId: row.id,
    businessName: row.business_name,
    serviceArea: row.service_area,
    timezone: row.timezone,
    onCallNumber: row.on_call_number,
    greeting: row.greeting,
  });
};
