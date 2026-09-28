// Criterios de selección del backfill de firmographics de Vibe.
//
// Post-mortem 2026-09-28 (re-run del backfill devolvió 0 leads):
//   el SELECT filtraba por sector IS NULL, pero el primer backfill
//   ya había rellenado el sector para los 114. El re-run los
//   descartó a todos aunque le faltaba persistir
//   firmographics_vibe_website (fix aplicado en el commit anterior).
//
// Criterio: un lead es elegible si le falta CUALQUIER campo que este
// script persiste (hoy: sector o firmographics_vibe_website). Cuando
// el script gane más campos, se añaden aquí y el re-run los captura
// naturalmente.
//
// Función pura + testeable. El script .mjs duplica esta lógica
// inline (self-contained) — tests aquí son la fuente de verdad.

export type BackfillEligibilityReason =
  | "sector_missing"
  | "vibe_website_missing"
  | "both"
  | null;

type LeadForBackfillCheck = {
  sector: string | null | undefined;
  custom_fields: Record<string, unknown> | null | undefined;
};

export function classifyBackfillEligibility(
  lead: LeadForBackfillCheck,
): BackfillEligibilityReason {
  const sectorMissing =
    lead.sector === null ||
    lead.sector === undefined ||
    (typeof lead.sector === "string" && lead.sector.trim() === "");
  const vibeWebsite = (lead.custom_fields ?? {})["firmographics_vibe_website"];
  const vibeMissing =
    vibeWebsite === undefined ||
    vibeWebsite === null ||
    (typeof vibeWebsite === "string" && vibeWebsite.trim() === "");
  if (sectorMissing && vibeMissing) return "both";
  if (sectorMissing) return "sector_missing";
  if (vibeMissing) return "vibe_website_missing";
  return null;
}

export function isEligibleForFirmographicsBackfill(
  lead: LeadForBackfillCheck,
): boolean {
  return classifyBackfillEligibility(lead) !== null;
}
