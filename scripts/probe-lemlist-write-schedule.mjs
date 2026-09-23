// OUTPILOT v2 — Lemlist schedule-protocol probe (T018)
// -----------------------------------------------------------------------------
// Descubre si Lemlist soporta DOS ventanas M-X-J via schedules asociados a
// una campana. Con salvaguarda: antes de PATCHear el Default schedule
// auto-creado, compara su _id contra el que salio en el probe anterior
// (cam_ZuDPsSs2e7m2ttX7N → scheduleIds=["skd_TkHddyqKQCW3qjCx9"]) para
// distinguir schedules per-campana vs team-shared. Si es team-shared,
// NO se PATCHea (dañaria otras campanas): en vez de eso se crean dos
// nuevos y se asocian.
//
// Rutas de ejecucion:
//   Path A (per-campana, _id distinto): PATCH default → window 1, POST
//                                        window 2, asociar. Verdict.
//   Path B (team-shared, _id igual):    SKIP PATCH. POST window 1, POST
//                                        window 2, asociar ambos. Verdict.
//
// NO llama a start/resume/launch. Campana sin leads. Todos los _id se
// imprimen al final para borrado manual.

const BASE = "https://api.lemlist.com/api";

// Referencia del probe anterior. Si la campana nueva devuelve el MISMO
// _id de Default schedule, los schedules son team-shared → NO PATCHear.
const PREVIOUS_DEFAULT_SCHEDULE_ID = "skd_TkHddyqKQCW3qjCx9";

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

const createCampaignBody = {
  name: campaignName,
  senderStrategy: "random",
};

// Payloads reusables por ambas paths.
const window1Fields = {
  name: "Volt morning 09-11 (M-X-J)",
  timezone: "Europe/Madrid",
  start: "09:00",
  end: "11:00",
  weekdays: [2, 3, 4],
};

const window2Fields = {
  name: "Volt afternoon 15-17 (M-X-J)",
  timezone: "Europe/Madrid",
  start: "15:00",
  end: "17:00",
  weekdays: [2, 3, 4],
};

// PATCH parcial (Path A). Sin secondsToWait (ya es 1200 en el default).
const patchWindow1Body = { ...window1Fields };

// POST completo (Path B para w1 y w2, o Path A para w2). Incluye
// secondsToWait explicito.
const createWindow1Body = { ...window1Fields, secondsToWait: 1200 };
const createWindow2Body = { ...window2Fields, secondsToWait: 1200 };

const SAFE_STATES = new Set(["draft", "paused"]);

// ===== Plan (dry-run) =====

const planned = [
  {
    step: "1. POST /campaigns — crea campana draft (body minimo)",
    method: "POST",
    url: `${BASE}/campaigns`,
    body: createCampaignBody,
    notes: "Sin schedule embebido (ya sabemos que se ignora).",
  },
  {
    step: "2. GET /campaigns/:cid — STATE GATE (draft|paused)",
    method: "GET",
    url: `${BASE}/campaigns/<CID>`,
    body: null,
    notes: "Si status no es draft/paused, aborta antes de tocar schedules.",
  },
  {
    step: "3. GET /campaigns/:cid/schedules — captura Default schedule + SAFEGUARD",
    method: "GET",
    url: `${BASE}/campaigns/<CID>/schedules`,
    body: null,
    notes:
      `Compara Default._id con ${PREVIOUS_DEFAULT_SCHEDULE_ID} (del probe anterior). ` +
      "Si es DISTINTO → per-campana → Path A. Si es IGUAL → team-shared → Path B (skip PATCH).",
  },
  {
    step: "4A. [PATH A] PATCH /schedules/:defaultId — window 1 (solo si per-campana)",
    method: "PATCH",
    url: `${BASE}/schedules/<DEFAULT_SID>`,
    body: patchWindow1Body,
    notes: "SOLO se ejecuta si Path A. En Path B se salta para no danar otras campanas.",
  },
  {
    step: "4B. [PATH B] POST /schedules — window 1 (solo si team-shared)",
    method: "POST",
    url: `${BASE}/schedules`,
    body: createWindow1Body,
    notes: "SOLO se ejecuta si Path B. Crea la ventana 1 como schedule nuevo.",
  },
  {
    step: "5. POST /schedules — window 2 (ambas paths)",
    method: "POST",
    url: `${BASE}/schedules`,
    body: createWindow2Body,
    notes: "Crea el schedule de tarde en ambas paths.",
  },
  {
    step: "6. POST /campaigns/:cid/schedules/:sid — asociar (body vacio)",
    method: "POST",
    url: `${BASE}/campaigns/<CID>/schedules/<SID>`,
    body: null,
    notes:
      "Path A: asocia solo window 2 (la 1 ya esta por el PATCH sobre el default). " +
      "Path B: asocia window 1 Y window 2.",
  },
  {
    step: "7. GET /campaigns/:cid/schedules — verdict final",
    method: "GET",
    url: `${BASE}/campaigns/<CID>/schedules`,
    body: null,
    notes:
      "Path A: 2 items → dos ventanas conviven; 1 → colapsar. " +
      "Path B: 3 items (default team + w1 + w2) → conviven; menos → colapsar.",
  },
];

