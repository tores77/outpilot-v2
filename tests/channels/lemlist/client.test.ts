import { describe, expect, it } from "vitest";
import {
  createLemlistClient,
  LemlistApiError,
  LemlistTimeoutError,
  type FetchImpl,
} from "@/channels/lemlist/client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function makeFetchImpl(responses: Response[]): FetchImpl {
  let call = 0;
  return (async () => {
    if (call >= responses.length) throw new Error("fetch called more times than expected");
    const r = responses[call++];
    return r;
  }) as unknown as FetchImpl;
}

describe("LemlistClient", () => {
  it("envía Authorization: Basic base64(':' + key) y accept JSON", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(200, { ok: true });
    }) as unknown as FetchImpl;

    const client = createLemlistClient({ apiKey: "secret-key", fetchImpl });
    await client.get("/team");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.lemlist.com/api/team");
    const auth = (seen[0].init.headers as Record<string, string>).authorization;
    // base64(":secret-key") = OnNlY3JldC1rZXk=
    expect(auth).toBe(`Basic ${Buffer.from(":secret-key", "utf8").toString("base64")}`);
    expect((seen[0].init.headers as Record<string, string>).accept).toBe("application/json");
  });

  it("retries en 429 respetando Retry-After (segundos, decimal)", async () => {
    const responses = [
      new Response("rate", {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "1.9" },
      }),
      jsonResponse(200, { ok: true }),
    ];
    const sleepCalls: number[] = [];
    const client = createLemlistClient({
      apiKey: "k",
      fetchImpl: makeFetchImpl(responses),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const result = await client.get<{ ok: boolean }>("/team");
    expect(result).toEqual({ ok: true });
    // 1.9 s → Math.ceil(1900) = 1900 ms
    expect(sleepCalls).toEqual([1900]);
  });

  it("retries en 5xx y cae al fallback si no viene Retry-After ni x-ratelimit-reset", async () => {
    const responses = [
      new Response("boom", { status: 502, headers: { "content-type": "application/json" } }),
      jsonResponse(200, { ok: true }),
    ];
    const sleepCalls: number[] = [];
    const client = createLemlistClient({
      apiKey: "k",
      fetchImpl: makeFetchImpl(responses),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    await client.get("/team");
    // Primer intento (attempt=0) usa fallback[0] = 500
    expect(sleepCalls).toEqual([500]);
  });

  it("fail-fast en 4xx que no sea 429 (sin retries)", async () => {
    const responses = [
      new Response(JSON.stringify({ message: "bad" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ];
    let calls = 0;
    const fetchImpl: FetchImpl = (async () => {
      calls += 1;
      return responses[0];
    }) as unknown as FetchImpl;
    const client = createLemlistClient({ apiKey: "k", fetchImpl });

    await expect(client.get("/team")).rejects.toBeInstanceOf(LemlistApiError);
    expect(calls).toBe(1);
  });

  it("un 200 con content-type text/html se trata como fallback SPA y falla como 404", async () => {
    const responses = [htmlResponse(200, "<!DOCTYPE html>...")];
    const client = createLemlistClient({
      apiKey: "k",
      fetchImpl: makeFetchImpl(responses),
    });
    const err = await client.get("/team/users").catch((e) => e);
    expect(err).toBeInstanceOf(LemlistApiError);
    expect((err as LemlistApiError).bodyPreview).toMatch(/fallback SPA/i);
  });

  it("respeta el máximo de reintentos y lanza si no hay 2xx", async () => {
    const rateHeader = { "content-type": "application/json", "retry-after": "0.01" };
    const responses = [
      new Response("r", { status: 429, headers: rateHeader }),
      new Response("r", { status: 429, headers: rateHeader }),
      new Response("r", { status: 429, headers: rateHeader }),
      new Response("r", { status: 429, headers: rateHeader }),
    ];
    const client = createLemlistClient({
      apiKey: "k",
      fetchImpl: makeFetchImpl(responses),
      maxRetries: 3,
      sleep: async () => {},
    });
    await expect(client.get("/team")).rejects.toBeInstanceOf(LemlistApiError);
  });

  it("timeouts se convierten en LemlistTimeoutError", async () => {
    const fetchImpl: FetchImpl = (async (_url: string, init: RequestInit) => {
      // Espera al abort del AbortController y lanza AbortError.
      await new Promise((_, reject) => {
        const signal = init.signal;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
      throw new Error("unreachable");
    }) as unknown as FetchImpl;

    const client = createLemlistClient({ apiKey: "k", fetchImpl, timeoutMs: 10 });
    await expect(client.get("/team")).rejects.toBeInstanceOf(LemlistTimeoutError);
  });

  it("apiKey vacía lanza en constructor", () => {
    expect(() => createLemlistClient({ apiKey: "" })).toThrow(/apiKey vacia/i);
    expect(() => createLemlistClient({ apiKey: "   " })).toThrow(/apiKey vacia/i);
  });

  it("204 y body vacío devuelven undefined", async () => {
    const responses = [new Response(null, { status: 204 })];
    const client = createLemlistClient({
      apiKey: "k",
      fetchImpl: makeFetchImpl(responses),
    });
    const r = await client.delete("/campaigns/x");
    expect(r).toBeUndefined();
  });
});
