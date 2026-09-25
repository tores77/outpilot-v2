// OUTPILOT v2 — Import de outreach_exclusions desde Lemlist (T024)
//
// Fuentes:
//   1. Leads de 7 campañas históricas (pre-OUTPILOT) — se marcan con
//      reason = `previous_campaign:<cam_id>`.
//   2. Unsubscribes globales del team — reason = `unsubscribed`.
//
// Contract descubierto por probes (rate limit 20/min):
//   - GET /api/contacts?limit=500&offset=N  → {data:[{_id,email,...}], total, limit, offset}
//   - GET /api/campaigns/:cid/leads?limit=1000 → array de {_id, contactId, state}
//   - GET /api/unsubscribes?limit=1000 → array de {_id, value: email, source, createdAt}
//
// La API NO expone el email en el lead; se cruza `contactId` con el
// mapa global de contactos. Con 646 contactos y 703 leads en total,
// bastan ~10 requests para todo (bien dentro del rate limit).
//
// Escritura idempotente: INSERT ... ON CONFLICT (tenant_id, lower(email))
// DO NOTHING. PK protege re-runs. Guardamos el email TAL CUAL llega
// (trim aplicado) para trazabilidad; el lookup es case-insensitive.
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/import-outreach-exclusions.mjs
//   EXECUTE=1 node --env-file-if-exists=.env.local scripts/import-outreach-exclusions.mjs
//
// Vars requeridas:
//   - LEMLIST_API_KEY
//   - NEXT_PUBLIC_SUPABASE_URL
//   - SUPABASE_SERVICE_ROLE_KEY
//
// Opcional:
//   - TENANT_ID  (si no viene, se resuelve al primer tenant — v2.1 tiene 1)
//
// NUNCA imprime emails individuales — solo conteos agregados y 3 dominios
// de muestra por bucket.

import { createClient } from "@supabase/supabase-js";

// ==============================================================
// Config
// ==============================================================

const CAMPAIGNS = [
  "cam_HqLDL4Qzudu6S5fWp",
  "cam_z8M9jrazrfSyhTBGZ",
  "cam_Z2EHSZo2EQcC7JvvZ",
  "cam_JayNY9WrbS3Z3GEAn",
  "cam_wprwKDBSSHy4ZFEJ2",
  "cam_qhGWgNC48nHokWnzQ",
  "cam_EeYmer4TozM3TADbP",
];

const LEMLIST_BASE = "https://api.lemlist.com/api";
const CONTACTS_PAGE_SIZE = 500;
const LEADS_PAGE_SIZE = 1000;
const UNSUBS_PAGE_SIZE = 1000;
const EXECUTE = process.env.EXECUTE === "1";
const SOURCE_TAG = `import-outreach-exclusions.mjs @ ${new Date().toISOString().slice(0, 10)}`;

// ==============================================================
// Helpers
// ==============================================================

function requireEnv(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    console.error(`[import] falta env var ${name}`);
    process.exit(1);
  }
  return v;
}

function lemlistAuth() {
  const key = requireEnv("LEMLIST_API_KEY");
  const basic = Buffer.from(`:${key}`, "utf8").toString("base64");
  return { authorization: `Basic ${basic}`, accept: "application/json" };
}

