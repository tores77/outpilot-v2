// Contract probe: GET /credits (gratis).
//
// Descubrimiento del 2026-09-25: la key de la app OUTPILOT pertenece
// a una cuenta de Explorium distinta de la que ve Pere en el panel
// web. Sospecha: la app usa el "portal de desarrolladores" de
// Explorium y Pere mira otra cuenta. La API es la fuente de verdad
// para el saldo, no el dashboard.
//
// Endpoint verificado:
//   GET https://api.explorium.ai/v1/credits
//   auth: header `api_key: <VIBE_API_KEY>`
//   200 → { allocated_credits, remaining_credits, account_type }
//
// Es gratis y no descuenta créditos.
//
// Usage:
//   node --env-file-if-exists=.env.local scripts/probe-vibe-credits.mjs

const key = process.env.VIBE_API_KEY;
if (!key || key.trim() === "") {
  console.error("[probe] VIBE_API_KEY no está configurada en .env.local");
  process.exit(1);
}

const t0 = Date.now();
const res = await fetch("https://api.explorium.ai/v1/credits", {
  method: "GET",
  headers: { accept: "application/json", api_key: key },
});
const ms = Date.now() - t0;
const text = await res.text();
console.log(`GET /credits → ${res.status} (${ms}ms)`);
if (!res.ok) {
  console.error(text);
  process.exit(2);
}
const body = JSON.parse(text);
console.log(JSON.stringify(body, null, 2));
