// OUTPILOT v2 — Volt sync preview (T023)
// -----------------------------------------------------------------------------
// Dry-run PURO: lee el estado real de BD y compone los bodies EXACTOS
// que Volt enviaría a Lemlist para una campaña dada. No hay modo
// EXECUTE — el POST real lo hace el botón de la UI de /campaigns.
//
// Cubre las dos fases del gate T023:
//   Fase A: create-campaign → POST /campaigns, PATCH/POST schedules,
//           POST /sequences/:sid/steps × N.
//   Fase B: sync-leads → addLead × M con opener resuelto (personalized
//           o generic con {{companyName}} sustituido).
//
// Uso:
//   CAMPAIGN_ID=<uuid> npm run probe:volt-sync-preview
//
// CAMPAIGN_ID es el uuid de campaigns.id en Supabase (no el cam_...
// de Lemlist). El script resuelve provider_external_id y sequence
// desde BD, y usa fixtures anonimizados de los leads (email y nombre
// se marcan como <PII_LEAD_i>) para no volcar datos personales al
// stdout. Solo el opener resuelto se muestra completo (es lo que
// enviamos a Lemlist; ya está sanitizado o es fallback).

import { createClient } from "@supabase/supabase-js";

const CAMPAIGN_ID = process.env.CAMPAIGN_ID?.trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const LEMLIST_KEY = process.env.LEMLIST_API_KEY;

