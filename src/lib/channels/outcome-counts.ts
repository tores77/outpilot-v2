// OUTPILOT v2 · outcome counts por campaña (T025 bloque E)
//
// Agregación simple sobre campaign_leads.outcome para rellenar las
// columnas "Enviados / Rebotes / Respuestas" en /campaigns.
//
// Query: trae todas las filas activas (removed_at IS NULL) con la
// columna outcome; cuenta en memoria. supabase-js no expone GROUP BY
// directo y el volumen esperado por campaña es decenas / centenas de
// filas — barato. Si crece, mover a un RPC.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

export type OutcomeCounts = {
  sent: number;         // outcome = 'sent' (al menos un emailsSent, sin eventos superiores)
  bounced: number;
  replied: number;
  unsubscribed: number;
  interested: number;
  not_interested: number;
  pending: number;      // outcome IS NULL (sin eventos aún)
};

export async function getOutcomeCounts(
  supabase: SupabaseClient<Database>,
  args: { tenantId: string; campaignId: string },
): Promise<OutcomeCounts> {
  const { tenantId, campaignId } = args;
  const { data, error } = await supabase
    .from("campaign_leads")
    .select("outcome")
    .eq("tenant_id", tenantId)
    .eq("campaign_id", campaignId)
    .is("removed_at", null);
  if (error) throw new Error(`getOutcomeCounts: ${error.message}`);

  const counts: OutcomeCounts = {
    sent: 0,
    bounced: 0,
    replied: 0,
    unsubscribed: 0,
    interested: 0,
    not_interested: 0,
    pending: 0,
  };
  for (const row of data ?? []) {
    const o = row.outcome;
    if (o === null) counts.pending += 1;
    else counts[o] += 1;
  }
  return counts;
}
