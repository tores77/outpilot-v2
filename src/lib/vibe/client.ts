// HTTP client for the Vibe/Explorium REST API.
// Fase 1 · T014.
//
// - api_key header (not Bearer), verified via scripts/probe-vibe.mjs.
// - AbortController-based per-request timeout.
// - Retries on 5xx and 429 with exponential backoff; 4xx (except 429) fail
//   fast — those are contract issues, not transient.
// - Never logs the API key. Response bodies are logged on error but the
//   caller decides what to do; the redaction pass is the caller's job if
//   they surface the body to the UI.

import "server-only";

import {
  VIBE_BASE_URL,
  VIBE_FETCH_ENDPOINT,
  VIBE_MAX_RETRIES,
  VIBE_STATS_ENDPOINT,
  VIBE_TIMEOUT_MS,
} from "@/config/vibe";
import type {
  VibeFetchRequest,
  VibeFetchResponse,
  VibeStatsRequest,
  VibeStatsResponse,
} from "./types";

export class VibeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`Vibe API error ${status}: ${detail.slice(0, 200)}`);
    this.name = "VibeApiError";
  }
}

async function vibeRequest<Req, Res>(path: string, body: Req): Promise<Res> {
  const key = process.env.VIBE_API_KEY;
  if (!key) throw new Error("VIBE_API_KEY not set");

  let lastError: unknown;
  for (let attempt = 0; attempt <= VIBE_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VIBE_TIMEOUT_MS);

    try {
      const response = await fetch(`${VIBE_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          api_key: key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        return (await response.json()) as Res;
      }

      const text = await response.text();
      const retryable = response.status >= 500 || response.status === 429;
      if (!retryable) {
        throw new VibeApiError(response.status, text);
      }
      lastError = new VibeApiError(response.status, text);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof VibeApiError && err.status < 500 && err.status !== 429) {
        throw err;
      }
      lastError = err;
    }

    if (attempt < VIBE_MAX_RETRIES) {
      const delay = 500 * 2 ** attempt; // 500ms, 1s, 2s
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`Vibe API failed after ${VIBE_MAX_RETRIES + 1} attempts`);
}

export function stats(request: VibeStatsRequest): Promise<VibeStatsResponse> {
  return vibeRequest(VIBE_STATS_ENDPOINT, request);
}

export function fetchProspectsPage(
  request: VibeFetchRequest,
): Promise<VibeFetchResponse> {
  return vibeRequest(VIBE_FETCH_ENDPOINT, request);
}