if (!CAMPAIGN_ID) {
  console.error(
    "[probe:volt-sync-preview] CAMPAIGN_ID no está en el entorno. Uso:",
  );
  console.error("  CAMPAIGN_ID=<uuid> npm run probe:volt-sync-preview");
  process.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "[probe:volt-sync-preview] Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env.local.",
  );
  process.exit(1);
}
if (!LEMLIST_KEY) {
  console.error(
    "[probe:volt-sync-preview] LEMLIST_API_KEY no configurada — el preview solo compone bodies; no llama a Lemlist, pero anota que faltará en el runtime.",
  );
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// ===== Config Volt (mismos valores que src/config/lemlist.ts) =====
const VOLT_SCHEDULES = [
  {
    name: "Volt morning 09-11 (M-X-J)",
    timezone: "Europe/Madrid",
    start: "09:00",
    end: "11:00",
    weekdays: [2, 3, 4],
    secondsToWait: 1200,
  },
  {
    name: "Volt afternoon 15-17 (M-X-J)",
    timezone: "Europe/Madrid",
    start: "15:00",
    end: "17:00",
    weekdays: [2, 3, 4],
    secondsToWait: 1200,
  },
];

const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
function substituteLeadVars(text, lead) {
  return text.replace(VAR_PATTERN, (match, name) => {
    switch (name) {
      case "firstName":
        return lead.first_name ?? "";
      case "lastName":
        return lead.last_name ?? "";
      case "companyName":
        return lead.company ?? "";
      default:
        return match;
    }
  });
}

function resolveOpener(personalization, openerFallback, lead) {
  if (!personalization || typeof personalization !== "object") {
    return { opener: "(ERROR: sin personalization)", source: "error" };
  }
  if (personalization.personalization === "personalized") {
    return { opener: personalization.opener ?? "", source: "personalized" };
  }
  if (personalization.personalization === "generic") {
    return {
      opener: substituteLeadVars(openerFallback, lead),
      source: "generic (fallback + companyName sustituido)",
    };
  }
  return {
    opener: `(ERROR: personalization desconocida: ${personalization.state ?? "?"})`,
    source: "error",
  };
}

// ===== Load campaign =====
const { data: campaign, error: campErr } = await supabase
  .from("campaigns")
  .select("id, name, status, provider_external_id, sequence")
  .eq("id", CAMPAIGN_ID)
  .maybeSingle();
if (campErr) {
  console.error("[preview] load campaign failed:", campErr.message);
  process.exit(1);
}
if (!campaign) {
  console.error(`[preview] campaign ${CAMPAIGN_ID} no encontrada.`);
  process.exit(1);
}

const seq = campaign.sequence ?? {};
const sequenceSteps = Array.isArray(seq.steps) ? seq.steps : [];
const openerFallback = seq.openerFallback ?? "";

console.log("=".repeat(72));
console.log("[probe:volt-sync-preview] mode: DRY-RUN (no POST a Lemlist)");
console.log(`[preview] campaign.id: ${campaign.id}`);
console.log(`[preview] campaign.name: ${campaign.name}`);
console.log(`[preview] campaign.status: ${campaign.status}`);
console.log(
  `[preview] provider_external_id: ${campaign.provider_external_id ?? "(null — falta create-campaign)"}`,
);
console.log(`[preview] sequence steps: ${sequenceSteps.length}`);
console.log(`[preview] openerFallback len: ${openerFallback.length}`);
console.log("=".repeat(72));

// ===== Fase A: Create campaign =====
console.log("\n----- FASE A: create-campaign (Volt job) -----");
if (campaign.provider_external_id) {
  console.log(
    `[fase A] SKIP — campaign ya sincronizada (provider_external_id=${campaign.provider_external_id}).`,
  );
  console.log(
    `[fase A] Un re-trigger de volt-create-campaign sería idempotente:`,
  );
  console.log("  - skip POST /campaigns (guard)");
  console.log("  - PATCH default schedule (idempotente por naturaleza)");
  console.log("  - ensure window 2 (skip create + associate si ya existe)");
  console.log("  - upload-step-i: skip si posición i tiene mismo subject");
} else {
  console.log("\n[fase A] POST /api/campaigns");
  console.log("  body:");
  const createBody = { name: campaign.name, senderStrategy: "random" };
  console.log(indent(JSON.stringify(createBody, null, 2), 4));

  console.log("\n[fase A] GET /api/campaigns/<newCid>/schedules");
  console.log(
    "  (para capturar defaultScheduleId auto-creado por Lemlist)",
  );

  console.log("\n[fase A] PATCH /api/schedules/<defaultId>");
  console.log("  body (window 1):");
  console.log(indent(JSON.stringify(VOLT_SCHEDULES[0], null, 2), 4));

  console.log("\n[fase A] ensure-window-2:");
  console.log("  - GET /api/campaigns/<newCid>/schedules");
  console.log(
    "  - Si ya existe una con start=15:00/end=17:00/weekdays=[2,3,4]/timezone=Europe/Madrid → skip.",
  );
  console.log("  - Si no, POST /api/schedules:");
  console.log(indent(JSON.stringify(VOLT_SCHEDULES[1], null, 2), 4));
  console.log(
    "  - Después POST /api/campaigns/<newCid>/schedules/<newSid> (asociar).",
  );

  console.log(
    `\n[fase A] upload sequence steps (${sequenceSteps.length}): un step.run por step, GET fresco antes de cada uno.`,
  );
  sequenceSteps.forEach((s, i) => {
    console.log(
      `\n[fase A] POST /api/sequences/<seqId>/steps (index ${i + 1})`,
    );
    const body = {
      type: "email",
      subject: s.subject,
      message: s.bodyHtml,
      delay: s.delayDays,
    };
    // Truncar bodyHtml para stdout limpio (el runtime envía completo).
    const preview = {
      ...body,
      message:
        body.message.length > 200
          ? body.message.slice(0, 200) + `… [truncated ${body.message.length}B]`
          : body.message,
    };
    console.log(indent(JSON.stringify(preview, null, 2), 4));
  });
}

// ===== Fase B: Sync leads =====
console.log("\n----- FASE B: sync-leads (Volt job) -----");
if (!campaign.provider_external_id) {
  console.log(
    "[fase B] SKIP — Fase A no aplicada. Aplicar create-campaign primero desde el botón.",
  );
} else {
  console.log("\n[fase B] assert-campaign-not-running:");
  console.log(
    `  GET /api/campaigns/${campaign.provider_external_id} → status debe estar en {draft, paused, ...}, NO en {running, started, active}.`,
  );

  const { data: leads, error: leadsErr } = await supabase
    .from("campaign_leads")
    .select("id, personalization, lead:leads!inner(email, first_name, last_name, company)")
    .eq("campaign_id", CAMPAIGN_ID)
    .is("provider_lead_id", null)
    .is("removed_at", null)
    .not("personalization", "is", null);
  if (leadsErr) {
    console.error("[fase B] load leads failed:", leadsErr.message);
    process.exit(1);
  }

  let syncable = 0;
  let excludedNoCompany = 0;
  let excludedProcessing = 0;
  const bodies = [];

  for (const row of leads ?? []) {
    const p = row.personalization;
    if (p && typeof p === "object" && p.state === "processing") {
      excludedProcessing += 1;
      continue;
    }
    const lead = row.lead;
    if (!lead?.company || lead.company.trim() === "") {
      excludedNoCompany += 1;
      continue;
    }
    syncable += 1;
    const { opener, source } = resolveOpener(p, openerFallback, lead);
    const idx = bodies.length + 1;
    bodies.push({
      leadPii: `<PII_LEAD_${idx}>`,
      email: `<PII_EMAIL_${idx}>`,
      firstName: `<PII_FIRST_${idx}>`,
      lastName: `<PII_LAST_${idx}>`,
      company: `<PII_COMPANY_${idx}>` /* substitución solo en logs; el POST real envía el valor de BD */,
      openerSource: source,
      openerPreview:
        opener.length > 300 ? opener.slice(0, 300) + "…" : opener,
    });
  }

  console.log(
    `\n[fase B] leads del load-pending-leads: ${(leads ?? []).length}`,
  );
  console.log(`  syncable:              ${syncable}`);
  console.log(`  excluidos (no company): ${excludedNoCompany}`);
  console.log(`  excluidos (processing): ${excludedProcessing}`);

  for (let i = 0; i < bodies.length; i += 1) {
    const b = bodies[i];
    console.log(
      `\n[fase B] POST /api/campaigns/${campaign.provider_external_id}/leads/${b.email}`,
    );
    console.log("  body (PII redacted; los valores reales van al POST):");
    console.log(
      indent(
        JSON.stringify(
          {
            firstName: b.firstName,
            lastName: b.lastName,
            companyName: b.company,
            opener: `[${b.openerSource}] ${b.openerPreview}`,
          },
          null,
          2,
        ),
        4,
      ),
    );
  }
}

console.log("\n" + "=".repeat(72));
console.log(
  "[probe:volt-sync-preview] DRY-RUN completado. Cero POST a Lemlist.",
);
console.log(
  "[probe:volt-sync-preview] Si los bodies son correctos, dispara desde /campaigns:",
);
console.log(
  '  1. "Crear en Lemlist" (si provider_external_id era null) →',
);
console.log(
  "     esto crea la campaña, los 2 schedules y sube los sequence steps.",
);
console.log(
  '  2. "Sincronizar N leads" → añade los leads con el opener resuelto.',
);
console.log("=".repeat(72));

function indent(text, spaces) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
