/**
 * The media server's client for the Cloudflare control plane and for Twilio.
 *
 * Tenant configuration is fetched per call rather than cached indefinitely,
 * because the field that matters most — the on-call number — is the one a
 * contractor changes at the worst possible moment, usually right before going
 * to bed. A stale cache there sends an emergency page to someone who is off
 * duty. A short TTL keeps the common case fast without that failure mode.
 */

import type { CallRecord, TenantConfig } from "./call/session.js";
import type { Config } from "./config.js";

const TENANT_TTL_MS = 30_000;

interface CacheEntry {
  config: TenantConfig;
  fetchedAt: number;
}

export class ControlPlane {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly config: Config) {}

  async tenantForNumber(calledNumber: string): Promise<TenantConfig | null> {
    const cached = this.cache.get(calledNumber);
    if (cached && Date.now() - cached.fetchedAt < TENANT_TTL_MS) return cached.config;

    const url = new URL("/api/tenant", this.config.controlPlaneUrl);
    url.searchParams.set("number", calledNumber);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.config.controlPlaneToken}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`tenant lookup failed: ${response.status}`);

    const config = (await response.json()) as TenantConfig;
    this.cache.set(calledNumber, { config, fetchedAt: Date.now() });
    return config;
  }

  async persistCall(record: CallRecord): Promise<void> {
    const response = await fetch(new URL("/api/calls", this.config.controlPlaneUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.config.controlPlaneToken}`,
      },
      body: JSON.stringify(record),
    });
    if (!response.ok) throw new Error(`persist failed: ${response.status}`);
  }

  /**
   * Bridge a live call to a human.
   *
   * Uses Twilio's REST API to redirect the in-progress call to TwiML that dials
   * the on-call number. `<Dial>` rather than `<Redirect>` to a queue, because
   * on an emergency call the caller should hear ringing immediately rather than
   * hold music — the ringing is itself reassurance that something is happening.
   */
  async transfer(callSid: string, toNumber: string, reason: string): Promise<void> {
    console.info(`[${callSid}] transferring to ${toNumber}: ${reason}`);

    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Say voice="Polly.Joanna">One moment, connecting you now.</Say>` +
      `<Dial timeout="30">${toNumber}</Dial>` +
      `</Response>`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.twilioAccountSid}/Calls/${callSid}.json`;
    const auth = Buffer.from(
      `${this.config.twilioAccountSid}:${this.config.twilioAuthToken}`,
    ).toString("base64");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Twiml: twiml }),
    });

    if (!response.ok) {
      throw new Error(`transfer failed: ${response.status} ${await response.text()}`);
    }
  }
}
