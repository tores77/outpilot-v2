// HMAC signature over the estimate params so the "Execute" step cannot be
// tampered with. Reuses INNGEST_SIGNING_KEY as the HMAC secret — it is
// already server-only, high-entropy, and rotated as a unit.
//
// Token layout:  <base64url(hmac_sha256(canonical + email + timestamp))>.<timestamp>
//
// Any change in filters or email between /vibe (estimate) and the execute
// action invalidates the token; a stale token (older than
// VIBE_ESTIMATE_TOKEN_TTL_MS) is rejected as expired.

import { createHmac, timingSafeEqual } from "node:crypto";
import { VIBE_ESTIMATE_TOKEN_TTL_MS } from "@/config/vibe";
import type { VibeUiFilters } from "./types";

function canonicalise(params: VibeUiFilters): string {
  return JSON.stringify({
    countries: [...params.countries].sort(),
    sectors: [...params.sectors].sort(),
    seniority: params.seniority,
    limit: params.limit,
  });
}

function hmac(payload: string): string {
  const secret = process.env.INNGEST_SIGNING_KEY;
  if (!secret) throw new Error("INNGEST_SIGNING_KEY not set");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signEstimate(
  params: VibeUiFilters,
  email: string,
): { token: string; timestamp: number } {
  const timestamp = Date.now();
  const payload = `${canonicalise(params)}.${email}.${timestamp}`;
  const sig = hmac(payload);
  return { token: `${sig}.${timestamp}`, timestamp };
}

export type VerifyResult =
  | { valid: true; expired: false }
  | { valid: false; expired: boolean; reason: string };

export function verifyEstimate(
  token: string,
  params: VibeUiFilters,
  email: string,
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { valid: false, expired: false, reason: "malformed_token" };
  }
  const [sig, tsStr] = parts;
  const timestamp = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, expired: false, reason: "malformed_timestamp" };
  }
  const expired = Date.now() - timestamp > VIBE_ESTIMATE_TOKEN_TTL_MS;
  if (expired) {
    return { valid: false, expired: true, reason: "token_expired" };
  }
  const payload = `${canonicalise(params)}.${email}.${timestamp}`;
  const expected = hmac(payload);
  if (sig.length !== expected.length) {
    return { valid: false, expired: false, reason: "signature_mismatch" };
  }
  const equal = timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return equal
    ? { valid: true, expired: false }
    : { valid: false, expired: false, reason: "signature_mismatch" };
}