console.log("=".repeat(72));
console.log(
  `[probe:lemlist-write-schedule] mode: ${shouldExecute ? "EXECUTE" : "DRY-RUN"}`,
);
console.log(`[probe:lemlist-write-schedule] campaign name: ${campaignName}`);
console.log(
  `[probe:lemlist-write-schedule] previous Default _id ref: ${PREVIOUS_DEFAULT_SCHEDULE_ID}`,
);
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
  console.error(`[abort] Estado inesperado "${state}". No procedo con schedules.`);
  console.error(`[abort] campana: ${campaignId} (${campaignName}) — BORRAR A MANO.`);
  console.error("=".repeat(72));
  process.exit(1);
}
console.log(`\n[gate] estado "${state}" OK. Continuo.`);

// ===== Step 3: captura Default schedule + SAFEGUARD =====

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

const path =
  defaultScheduleId === PREVIOUS_DEFAULT_SCHEDULE_ID
    ? "team-shared"
    : "per-campaign";

console.log("");
console.log(`[safeguard] Default schedule _id: ${defaultScheduleId}`);
console.log(`[safeguard] Referencia probe anterior: ${PREVIOUS_DEFAULT_SCHEDULE_ID}`);
console.log(
  `[safeguard] → PATH ${path === "per-campaign" ? "A (per-campaign)" : "B (team-shared)"} — ` +
    (path === "per-campaign"
      ? "PATCH del default es seguro."
      : "PATCH DAÑARIA otras campanas. SKIP PATCH; creamos dos schedules nuevos."),
);

// ===== Path A: PATCH default → w1, POST → w2, associate w2 =====
// ===== Path B: POST → w1, POST → w2, associate BOTH               =====

let firstScheduleId = null; // Solo se rellena en Path B (w1 nueva)
let secondScheduleId = null;

if (path === "per-campaign") {
  // 4A. PATCH default → window 1
  await doRequest(
    "4A. PATCH /schedules/:defaultId — window 1 (PATH A)",
    "PATCH",
    `${BASE}/schedules/${defaultScheduleId}`,
    patchWindow1Body,
  );
} else {
  // 4B. POST → window 1 nueva
  const w1Res = await doRequest(
    "4B. POST /schedules — window 1 (PATH B, skip PATCH)",
    "POST",
    `${BASE}/schedules`,
    createWindow1Body,
  );
  if (w1Res.res.ok) {
    firstScheduleId = safeParse(w1Res.text)?._id ?? null;
  }
  if (!firstScheduleId) {
    console.error(
      "\n[warn] Path B: POST /schedules (w1) no devolvio _id. Continuo con w2 y GET final.",
    );
  }
}

