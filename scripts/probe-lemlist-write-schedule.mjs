// OUTPILOT v2 — Lemlist schedule-protocol probe (T018)
// -----------------------------------------------------------------------------
// Descubre si Lemlist soporta DOS ventanas M-X-J (9-11 y 15-17) via dos
// schedules asociados a una misma campana, o si el segundo reemplaza al
// primero. Ejecuta:
//
//   1.  POST /campaigns              crea campana draft (body minimo)
//   2.  GET  /campaigns/:cid         STATE GATE (draft|paused)
//   3.  GET  /campaigns/:cid/schedules  captura el "Default schedule"
//                                      auto-creado por Lemlist
//   4.  PATCH /schedules/:defaultId  window 1: Europe/Madrid, [2,3,4],
//                                      09:00-11:00 (secondsToWait ya es
//                                      1200 por default)
//   5.  POST /schedules              window 2: Europe/Madrid, [2,3,4],
//                                      15:00-17:00, secondsToWait 1200
//   6.  POST /campaigns/:cid/schedules/:sid2  asocia window 2 a la
//                                              campana
//   7.  GET  /campaigns/:cid/schedules  verdict final: 1 o 2 items?
//
// NO llama a start/resume/schedule-launch. La campana no tendra leads.
// Todos los _id (campana + schedules) se imprimen al final para que
// Pere borre a mano.
//
// SEGURIDAD:
// - Dry-run POR DEFECTO. Imprime plan + bodies y sale.
// - Para ejecutar: EXECUTE=1 o --execute.
// - Key redactada.
// - Si el STATE GATE falla, aborta antes del PATCH/POST/asociacion.

const BASE = "https://api.lemlist.com/api";

const key = process.env.LEMLIST_API_KEY;
if (!key || key.trim() === "") {
  console.error(
    "[probe:lemlist-write-schedule] LEMLIST_API_KEY no esta en el entorno.",
  );
  process.exit(1);
}

const shouldExecute =
  process.env.EXECUTE === "1" || process.argv.includes("--execute");

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const campaignName = `PROBE-T018-SCHED-${timestamp}`;

// Body minimo para crear la campana (aprendido del probe anterior: el
// schedule embebido se ignora, asi que no lo incluimos).
const createCampaignBody = {
  name: campaignName,
  senderStrategy: "random",
};

// PATCH parcial sobre el schedule auto-creado. Solo los campos que
// queremos cambiar; el resto lo dejamos como Lemlist lo puso.
const patchWindow1Body = {
  name: "Volt morning 09-11 (M-X-J)",
  timezone: "Europe/Madrid",
  start: "09:00",
  end: "11:00",
  weekdays: [2, 3, 4],
};

// POST del segundo schedule (ventana de tarde).
const createWindow2Body = {
  name: "Volt afternoon 15-17 (M-X-J)",
  timezone: "Europe/Madrid",
  start: "15:00",
  end: "17:00",
  weekdays: [2, 3, 4],
  secondsToWait: 1200,
};

const SAFE_STATES = new Set(["draft", "paused"]);

// ===== Plan (dry-run) =====

