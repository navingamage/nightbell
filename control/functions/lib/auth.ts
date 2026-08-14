/**
 * Authentication between the media server and the control plane.
 *
 * A shared bearer token, compared in constant time. This is a
 * service-to-service boundary between two things the same person deploys, so a
 * shared secret is proportionate — but the comparison still has to be constant
 * time, because a timing oracle on a token check is a real vulnerability
 * regardless of how private the endpoint feels.
 */

export interface Env {
  DB: D1Database;
  CONTROL_PLANE_TOKEN: string;
}

/**
 * Constant-time string comparison.
 *
 * A plain `===` on secrets leaks length and prefix information through timing.
 * The length check here is deliberately not an early return on mismatch — it
 * still runs the full comparison loop, so only the length itself is
 * observable, and that is not secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  let diff = aBytes.length ^ bBytes.length;
  const length = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** Returns null when authorised, or a 401 Response when not. */
export function requireServiceToken(request: Request, env: Env): Response | null {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!env.CONTROL_PLANE_TOKEN || !timingSafeEqual(token, env.CONTROL_PLANE_TOKEN)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