// 5. POST → window 2 (ambas paths)
const w2Res = await doRequest(
  "5. POST /schedules — window 2",
  "POST",
  `${BASE}/schedules`,
  createWindow2Body,
);
if (w2Res.res.ok) {
  secondScheduleId = safeParse(w2Res.text)?._id ?? null;
}
if (!secondScheduleId) {
  console.error(
    "\n[warn] step 5: POST /schedules (w2) no devolvio _id. Sigo al GET final.",
  );
}

// 6. asociar
if (path === "per-campaign") {
  if (secondScheduleId) {
    await doRequest(
      "6. POST /campaigns/:cid/schedules/:sid2 — asociar w2 (PATH A)",
      "POST",
      `${BASE}/campaigns/${campaignId}/schedules/${secondScheduleId}`,
      null,
    );
  }
} else {
  if (firstScheduleId) {
    await doRequest(
      "6a. POST /campaigns/:cid/schedules/:sid1 — asociar w1 (PATH B)",
      "POST",
      `${BASE}/campaigns/${campaignId}/schedules/${firstScheduleId}`,
      null,
    );
  }
  if (secondScheduleId) {
    await doRequest(
      "6b. POST /campaigns/:cid/schedules/:sid2 — asociar w2 (PATH B)",
      "POST",
      `${BASE}/campaigns/${campaignId}/schedules/${secondScheduleId}`,
      null,
    );
  }
}

// 7. GET final — verdict
const schedulesFinal = await doRequest(
  "7. GET /campaigns/:cid/schedules — verdict final",
  "GET",
  `${BASE}/campaigns/${campaignId}/schedules`,
  null,
);
const finalArr = safeParse(schedulesFinal.text);

console.log("\n" + "-".repeat(72));
console.log(`[verdict] path tomada: ${path.toUpperCase()}`);
if (Array.isArray(finalArr)) {
  console.log(`  items en /schedules tras asociar: ${finalArr.length}`);
  for (const s of finalArr) {
    console.log(
      `    _id=${s._id} name="${s.name}" tz=${s.timezone} wd=${JSON.stringify(s.weekdays)} start=${s.start} end=${s.end} secToWait=${s.secondsToWait}`,
    );
  }
  const expected = path === "per-campaign" ? 2 : 3;
  if (finalArr.length >= expected) {
    console.log(
      `  → RESULTADO: schedules conviven (${finalArr.length} >= ${expected}). ` +
        "Spec §4 preservable — upsertCampaign construira las ventanas via " +
        (path === "per-campaign" ? "PATCH+POST" : "2 POST + associate") +
        (path === "team-shared"
          ? " y deja el default team-shared sin tocar."
          : "."),
    );
  } else {
    console.log(
      `  → RESULTADO: menos schedules de los esperados (${finalArr.length} < ${expected}). ` +
        "Colapsar a UNA ventana 09:00-17:00 M-X-J con secondsToWait 1200 " +
        "y anadir nota R2 en spec §4.",
    );
  }
} else {
  console.log("  final response no es array — inspeccion manual.");
}
console.log("-".repeat(72));

// ===== Recap para borrado manual =====

console.log("\n" + "=".repeat(72));
console.log("[probe:lemlist-write-schedule] DONE.");
console.log(`  campana:            ${campaignId} (${campaignName})`);
console.log(`  Default schedule:   ${defaultScheduleId}  (${path === "per-campaign" ? "PATCHeado" : "NO tocado — team-shared"})`);
if (firstScheduleId) {
  console.log(`  Window 1 (nueva):   ${firstScheduleId}`);
}
if (secondScheduleId) {
  console.log(`  Window 2 (nueva):   ${secondScheduleId}`);
}
console.log("");
console.log("BORRAR A MANO en https://app.lemlist.com:");
console.log("  - la campana");
console.log(
  "  - los schedules pueden desaparecer al borrar la campana o quedar huerfanos.",
);
console.log(
  "  Si quedan huerfanos: DELETE /schedules/:id (curl con la key en Basic).",
);
if (path === "team-shared") {
  console.log(
    "  ⚠️ NO borres el Default team-shared: pertenece a la cuenta, lo usan otras campanas.",
  );
}
console.log("=".repeat(72));
