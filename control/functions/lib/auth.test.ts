import { describe, expect, it } from "vitest";
import { type Env, requireServiceToken, timingSafeEqual } from "./auth.js";

const env = { CONTROL_PLANE_TOKEN: "secret-token" } as Env;

function requestWith(header?: string): Request {
  return new Request("https://example.com/api/tenant", {
    headers: header ? { Authorization: header } : {},
  });
}

describe("timingSafeEqual", () => {
  it("accepts identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(timingSafeEqual("abc", "abd")).toBe(false);
  });

  it("rejects strings of different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("rejects a prefix", () => {
    // The property that matters: a partially-correct token is no better than a
    // wholly wrong one.
    expect(timingSafeEqual("sec", "secret-token")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("", "a")).toBe(false);
  });

  it("handles multi-byte characters", () => {
    expect(timingSafeEqual("café", "café")).toBe(true);
    expect(timingSafeEqual("café", "cafe")).toBe(false);
  });
});

describe("requireServiceToken", () => {
  it("passes a correct bearer token", () => {
    expect(requireServiceToken(requestWith("Bearer secret-token"), env)).toBeNull();
  });

  it("rejects a wrong token", async () => {
    const response = requireServiceToken(requestWith("Bearer wrong"), env);
    expect(response?.status).toBe(401);
  });

  it("rejects a missing header", () => {
    expect(requireServiceToken(requestWith(), env)?.status).toBe(401);
  });

  it("rejects a token without the Bearer prefix", () => {
    expect(requireServiceToken(requestWith("secret-token"), env)?.status).toBe(401);
  });

  it("rejects everything when the server has no token configured", () => {
    // Fail closed. An unset secret must not become an open door.
    const empty = { CONTROL_PLANE_TOKEN: "" } as Env;
    expect(requireServiceToken(requestWith("Bearer "), empty)?.status).toBe(401);
    expect(requireServiceToken(requestWith(), empty)?.status).toBe(401);
  });
});