async function lemlistGet(path) {
  const url = `${LEMLIST_BASE}${path}`;
  const res = await fetch(url, { headers: lemlistAuth() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Lemlist ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Lemlist ${path} → non-JSON body: ${text.slice(0, 200)}`);
  }
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!EMAIL_RE.test(t)) return null;
  return t;
}

function sampleDomains(emails, n) {
  const domains = new Map();
  for (const e of emails) {
    const dom = e.split("@")[1];
    domains.set(dom, (domains.get(dom) ?? 0) + 1);
  }
  return [...domains.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([d, c]) => `${d} (${c})`);
}

// ==============================================================
// Supabase
// ==============================================================

const supaUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
const supaKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const supabase = createClient(supaUrl, supaKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function resolveTenantId() {
  if (process.env.TENANT_ID) return process.env.TENANT_ID;
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name")
    .limit(2);
  if (error) throw new Error(`resolveTenantId: ${error.message}`);
  if (!data || data.length === 0) throw new Error("No hay tenants en BD");
  if (data.length > 1) {
    throw new Error(
      "Múltiples tenants en BD — pasa TENANT_ID=<uuid> explícito.",
    );
  }
  console.log(`[import] tenant resuelto: ${data[0].name} (${data[0].id})`);
  return data[0].id;
}

// ==============================================================
// Fetching
// ==============================================================

async function fetchAllContacts() {
  const map = new Map(); // contactId -> email (normalized)
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const j = await lemlistGet(
      `/contacts?limit=${CONTACTS_PAGE_SIZE}&offset=${offset}`,
    );
    total = j.total ?? j.data.length;
    for (const c of j.data ?? []) {
      const email = normalizeEmail(c.email);
      if (email && c._id) map.set(c._id, email);
    }
    offset += CONTACTS_PAGE_SIZE;
    if (!j.data || j.data.length === 0) break;
  }
  console.log(`[import] contactos globales: ${map.size} con email válido`);
  return map;
}

async function fetchCampaignLeadContactIds(cid) {
  // La API paginación de /leads: probamos limit+offset. Si devuelve
  // menos que limit, es la última página.
  const all = [];
  let offset = 0;
  while (true) {
    const j = await lemlistGet(
      `/campaigns/${cid}/leads?limit=${LEADS_PAGE_SIZE}&offset=${offset}`,
    );
    if (!Array.isArray(j)) {
      throw new Error(`/campaigns/${cid}/leads: esperaba array, got ${typeof j}`);
    }
    all.push(...j);
    if (j.length < LEADS_PAGE_SIZE) break;
    offset += LEADS_PAGE_SIZE;
  }
  return all
    .map((l) => l?.contactId)
    .filter((x) => typeof x === "string" && x.length > 0);
}

async function fetchAllUnsubscribes() {
  const all = [];
  let offset = 0;
  while (true) {
    const j = await lemlistGet(
      `/unsubscribes?limit=${UNSUBS_PAGE_SIZE}&offset=${offset}`,
    );
    if (!Array.isArray(j)) {
      throw new Error(`/unsubscribes: esperaba array, got ${typeof j}`);
    }
    all.push(...j);
    if (j.length < UNSUBS_PAGE_SIZE) break;
    offset += UNSUBS_PAGE_SIZE;
  }
  return all
    .map((u) => normalizeEmail(u?.value))
    .filter((x) => x !== null);
}

// ==============================================================
// Build rows
// ==============================================================

async function buildRows(tenantId) {
  const contacts = await fetchAllContacts();

  // Dedupe por (email lowercase, reason). La PK dedupe entre reasons
  // solo por email — si un email está en varias campañas O en unsub Y
  // en una campaña, gana la PRIMERA fila que llegue al INSERT (ON
  // CONFLICT DO NOTHING). Orden importa: hacemos unsub PRIMERO para
  // que gane `unsubscribed` frente a `previous_campaign:...` si un
  // contacto está en ambos (unsub es señal más fuerte).
  const rows = [];
  const seen = new Set(); // lower(email)

  // 1. Unsubscribes primero
  const unsubs = await fetchAllUnsubscribes();
  let unsubAdded = 0;
  for (const email of unsubs) {
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      tenant_id: tenantId,
      email,
      reason: "unsubscribed",
      source: SOURCE_TAG,
    });
    unsubAdded += 1;
  }
  console.log(`[import] unsubscribes globales: ${unsubs.length} (nuevos: ${unsubAdded})`);
  if (unsubs.length > 0) {
    console.log(`  dominios top: ${sampleDomains(unsubs, 3).join(", ")}`);
  }

  // 2. Leads por campaña
  const perCampaign = {};
  for (const cid of CAMPAIGNS) {
    const contactIds = await fetchCampaignLeadContactIds(cid);
    let seenInCampaign = 0;
    let addedInCampaign = 0;
    const emailsInCampaign = [];
    for (const ctcId of contactIds) {
      const email = contacts.get(ctcId);
      if (!email) continue; // contact fue borrado o email inválido
      seenInCampaign += 1;
      emailsInCampaign.push(email);
      const k = email.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push({
        tenant_id: tenantId,
        email,
        reason: `previous_campaign:${cid}`,
        source: SOURCE_TAG,
      });
      addedInCampaign += 1;
    }
    perCampaign[cid] = {
      leads: contactIds.length,
      con_email: seenInCampaign,
      nuevos: addedInCampaign,
    };
    console.log(
      `[import] ${cid}: ${contactIds.length} leads, ${seenInCampaign} con email, ${addedInCampaign} nuevos`,
    );
    if (emailsInCampaign.length > 0) {
      console.log(`  dominios top: ${sampleDomains(emailsInCampaign, 3).join(", ")}`);
    }
  }

  return { rows, unsubCount: unsubs.length, perCampaign };
}

// ==============================================================
// Write
// ==============================================================

async function writeRows(rows) {
  if (rows.length === 0) return { inserted: 0 };
  // Insert por lotes de 500 con ignoreDuplicates (upsert con onConflict).
  const BATCH = 500;
  let insertedTotal = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from("outreach_exclusions")
      .upsert(batch, {
        onConflict: "tenant_id,email",
        ignoreDuplicates: true,
      })
      .select("email");
    if (error) throw new Error(`upsert batch ${i}: ${error.message}`);
    insertedTotal += (data ?? []).length;
  }
  return { inserted: insertedTotal };
}

// ==============================================================
// Main
// ==============================================================

console.log(`[import] mode: ${EXECUTE ? "EXECUTE (writes to BD)" : "DRY-RUN (no writes)"}`);
const tenantId = await resolveTenantId();
const { rows } = await buildRows(tenantId);

console.log(`\n[import] resumen`);
console.log(`  total filas a insertar: ${rows.length}`);
const byReason = rows.reduce((acc, r) => {
  const bucket = r.reason.startsWith("previous_campaign:")
    ? "previous_campaign:*"
    : r.reason;
  acc[bucket] = (acc[bucket] ?? 0) + 1;
  return acc;
}, {});
for (const [k, v] of Object.entries(byReason)) {
  console.log(`    ${k}: ${v}`);
}

if (!EXECUTE) {
  console.log(`\n[import] DRY-RUN — no se ha escrito nada. Vuelve a ejecutar con EXECUTE=1.`);
  process.exit(0);
}

console.log(`\n[import] escribiendo a outreach_exclusions...`);
const { inserted } = await writeRows(rows);
console.log(`[import] insertadas nuevas: ${inserted} de ${rows.length} candidatas (resto: ya existían).`);
