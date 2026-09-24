// OUTPILOT v2 — Lemlist sequence step-write probe (T023)
// -----------------------------------------------------------------------------
// Verifica el endpoint documentado en developer.lemlist.com/api-reference/
// endpoints/sequences/add-step-to-sequence.md
//
//   POST /api/sequences/{sequenceId}/steps
//   body: { type: "email", subject, message, delay, index? }
//   response: { _id, type, delay, emailTemplateId, message }
//   - subject: required para type=email, max 400 chars
//   - delay: 0-1500 (días). Default 0 para el primer step, 1 para
//     siguientes
//   - index: opcional. Si se omite, se añade al final
//
// Flujo:
//   1. GET /api/campaigns/{cid}/sequences  → captura sequenceId (Lemlist
//      auto-crea uno vacío al crear la campaña).
//   2. (dry-run: imprime el body candidato y sale)
//   3. POST /api/sequences/{sequenceId}/steps con body de prueba.
//   4. GET /api/campaigns/{cid}/sequences  → verifica que el step existe,
//      vuelca el shape completo.
//   5. POST mismo body otra vez → verifica idempotencia (¿duplica? ¿rechaza?).
//   6. GET final.
//
// SEGURIDAD:
//   - Dry-run POR DEFECTO. EXECUTE=1 solo contra una campaña PROBE del
//     usuario, en draft, cuyo _id pasa por LEMLIST_CAMPAIGN_ID. Rehúsa
//     ejecutar si el nombre de la campaña no empieza por "PROBE".
//   - La API key se redacta en cualquier salida.
//   - No toca Smoke 50 ni ninguna campaña real.
//
// Usage:
//   npm run probe:lemlist-add-step
//   LEMLIST_CAMPAIGN_ID=cam_xxx EXECUTE=1 npm run probe:lemlist-add-step

const BASE = "https://api.lemlist.com/api";

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-add-step] LEMLIST_API_KEY no esta en el entorno. Add it to .env.local.",
  );
  process.exit(1);
}

const shouldExecute =
  process.env.EXECUTE === "1" || process.argv.includes("--execute");
const campaignId = process.env.LEMLIST_CAMPAIGN_ID?.trim();

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
  const contentType = res.headers.get("content-type") || "";
  const redacted = redact(text);
  console.log(
    `       content-type: ${contentType}\n       body (${text.length}B):\n${redacted
      .slice(0, 4096)
      .split("\n")
      .map((l) => "         " + l)
      .join("\n")}`,
  );
  return { res, text, contentType };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ===== Body candidato (mismo en dry-run y execute) =====

const candidateStepBody = {
  type: "email",
  delay: 0,
  subject: "PROBE {{firstName}} - {{opener}}",
  message: [
    "<p>Hola {{firstName}},</p>",
    "<p>{{opener}}</p>",
    "<p><em>PROBE T023 add-step. Este step existe solo para verificar el contrato de POST /sequences/:sid/steps. Borrar tras verificar.</em></p>",
  ].join(""),
};

console.log("=".repeat(72));
console.log(
  `[probe:lemlist-add-step] mode: ${shouldExecute ? "EXECUTE" : "DRY-RUN"}`,
);
console.log(
  `[probe:lemlist-add-step] docs: https://developer.lemlist.com/api-reference/endpoints/sequences/add-step-to-sequence.md`,
);
console.log("=".repeat(72));

console.log("\n[plan] step body candidato (usado en ambos POST):");
console.log(
  JSON.stringify(candidateStepBody, null, 2)
    .split("\n")
    .map((l) => "  " + l)
    .join("\n"),
);

console.log("\n[plan] secuencia de llamadas:");
console.log("  1. GET  /api/campaigns/<CID>/sequences  → captura sequenceId (y estado inicial)");
console.log("  2. POST /api/sequences/<SID>/steps       → primer intento (body arriba)");
console.log("  3. GET  /api/campaigns/<CID>/sequences  → verifica step insertado + shape completo");
console.log("  4. POST /api/sequences/<SID>/steps       → SEGUNDO intento MISMO body");
console.log("  5. GET  /api/campaigns/<CID>/sequences  → decide idempotencia (¿duplica?)");