const planned = [
  {
    step: "1. Crear campana draft (POST /campaigns) — body minimo",
    method: "POST",
    url: `${BASE}/campaigns`,
    body: createCampaignBody,
    notes:
      "Sin schedule embebido (aprendido: se ignora). Sin secuencia, sin leads.",
  },
  {
    step: "2. GET /campaigns/:cid — STATE GATE",
    method: "GET",
    url: `${BASE}/campaigns/<CID>`,
    body: null,
    notes: "status debe ser draft|paused. Si no, aborta antes de tocar schedules.",
  },
  {
    step: "3. GET /campaigns/:cid/schedules — captura Default schedule",
    method: "GET",
    url: `${BASE}/campaigns/<CID>/schedules`,
    body: null,
    notes:
      "Espera 1 item (Default schedule auto-creado por Lemlist). Captura su _id.",
  },
  {
    step: "4. PATCH /schedules/:defaultId — window 1 (09-11 M-X-J)",
    method: "PATCH",
    url: `${BASE}/schedules/<DEFAULT_SID>`,
    body: patchWindow1Body,
    notes: "Cambia timezone, weekdays, start, end. Deja secondsToWait (ya 1200).",
  },
  {
    step: "5. POST /schedules — window 2 (15-17 M-X-J)",
    method: "POST",
    url: `${BASE}/schedules`,
    body: createWindow2Body,
    notes: "Crea el segundo schedule. Captura su _id.",
  },
  {
    step: "6. POST /campaigns/:cid/schedules/:sid2 — asociar window 2",
    method: "POST",
    url: `${BASE}/campaigns/<CID>/schedules/<SID2>`,
    body: null,
    notes: "Body vacio. Une el segundo schedule a la campana.",
  },
  {
    step: "7. GET /campaigns/:cid/schedules — verdict final",
    method: "GET",
    url: `${BASE}/campaigns/<CID>/schedules`,
    body: null,
    notes:
      "Si el array final tiene 2 items → dos ventanas conviven, spec preservada. " +
      "Si tiene 1 → el segundo reemplazo al primero; hay que colapsar a 1 ventana + R2.",
  },
];

