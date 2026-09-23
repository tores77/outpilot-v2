// OUTPILOT v2 — Lemlist HTTP client
// Fase 2 · T018
//
// Cliente minimo para hablar con la API de Lemlist. HTTP Basic auth,
// timeouts, backoff en 5xx/429 respetando Retry-After (fuente primaria)
// y fail-fast en el resto de 4xx.
//
// Reglas contrastadas con probes:
// - Base URL: https://api.lemlist.com/api
// - Auth: Basic base64(":" + LEMLIST_API_KEY)  (usuario vacio)
// - Rate limit: 20 req / 2s por key; Retry-After viene incluso en 2xx
// - Content-type valido: application/json. Un 200 con text/html significa
//   que la ruta cae al SPA y no es endpoint API (bug real detectado en
//   T018 en /api/team/users; el cliente lo trata como 404 sintetico).

import {
  LEMLIST_BASE_URL,
  LEMLIST_DEFAULT_TIMEOUT_MS,
  LEMLIST_FALLBACK_BACKOFF_MS,
  LEMLIST_MAX_RETRIES,
} from "@/config/lemlist";

export type FetchImpl = typeof fetch;

export type LemlistClientOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: FetchImpl;
  // Inyectable para tests: (ms) => Promise<void>. Default: setTimeout real.
  sleep?: (ms: number) => Promise<void>;
};

export class LemlistApiError extends Error {
  constructor(
    public status: number,
    public bodyPreview: string,
    public method: string,
    public path: string,
  ) {
    super(`Lemlist ${method} ${path} -> ${status}: ${bodyPreview.slice(0, 200)}`);
    this.name = "LemlistApiError";
  }
}

export class LemlistTimeoutError extends Error {
  constructor(public method: string, public path: string, public timeoutMs: number) {
    super(`Lemlist ${method} ${path} timed out after ${timeoutMs}ms`);
    this.name = "LemlistTimeoutError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parsea Retry-After. Lemlist lo emite en segundos, a veces con decimales
 * (observado: "1.905"). RFC 7231 permite tambien fechas HTTP; caemos a
 * fallback si el valor no es numerico.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number.parseFloat(header);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.ceil(asNumber * 1000);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

/**
 * x-ratelimit-reset como respaldo si no hay Retry-After. Lemlist lo
 * emite como fecha humana ISO-ish ("Wed Sep 23 2026 11:26:17 GMT+0200 ...").
 */
function parseRateLimitResetMs(header: string | null): number | null {
  if (!header) return null;
  const asDate = Date.parse(header);
  if (!Number.isFinite(asDate)) return null;
  const delta = asDate - Date.now();
  return delta > 0 ? delta : null;
}

export type LemlistClient = {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  patch<T = unknown>(path: string, body: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
};

export function createLemlistClient(opts: LemlistClientOptions): LemlistClient {
  const {
    apiKey,
    baseUrl = LEMLIST_BASE_URL,
    timeoutMs = LEMLIST_DEFAULT_TIMEOUT_MS,
    maxRetries = LEMLIST_MAX_RETRIES,
    fetchImpl = fetch,
    sleep = defaultSleep,
  } = opts;

  if (!apiKey || apiKey.trim() === "") {
    throw new Error("LemlistClient: apiKey vacia.");
  }

  const authHeader = `Basic ${Buffer.from(`:${apiKey}`, "utf8").toString("base64")}`;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    let attempt = 0;

    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            accept: "application/json",
            authorization: authHeader,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          throw new LemlistTimeoutError(method, path, timeoutMs);
        }
        throw err;
      }
      clearTimeout(timer);

      // 200 con content-type text/html = ruta cae al SPA; tratar como 404.
      const contentType = response.headers.get("content-type") || "";
      const isHtmlSpaFallback =
        response.status === 200 && !contentType.includes("application/json");
      const effectiveStatus = isHtmlSpaFallback ? 404 : response.status;

      if (effectiveStatus >= 200 && effectiveStatus < 300) {
        // Endpoint sin body (p. ej. DELETE) o con body vacio: devolvemos
        // undefined tipado como T; el caller decide.
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (text === "") return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new LemlistApiError(
            response.status,
            `respuesta no es JSON: ${text.slice(0, 200)}`,
            method,
            path,
          );
        }
      }

      // Retriable: 429 o 5xx.
      const isRetriable = effectiveStatus === 429 || effectiveStatus >= 500;
      if (isRetriable && attempt < maxRetries) {
        const retryAfterMs =
          parseRetryAfterMs(response.headers.get("retry-after")) ??
          parseRateLimitResetMs(response.headers.get("x-ratelimit-reset")) ??
          LEMLIST_FALLBACK_BACKOFF_MS[Math.min(attempt, LEMLIST_FALLBACK_BACKOFF_MS.length - 1)];
        await sleep(retryAfterMs);
        attempt += 1;
        continue;
      }

      // Fail-fast en el resto de 4xx (o retries agotados).
      const bodyText = await response.text().catch(() => "");
      throw new LemlistApiError(
        response.status,
        isHtmlSpaFallback ? "endpoint no expone JSON (fallback SPA)" : bodyText,
        method,
        path,
      );
    }
  }

  return {
    get: <T,>(path: string) => request<T>("GET", path),
    post: <T,>(path: string, body: unknown) => request<T>("POST", path, body),
    patch: <T,>(path: string, body: unknown) => request<T>("PATCH", path, body),
    delete: <T,>(path: string) => request<T>("DELETE", path),
  };
}
