// OUTPILOT v2 — Lemlist write-protocol probe (T018)
// -----------------------------------------------------------------------------
// UN solo POST /campaigns (con reintento sin schedule si 422) que crea una
// campana en estado borrador con el nombre PROBE-T018-<timestamp>, sin
// secuencia activa, sin leads. Luego:
//   - GET /campaigns/:id       (paso 1b: confirma estado)
//   - GET /campaigns/:id/schedules (paso 1c: verifica si el schedule
//     embebido fue aceptado / ignorado en silencio)
//   - STATE GATE: si el estado NO es draft o paused, aborta antes de
//     tocar leads. Reporta y sale.
//   - addLead x2 con probe-t018@example.com para capturar el string
//     real del duplicado (recalibra isAlreadyAddedError).
//
// NO llama a ningun endpoint que arranque, reanude, programe ni active la
// campana. El _id se imprime al final para que Pere la borre a mano.
//
// SEGURIDAD:
// - Dry-run POR DEFECTO. Imprime el plan y sale sin ejecutar.
// - Para ejecutar: EXECUTE=1 o --execute.
// - La key se redacta en cualquier salida.
//
// Usage:
//   npm run probe:lemlist-write             (dry-run)
//   EXECUTE=1 npm run probe:lemlist-write   (ejecuta contra Lemlist real)

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

// Body EXACTO que upsertCampaign POSTearia para una campana nueva.
// Alineado con VOLT_DEFAULT_SCHEDULE de src/config/lemlist.ts.
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

// Body de fallback si el primer POST devuelve 422 quejandose del schedule.
const createCampaignSlimBody = {
  name: campaignName,
  senderStrategy: "random",
};

const probeLeadEmail = "probe-t018@example.com";
const addLeadBody = {
  firstName: "Probe",
  companyName: "Example Probe Corp",
};

// Estados considerados seguros para continuar con addLead (spec de Pere:
// borrador o pausada). Cualquier otro estado → abort antes del paso 2.
const SAFE_STATES = new Set(["draft", "paused"]);

// ===== Plan (dry-run) =====

