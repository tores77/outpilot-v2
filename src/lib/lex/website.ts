// OUTPILOT v2 — Lex website fetcher (T022)
// -----------------------------------------------------------------------------
// Baja el HTML de la web del lead, comprueba robots.txt (barato, un
// GET) y devuelve un texto plano recortado a ~1500 chars con
// título + meta description + primer par de párrafos del body.
//
// El caller (job de Lex) cachea el resultado en
// leads.custom_fields.website_summary. Si algo falla, devuelve un
// status distinto de "ok" y Lex degrada a personalization "generic".

import {
  LEX_WEBSITE_FETCH_TIMEOUT_MS,
  LEX_WEBSITE_MAX_CHARS,
  LEX_WEBSITE_UA,
} from "@/config/lex";

export type WebsiteSummaryStatus =
  | "ok"
  | "invalid_url"
  | "robots_disallowed"
  | "timeout"
  | "http_4xx"
  | "http_5xx"
  | "no_html"
  | "network_error";

export type WebsiteSummary = {
  url: string;
  status: WebsiteSummaryStatus;
  summary: string; // vacío si status !== "ok"
  fetched_at: string; // ISO
};

function nowIso(): string {
  return new Date().toISOString();
}

function normaliseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = LEX_WEBSITE_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": LEX_WEBSITE_UA,
        accept: "text/html, application/xhtml+xml",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Comprueba robots.txt del origen. Solo mira una directiva blanket
 * (`Disallow: /`) aplicable a User-agent: * o a nuestro UA/product
 * token. Aproximación conservadora — si el parsing falla, permite el
 * fetch (fail-open, como haría curl por defecto). NO respeta reglas
 * granulares por path porque solo pedimos la home.
 */
export async function isRobotsAllowed(origin: string): Promise<boolean> {
  const robotsUrl = `${origin}/robots.txt`;
  let res: Response;
  try {
    res = await fetchWithTimeout(robotsUrl, {}, 3_000);
  } catch {
    return true; // fail-open: no había robots o dio timeout
  }
  if (!res.ok) return true; // 404, 5xx → asumimos permitido
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/plain") && !contentType.includes("text/html")) {
    return true;
  }
  const body = await res.text().catch(() => "");
  return !hasBlanketDisallow(body);
}

/**
 * Detecta si el robots.txt tiene un Disallow: / bajo el bloque de un
 * User-agent que nos aplique (nuestro token de producto "outpilot" o
 * el comodín "*"). Muy conservador — false positives son aceptables.
 */
export function hasBlanketDisallow(robotsBody: string): boolean {
  const lines = robotsBody.split(/\r?\n/);
  let applies = false; // ¿el bloque actual nos aplica?
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      const ua = value.toLowerCase();
      applies = ua === "*" || ua.includes("outpilot") || ua.includes("umania");
    } else if (applies && key === "disallow") {
      if (value === "/" || value === "*") return true;
    } else if (applies && key === "allow") {
      // ignoramos allows granulares en esta implementación
    }
  }
  return false;
}

/**
 * Extrae texto plano útil del HTML: <title>, <meta name="description">,
 * y el body sin tags. Recorta a maxChars. Muy conservador: si el HTML
 * no encaja con estos patrones simples, devuelve lo que se pueda.
 */
export function extractSummary(html: string, maxChars: number = LEX_WEBSITE_MAX_CHARS): string {
  // <script> y <style> fuera antes de nada.
  const cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : "";

  const descMatch = cleaned.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  const description = descMatch ? decodeEntities(descMatch[1]).trim() : "";

  const bodyMatch = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const bodyRaw = bodyMatch ? bodyMatch[1] : cleaned;
  const bodyText = stripTags(bodyRaw).replace(/\s+/g, " ").trim();

  const parts: string[] = [];
  if (title) parts.push(`Title: ${title}`);
  if (description) parts.push(`Description: ${description}`);
  if (bodyText) parts.push(`Body: ${bodyText}`);
  const joined = parts.join("\n\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars - 1)}…`;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Fetch principal. Devuelve siempre una WebsiteSummary — nunca lanza.
 * El caller decide qué hacer con status distinto de "ok".
 */
export async function fetchWebsiteSummary(
  rawUrl: string,
): Promise<WebsiteSummary> {
  const parsed = normaliseUrl(rawUrl);
  if (!parsed) {
    return {
      url: rawUrl,
      status: "invalid_url",
      summary: "",
      fetched_at: nowIso(),
    };
  }
  const url = parsed.toString();
  const origin = `${parsed.protocol}//${parsed.host}`;

  const allowed = await isRobotsAllowed(origin);
  if (!allowed) {
    return {
      url,
      status: "robots_disallowed",
      summary: "",
      fetched_at: nowIso(),
    };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      url,
      status: isAbort ? "timeout" : "network_error",
      summary: "",
      fetched_at: nowIso(),
    };
  }

  if (res.status >= 500) {
    return { url, status: "http_5xx", summary: "", fetched_at: nowIso() };
  }
  if (res.status >= 400) {
    return { url, status: "http_4xx", summary: "", fetched_at: nowIso() };
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("html")) {
    return { url, status: "no_html", summary: "", fetched_at: nowIso() };
  }

  const html = await res.text().catch(() => "");
  const summary = extractSummary(html);
  return { url, status: "ok", summary, fetched_at: nowIso() };
}