console.log("=".repeat(72));
console.log(
  `[probe:lemlist-write-schedule] mode: ${shouldExecute ? "EXECUTE" : "DRY-RUN"}`,
);
console.log(`[probe:lemlist-write-schedule] campaign name: ${campaignName}`);
console.log(
  `[probe:lemlist-write-schedule] safe states para continuar: ${[...SAFE_STATES].join(", ")}`,
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
  console.log(
    "[probe:lemlist-write-schedule] DRY-RUN: no se ha hecho ninguna peticion.",
  );
  console.log(
    "[probe:lemlist-write-schedule] Para ejecutar: EXECUTE=1 npm run probe:lemlist-write-schedule",
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

// ===== Step 1: crear campana =====

const created = await doRequest(
  "1. crear campana draft",
  "POST",
  `${BASE}/campaigns`,
  createCampaignBody,
);
if (!created.res.ok) {
  console.error(
    "\n[probe:lemlist-write-schedule] step 1 fallo. Aborto — no hay campana que borrar.",
  );
  process.exit(1);
}
const createdParsed = safeParse(created.text);
const campaignId = createdParsed?._id;
if (!campaignId) {
  console.error("[probe:lemlist-write-schedule] step 1 response sin _id. Aborto.");
  process.exit(1);
}

// ===== Step 2: STATE GATE =====

const detail = await doRequest(
  "2. GET detalle — STATE GATE",
  "GET",
  `${BASE}/campaigns/${campaignId}`,
  null,
);
const detailParsed = safeParse(detail.text);
const state = String(detailParsed?.status ?? "").toLowerCase();
if (!SAFE_STATES.has(state)) {
  console.error("\n" + "=".repeat(72));
  console.error(
    `[abort] Estado inesperado "${state}". No procedo con schedules.`,
  );
  console.error(`[abort] campana: ${campaignId} (${campaignName}) — BORRAR A MANO.`);
  console.error("=".repeat(72));
  process.exit(1);
}
console.log(`\n[gate] estado "${state}" OK. Continuo.`);

// ===== Step 3: captura Default schedule =====

const schedules0 = await doRequest(
  "3. GET /schedules — captura Default schedule",
  "GET",
  `${BASE}/campaigns/${campaignId}/schedules`,
  null,
);
const schedules0Arr = safeParse(schedules0.text);
if (!Array.isArray(schedules0Arr) || schedules0Arr.length === 0) {
  console.error(
    "[probe:lemlist-write-schedule] step 3 no devolvio schedules — inesperado.",
  );
  console.error(`[abort] campana: ${campaignId} — BORRAR A MANO.`);
  process.exit(1);
}
const defaultScheduleId = schedules0Arr[0]?._id;
if (!defaultScheduleId) {
  console.error("[probe:lemlist-write-schedule] step 3 item sin _id. Aborto.");
  console.error(`[abort] campana: ${campaignId} — BORRAR A MANO.`);
  process.exit(1);
}
console.log(`\n[info] Default schedule id: ${defaultScheduleId}`);

// ===== Step 4: PATCH window 1 =====

const patched = await doRequest(
  "4. PATCH /schedules/:defaultId — window 1",
  "PATCH",
  `${BASE}/schedules/${defaultScheduleId}`,
  patchWindow1Body,
);

// ===== Step 5: POST window 2 =====

const created2 = await doRequest(
  "5. POST /schedules — window 2",
  "POST",
  `${BASE}/schedules`,
  createWindow2Body,
);
let secondScheduleId = null;
if (created2.res.ok) {
  const p = safeParse(created2.text);
  secondScheduleId = p?._id ?? null;
}
if (!secondScheduleId) {
  console.error(
    "\n[warn] step 5 no devolvio _id parseable. Sigo con el GET final para " +
      "reportar el estado, pero no puedo asociar.",
  );
}

// ===== Step 6: asociar window 2 =====

if (secondScheduleId) {
  await doRequest(
    "6. POST /campaigns/:cid/schedules/:sid2 — asociar",
    "POST",
    `${BASE}/campaigns/${campaignId}/schedules/${secondScheduleId}`,
    null,
  );
}

// ===== Step 7: GET final — verdict =====

const schedulesFinal = await doRequest(
  "7. GET /campaigns/:cid/schedules — verdict final",
  "GET",
  `${BASE}/campaigns/${campaignId}/schedules`,
  null,
);
const finalArr = safeParse(schedulesFinal.text);

console.log("\n" + "-".repeat(72));
console.log("[verdict] schedule multi-window handling:");
if (Array.isArray(finalArr)) {
  console.log(`  items en /schedules tras asociar window 2: ${finalArr.length}`);
  for (const s of finalArr) {
    console.log(
      `    _id=${s._id} name="${s.name}" tz=${s.timezone} weekdays=${JSON.stringify(s.weekdays)} start=${s.start} end=${s.end} secondsToWait=${s.secondsToWait}`,
    );
  }
  if (finalArr.length >= 2) {
    console.log(
      "  → RESULTADO: DOS SCHEDULES CONVIVEN. Spec §4 preservable — upsertCampaign " +
        "crea y asocia dos schedules (9-11 y 15-17).",
    );
  } else if (finalArr.length === 1) {
    console.log(
      "  → RESULTADO: SOLO UN SCHEDULE tras asociar el segundo. El segundo " +
        "reemplaza al primero. upsertCampaign colapsa a UNA ventana (9-17 " +
        "M-X-J, secondsToWait 1200) y anadimos nota R2 en spec §4.",
    );
  } else {
    console.log("  → RESULTADO: 0 items — inesperado. Revisa a mano.");
  }
} else {
  console.log("  final response no es array — inspeccion manual.");
}
console.log("-".repeat(72));

// ===== Final: recap de _ids para borrado manual =====

console.log("\n" + "=".repeat(72));
console.log("[probe:lemlist-write-schedule] DONE.");
console.log(`  campana:            ${campaignId} (${campaignName})`);
console.log(`  Default schedule:   ${defaultScheduleId}  (PATCHeado a window 1)`);
if (secondScheduleId) {
  console.log(`  Window 2 schedule:  ${secondScheduleId}`);
}
console.log("");
console.log("BORRAR A MANO en https://app.lemlist.com:");
console.log("  - la campana (arriba)");
console.log(
  "  - los schedules pueden desaparecer al borrar la campana, o quedar huerfanos.",
);
console.log("  Si quedan huerfanos: DELETE /schedules/:id via curl con la key.");
console.log("=".repeat(72));