const planned = [
  {
    step: "1. Crear campana (POST /campaigns) — body con schedule embebido",
    method: "POST",
    url: `${BASE}/campaigns`,
    body: createCampaignBody,
    notes:
      "Si 422 → reintenta con body slim (sin schedule). En ambos casos captura la respuesta.",
  },
  {
    step: "1b. GET /campaigns/:id — verifica estado",
    method: "GET",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>`,
    body: null,
    notes:
      "STATE GATE: si status NO es draft o paused, aborta antes del paso 2 y reporta.",
  },
  {
    step: "1c. GET /campaigns/:id/schedules — verifica schedule real",
    method: "GET",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>/schedules`,
    body: null,
    notes:
      "Compara con lo que enviamos. Si el subresource esta vacio o difiere, " +
      "el schedule embebido fue ignorado y upsertCampaign necesita una " +
      "SEGUNDA llamada a POST /campaigns/:id/schedules.",
  },
  {
    step: "2a. Add lead primera vez (POST /campaigns/:id/leads/:email)",
    method: "POST",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>/leads/${encodeURIComponent(probeLeadEmail)}`,
    body: addLeadBody,
    notes: "Espera 200/201. Captura shape.",
  },
  {
    step: "2b. Add lead segunda vez (mismo email) — duplicado",
    method: "POST",
    url: `${BASE}/campaigns/<CAMPAIGN_ID>/leads/${encodeURIComponent(probeLeadEmail)}`,
    body: addLeadBody,
    notes:
      "Espera 409 o 400 con mensaje 'already'. Captura status + body EXACTOS.",
  },
];

console.log("=".repeat(72));
console.log(`[probe:lemlist-write] mode: ${shouldExecute ? "EXECUTE" : "DRY-RUN"}`);
console.log(`[probe:lemlist-write] campaign name: ${campaignName}`);
console.log(`[probe:lemlist-write] probe lead email: ${probeLeadEmail}`);
console.log(
  `[probe:lemlist-write] safe states para continuar tras 1b: ${[...SAFE_STATES].join(", ")}`,
);
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
      ...(body !== null && body !== undefined
        ? { "content-type": "application/json" }
        : {}),
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

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ===== Step 1: crear (con reintento sin schedule si 422) =====

let created = await doRequest(
  "1. crear campana (con schedule embebido)",
  "POST",
  `${BASE}/campaigns`,
  createCampaignBody,
);

let scheduleAttempt = "embedded"; // 'embedded' | 'slim-after-422'

if (created.res.status === 422) {
  console.log(
    "\n[iter] 422 en el POST inicial. Reintentando SIN schedule (body slim).",
  );
  created = await doRequest(
    "1 (retry). POST slim body (sin schedule)",
    "POST",
    `${BASE}/campaigns`,
    createCampaignSlimBody,
  );
  scheduleAttempt = "slim-after-422";
}

if (!created.res.ok) {
  console.error(
    "\n[probe:lemlist-write] step 1 fallo definitivamente. Aborto — no hay campana que borrar.",
  );
  process.exit(1);
}

const createdParsed = safeParse(created.text);
const campaignId = createdParsed?._id;
if (!campaignId) {
  console.error(
    "[probe:lemlist-write] step 1 response sin _id parseable. Aborto para no dejar basura.",
  );
  process.exit(1);
}

// Detecta si la respuesta de creacion incluye info del schedule.
const scheduleInCreateResp =
  createdParsed?.schedule !== undefined ||
  createdParsed?.scheduleId !== undefined ||
  (Array.isArray(createdParsed?.schedules) && createdParsed.schedules.length > 0);

// ===== Step 1b: GET detalle + STATE GATE =====

const detail = await doRequest(
  "1b. GET /campaigns/:id — detalle + estado",
  "GET",
  `${BASE}/campaigns/${campaignId}`,
  null,
);
const detailParsed = safeParse(detail.text);
const state = String(detailParsed?.status ?? "").toLowerCase();
const scheduleInDetail =
  detailParsed?.schedule !== undefined ||
  detailParsed?.scheduleId !== undefined ||
  (Array.isArray(detailParsed?.schedules) && detailParsed.schedules.length > 0);

if (!SAFE_STATES.has(state)) {
  console.error("\n" + "=".repeat(72));
  console.error(
    `[abort] La campana esta en estado "${state}", que no es ninguno de: ${[...SAFE_STATES].join(", ")}.`,
  );
  console.error(
    "[abort] NO se procede con addLead. Nada de leads inventados ha entrado.",
  );
  console.error(`[abort] campana creada: ${campaignId} (${campaignName})`);
  console.error("[abort] BORRAR A MANO en https://app.lemlist.com");
  console.error("=".repeat(72));
  process.exit(1);
}

console.log(`\n[gate] estado "${state}" OK — dentro de SAFE_STATES. Continuo.`);

// ===== Step 1c: GET /schedules — ground truth =====

const schedules = await doRequest(
  "1c. GET /campaigns/:id/schedules — ground truth del schedule",
  "GET",
  `${BASE}/campaigns/${campaignId}/schedules`,
  null,
);
const schedulesParsed = safeParse(schedules.text);
const schedulesArr = Array.isArray(schedulesParsed) ? schedulesParsed : [];
const scheduleInSubresource = schedulesArr.length > 0;

// Verdict del schedule
console.log("\n" + "-".repeat(72));
console.log("[verdict] schedule handling:");
console.log(`  scheduleAttempt: ${scheduleAttempt}`);
console.log(`  schedule visible en respuesta de POST /campaigns : ${scheduleInCreateResp}`);
console.log(`  schedule visible en GET /campaigns/:id           : ${scheduleInDetail}`);
console.log(`  /campaigns/:id/schedules items                   : ${schedulesArr.length}`);

if (scheduleAttempt === "slim-after-422") {
  console.log(
    "  → RESULTADO: Lemlist RECHAZO el schedule embebido con 422. " +
      "upsertCampaign debe: (1) POST /campaigns con body slim, luego " +
      "(2) POST /campaigns/:id/schedules con el schedule.",
  );
} else if (scheduleInCreateResp || scheduleInDetail) {
  console.log("  → RESULTADO: Lemlist ACEPTO el schedule embebido en POST /campaigns.");
} else if (scheduleInSubresource) {
  // La creacion no lo mostro pero el subresource lo tiene → probablemente
  // Lemlist crea un schedule "Default" por su cuenta, no el nuestro.
  console.log(
    "  → RESULTADO: la respuesta de POST NO trae el schedule pero /schedules " +
      "tiene items. Compara con el body que enviamos: si coincide, aceptado silencioso; " +
      "si es un default distinto, upsertCampaign necesita una SEGUNDA llamada.",
  );
  console.log("  Contenido /schedules:");
  console.log(
    JSON.stringify(schedulesArr, null, 2)
      .split("\n")
      .map((l) => "    " + l)
      .join("\n"),
  );
} else {
  console.log(
    "  → RESULTADO: Lemlist IGNORO el schedule en silencio (no en POST, no en detail, " +
      "no en subresource). upsertCampaign DEBE hacer una SEGUNDA llamada a " +
      "POST /campaigns/:id/schedules.",
  );
}
console.log("-".repeat(72));

// ===== Step 2a: addLead =====

await doRequest(
  "2a. addLead primera vez",
  "POST",
  `${BASE}/campaigns/${campaignId}/leads/${encodeURIComponent(probeLeadEmail)}`,
  addLeadBody,
);

// ===== Step 2b: addLead duplicado =====

await doRequest(
  "2b. addLead segunda vez (esperado duplicado)",
  "POST",
  `${BASE}/campaigns/${campaignId}/leads/${encodeURIComponent(probeLeadEmail)}`,
  addLeadBody,
);

// ===== Final =====

console.log("\n" + "=".repeat(72));
console.log("[probe:lemlist-write] DONE.");
console.log(`[probe:lemlist-write] campana creada: ${campaignId}`);
console.log(`[probe:lemlist-write] nombre: ${campaignName}`);
console.log("[probe:lemlist-write] BORRAR A MANO en https://app.lemlist.com");
console.log("=".repeat(72));
