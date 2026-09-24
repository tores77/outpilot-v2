// OUTPILOT v2 — Volt counts para el botón "Sincronizar" en /campaigns
// Fase 2 · T023
//
// Devuelve los tres contadores que rellenan el label del botón:
//   syncable            — listos: personalization final + provider_lead_id
//                          NULL + company no vacía + no processing +
//                          no removed
//   pending_personalization — sin correr Lex aún (personalization NULL)
//                          o Lex a medio (state='processing')
//   no_company          — con personalization pero sin company (no
//                          sincronizables porque Lex depende de
//                          company; realmente no debería haber si Lex
//                          los excluyó)
//
// Sirve para "Sincronizar N leads · M sin personalizar · K sin company".

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type VoltCounts = {
  syncable: number;
  pending_personalization: number;
  no_company: number;
};

export async function getVoltCounts(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; campaignId: string },
): Promise<VoltCounts> {
  const { tenantId, campaignId } = args;

  // Una única query trae todo lo necesario para clasificar en cliente.
  // Volumen esperado: bajo (v2.1 = 1 tenant, decenas/centenares de
  // leads por campaña). Si crece, mover a un RPC con GROUP BY.
  const { data, error } = await supabase
    .from("campaign_leads")
    .select("personalization, provider_lead_id, lead:leads!inner(company)")
    .eq("tenant_id", tenantId)
    .eq("campaign_id", campaignId)
    .is("removed_at", null);
  if (error) throw new Error(`getVoltCounts: ${error.message}`);

  let syncable = 0;
  let pendingPersonalization = 0;
  let noCompany = 0;

  for (const row of data ?? []) {
    if (row.provider_lead_id) continue; // ya sincronizado

    const p = row.personalization as { state?: unknown } | null;
    const personalizationIsFinal =
      p !== null &&
      typeof p === "object" &&
      (p as { state?: unknown }).state !== "processing";

    if (!personalizationIsFinal) {
      pendingPersonalization += 1;
      continue;
    }

    const lead = row.lead as unknown as { company: string | null };
    const companyOk =
      typeof lead?.company === "string" && lead.company.trim().length > 0;
    if (!companyOk) {
      noCompany += 1;
      continue;
    }

    syncable += 1;
  }

  return {
    syncable,
    pending_personalization: pendingPersonalization,
    no_company: noCompany,
  };
}
