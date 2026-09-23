// OUTPILOT v2 — Lemlist write-protocol probe (T018)
// -----------------------------------------------------------------------------
// UN solo POST /campaigns que crea una campana en estado borrador con el
// nombre PROBE-T018-<timestamp>, sin secuencia activa, sin leads. Luego
// GET /campaigns/:id para confirmar el estado. Paso 2: dos POST addLead con
// un email inventado en example.com para capturar los strings reales del
// error de duplicado (recalibra isAlreadyAddedError del provider).
//
// NO llama a ningun endpoint que arranque, reanude, programe ni active la
// campana. El id de la campana se imprime al final para que Pere la borre
// a mano.
//
// SEGURIDAD:
// - Modo dry-run POR DEFECTO. Imprime todas las peticiones que HARIA y sale
//   sin ejecutar.
// - Para ejecutar de verdad, EXECUTE=1 en el entorno o pasar --execute.
// - La key se redacta en cualquier salida.
//
// Usage:
//   npm run probe:lemlist-write            (dry-run: solo muestra)
//   EXECUTE=1 npm run probe:lemlist-write  (ejecuta contra Lemlist real)

const BASE = "https://api.lemlist.com/api";

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-write] LEMLIST_API_KEY no esta en el entorno. Add it to .env.local.",
  );
  process.exit(1);
}

const shouldExecute =
  process.env.EXECUTE === "1" || process.argv.includes("--execute");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const campaignName = `PROBE-T018-${timestamp}`;

// Body EXACTO que el provider (upsertCampaign) POSTearia para crear una
// nueva campana. Alineado con VOLT_DEFAULT_SCHEDULE de src/config/lemlist.ts.
const createCampaignBody = {
  name: campaignName,
  senderStrategy: "random",
  schedule: {
    name: "Volt M-X-J 9-11 / 15-17 Madrid",
    timezone: "Europe/Madrid",
    weekdays: [2, 3, 4],
    windows: [
      { start: "09:00", end: "11:00" },
      { start: "15:00", end: "17:00" },
    ],
    secondsToWait: 1200,
  },
};

const probeLeadEmail = "probe-t018@example.com";
const addLeadBody = {
  firstName: "Probe",
  companyName: "Example Probe Corp",
};

// ===== Plan =====

const planned = [
  {
    step: "1. Crear campana (POST /campaigns)",
    method: "POST",
    url: `${BASE}/campaigns`,
    body: createCampaignBody,
    notes:
      "Crea la campana en estado borrador. Lemlist NO arranca envios hasta " +
      "que la campana se inicia + tiene leads; este POST es inerte.",
  },
  {
    step: "1b. Verificar estado (GET /campaigns/:id)",
    method: "GET",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>`,
    body: null,
    notes: "Confirma que status es 'draft' o similar antes de continuar.",
  },
  {
    step: "2a. Add lead primera vez (POST /campaigns/:id/leads/:email)",
    method: "POST",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>/leads/${encodeURIComponent(probeLeadEmail)}`,
    body: addLeadBody,
    notes: "Espera 200/201. Captura el shape del response.",
  },
  {
    step: "2b. Add lead segunda vez (mismo email)",
    method: "POST",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>/leads/${encodeURIComponent(probeLeadEmail)}`,
    body: addLeadBody,
    notes:
      "Espera 409 o 400 con mensaje 'already'. Captura status + body EXACTOS " +
      "para recalibrar isAlreadyAddedError en el provider.",
  },
];

console.log("=".repeat(72));
console.log(`[probe:lemlist-write] mode: ${shouldExecute ? "EXECUTE" : "DRY-RUN"}`);
console.log(`[probe:lemlist-write] campaign name: ${campaignName}`);
console.log(`[probe:lemlist-write] probe lead email: ${probeLeadEmail}`);
console.log("=".repeat(72));

for (const p of planned) {
  console.log(`\n[plan] ${p.step}`);
  console.log(`       ${p.method} ${p.url}`);
  if (p.body !== null) {
    console.log(`       body:`);
    console.log(
      JSON.stringify(p.body, null, 2)
        .split("\n")
        .map((line) => `         ${line}`)
        .join("\n"),
    );
  }
  console.log(`       notes: ${p.notes}`);
}

if (!shouldExecute) {
  console.log("\n" + "=".repeat(72));
  console.log("[probe:lemlist-write] DRY-RUN: no se ha hecho ninguna peticion.");
  console.log(
    "[probe:lemlist-write] Para ejecutar: EXECUTE=1 npm run probe:lemlist-write",
  );
  console.log("=".repeat(72));
  process.exit(0);
}

// ===== EXECUTE =====

const basic = Buffer.from(`:${key}`, "utf8").toString("base64");
const headers = {
  accept: "application/json",
  authorization: `Basic ${basic}`,
};

function redact(text) {
  return text.split(key).join("<LEMLIST_API_KEY_REDACTED>");
}

async function doRequest(label, method, url, body) {
  console.log(`\n[exec] ${label}`);
  console.log(`       ${method} ${url}`);
  const startedAt = Date.now();
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body !== null && body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === null || body === undefined ? undefined : JSON.stringify(body),
  });
  const latencyMs = Date.now() - startedAt;
  console.log(`       status: ${res.status} ${res.statusText} (${latencyMs}ms)`);
  console.log(
    `       rate limit: remaining=${res.headers.get("x-ratelimit-remaining")} retry-after=${res.headers.get("retry-after")}`,
  );
  const text = await res.text();
  const redacted = redact(text);
  console.log(
    `       body (${text.length}B):\n${redacted
      .slice(0, 4096)
      .split("\n")
      .map((line) => `         ${line}`)
      .join("\n")}`,
  );
  return { res, text };
}

// Step 1: crear
const created = await doRequest(
  "1. crear campana",
  "POST",
  `${BASE}/campaigns`,
  createCampaignBody,
);
if (!created.res.ok) {
  console.error(
    "\n[probe:lemlist-write] step 1 fallo. Aborto — no hay campana que borrar.",
  );
  process.exit(1);
}
let campaignId;
try {
  const parsed = JSON.parse(created.text);
  campaignId = parsed._id;
} catch {
  console.error("[probe:lemlist-write] step 1 body no es JSON parseable; aborto.");
  process.exit(1);
}
if (!campaignId) {
  console.error(
    "[probe:lemlist-write] step 1 response sin _id; aborto para no dejar basura.",
  );
  process.exit(1);
}

// Step 1b: GET verificacion
await doRequest("1b. GET verificacion", "GET", `${BASE}/campaigns/${campaignId}`, null);

// Step 2a: add lead
await doRequest(
  "2a. addLead primera vez",
  "POST",
  `${BASE}/campaigns/${campaignId}/leads/${encodeURIComponent(probeLeadEmail)}`,
  addLeadBody,
);

// Step 2b: add lead duplicado
await doRequest(
  "2b. addLead segunda vez (esperado duplicado)",
  "POST",
  `${BASE}/campaigns/${campaignId}/leads/${encodeURIComponent(probeLeadEmail)}`,
  addLeadBody,
);

console.log("\n" + "=".repeat(72));
console.log(`[probe:lemlist-write] DONE.`);
console.log(`[probe:lemlist-write] campana creada: ${campaignId}`);
console.log(`[probe:lemlist-write] nombre: ${campaignName}`);
console.log(`[probe:lemlist-write] BORRAR A MANO en https://app.lemlist.com`);
console.log("=".repeat(72));