if (!shouldExecute) {
  console.log("\n" + "=".repeat(72));
  console.log("[probe:lemlist-add-step] DRY-RUN: no se ha hecho ninguna peticion.");
  console.log(
    "[probe:lemlist-add-step] Para ejecutar contra una campana de prueba:",
  );
  console.log(
    '    LEMLIST_CAMPAIGN_ID=cam_xxx EXECUTE=1 npm run probe:lemlist-add-step',
  );
  console.log("=".repeat(72));
  process.exit(0);
}

// ===== EXECUTE =====

if (!campaignId) {
  console.error(
    "\n[abort] EXECUTE=1 requiere LEMLIST_CAMPAIGN_ID. Crea una campana PROBE en draft en la UI de Lemlist y pasa su _id.",
  );
  process.exit(1);
}

// Guard: nombre debe empezar por PROBE. Evita disparar contra Smoke 50 o
// cualquier campana real por error.
const nameCheck = await doRequest(
  "guard: GET /campaigns/:cid (verifica nombre PROBE + status draft)",
  "GET",
  `${BASE}/campaigns/${campaignId}`,
  null,
);
if (!nameCheck.res.ok) {
  console.error("\n[abort] GET campana fallo. No procedo.");
  process.exit(1);
}
const nameCheckParsed = safeParse(nameCheck.text);
const name = nameCheckParsed?.name;
const status = nameCheckParsed?.status;
if (typeof name !== "string" || !name.toUpperCase().startsWith("PROBE")) {
  console.error(
    `\n[abort] La campana "${name}" no empieza por "PROBE". Este probe rehusa ejecutar contra campanas reales. Aborto sin tocar nada.`,
  );
  process.exit(1);
}
if (status !== "draft" && status !== "paused") {
  console.error(
    `\n[abort] La campana esta en status "${status}", no en draft/paused. Aborto para no tocar campana activa.`,
  );
  process.exit(1);
}
console.log(
  `\n[guard] OK: campana "${name}" status "${status}" — safe para escribir.`,
);

// 1. GET sequences para capturar sequenceId y estado inicial.
const seq0 = await doRequest(
  "1. GET /campaigns/:cid/sequences (estado inicial)",
  "GET",
  `${BASE}/campaigns/${campaignId}/sequences`,
  null,
);
if (!seq0.res.ok) {
  console.error("\n[abort] no pude leer sequences iniciales.");
  process.exit(1);
}
const seq0Parsed = safeParse(seq0.text);
const sequenceIds = seq0Parsed ? Object.keys(seq0Parsed) : [];
if (sequenceIds.length === 0) {
  console.error(
    "\n[abort] la campana no tiene sequenceId en la respuesta. Inesperado.",
  );
  process.exit(1);
}
const sequenceId = sequenceIds[0];
const initialSteps = seq0Parsed[sequenceId]?.steps ?? [];
console.log(
  `\n[info] sequenceId: ${sequenceId} — steps iniciales: ${initialSteps.length}`,
);

// 2. POST primer step.
const post1 = await doRequest(
  "2. POST /sequences/:sid/steps (primer intento)",
  "POST",
  `${BASE}/sequences/${sequenceId}/steps`,
  candidateStepBody,
);
if (!post1.res.ok) {
  console.error(
    "\n[abort] primer POST fallo. Endpoint quiza distinto o el body no encaja.",
  );
  process.exit(1);
}
const post1Parsed = safeParse(post1.text);
console.log(
  `\n[info] step creado _id: ${post1Parsed?._id ?? "(no _id en response)"}`,
);

// 3. GET verifica.
const seq1 = await doRequest(
  "3. GET /campaigns/:cid/sequences (tras primer POST)",
  "GET",
  `${BASE}/campaigns/${campaignId}/sequences`,
  null,
);
const seq1Parsed = safeParse(seq1.text);
const afterFirstSteps = seq1Parsed?.[sequenceId]?.steps ?? [];
console.log(
  `\n[info] steps tras primer POST: ${afterFirstSteps.length} (delta: +${afterFirstSteps.length - initialSteps.length})`,
);

// 4. POST segundo intento (mismo body).
const post2 = await doRequest(
  "4. POST /sequences/:sid/steps (SEGUNDO intento, MISMO body — test de idempotencia)",
  "POST",
  `${BASE}/sequences/${sequenceId}/steps`,
  candidateStepBody,
);
safeParse(post2.text); // parse defensivo; no lo consumimos (basta status)

// 5. GET final para el veredicto.
const seq2 = await doRequest(
  "5. GET /campaigns/:cid/sequences (tras segundo POST)",
  "GET",
  `${BASE}/campaigns/${campaignId}/sequences`,
  null,
);
const seq2Parsed = safeParse(seq2.text);
const afterSecondSteps = seq2Parsed?.[sequenceId]?.steps ?? [];

// ===== Veredicto =====
console.log("\n" + "-".repeat(72));
console.log(`[veredicto] steps iniciales:    ${initialSteps.length}`);
console.log(`[veredicto] tras primer POST:   ${afterFirstSteps.length}`);
console.log(`[veredicto] tras segundo POST:  ${afterSecondSteps.length}`);
console.log(
  `[veredicto] segundo POST status: ${post2.res.status} ${post2.res.statusText}`,
);

const deltaFirst = afterFirstSteps.length - initialSteps.length;
const deltaSecond = afterSecondSteps.length - afterFirstSteps.length;
if (deltaFirst === 1 && deltaSecond === 1) {
  console.log(
    "\n[veredicto] IDEMPOTENCIA: NO — el segundo POST duplica el step.",
  );
  console.log(
    "[veredicto] El step de Inngest upload-sequence-steps DEBE: (a) GET sequences primero, (b) skipear si ya hay un step con el mismo subject/index/type.",
  );
} else if (deltaFirst === 1 && deltaSecond === 0 && post2.res.ok) {
  console.log(
    "\n[veredicto] IDEMPOTENCIA: SÍ — el segundo POST NO duplica (Lemlist dedupe internamente).",
  );
  console.log(
    "[veredicto] El step de Inngest upload-sequence-steps puede POSTear sin guard adicional.",
  );
} else if (deltaFirst === 1 && !post2.res.ok) {
  console.log(
    `\n[veredicto] IDEMPOTENCIA: por RECHAZO — Lemlist devuelve ${post2.res.status} en el segundo POST.`,
  );
  console.log(
    "[veredicto] El step de Inngest debe swallowear ese status (patrón similar a addLead 400/409 'already').",
  );
} else {
  console.log(
    `\n[veredicto] RESULTADO INESPERADO. Deltas: primer=${deltaFirst}, segundo=${deltaSecond}. Inspecta manualmente arriba.`,
  );
}

// Shape del primer step creado (para el mapper de Volt).
if (afterFirstSteps[0]) {
  console.log("\n[shape] primer step de la respuesta GET (para el mapper):");
  console.log(
    JSON.stringify(afterFirstSteps[0], null, 2)
      .split("\n")
      .map((l) => "  " + l)
      .join("\n"),
  );
}

console.log("\n" + "=".repeat(72));
console.log("[probe:lemlist-add-step] DONE.");
console.log(`  campana:   ${campaignId} (${name})`);
console.log(`  sequenceId: ${sequenceId}`);
console.log(
  `  steps creados por este probe: ${afterSecondSteps.length - initialSteps.length}`,
);
console.log("");
console.log(
  "LIMPIEZA MANUAL: borra los steps creados desde la UI de Lemlist (o via",
);
console.log(
  "  DELETE /sequences/:sid/steps/:stpId si prefieres — ver endpoint",
);
console.log(
  "  delete-sequence-step en developer.lemlist.com).",
);
console.log("=".repeat(72));
