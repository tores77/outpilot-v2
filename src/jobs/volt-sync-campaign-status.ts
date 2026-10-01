// Volt — sincronizar estado de campaña con Lemlist (T025 bloque D).
//
// Cron horario que lee GET /api/campaigns/:cid para cada campaña con
// provider_external_id IS NOT NULL y refleja el estado del provider
// en las columnas `provider_status` + `provider_status_synced_at`
// (migración 009a). NO transiciona el `status` interno — ese sigue
// controlado por humano (ver header de campaign-status.ts).
//
// Si detectInternalStatusDrift reporta drift, se escribe un evento
// `campaigns.status_drift` en `events`. Pere lo verá en dashboards
// (bloque E, pendiente) o con un SELECT puntual.
//
// Steps:
//   1. load-tenants           — lista los tenants cuyos campaigns
//                                podrían necesitar sync.
//   2. load-campaigns-{tid}   — campaigns del tenant con external_id.
//   3. sync-campaign-{id}     — 1 llamada a Lemlist + UPDATE + evento
//                                si drift.
//   4. record-event           — resumen del run.
//
// Idempotencia: la query a Lemlist es GET (sin efectos). El UPDATE
// a campaigns usa (tenant_id, id) como filtro — reaplicar no cambia
// nada semánticamente. Los eventos de drift se insertan sin unique
// — si el cron corre dos veces en 1h (manual + horario), habrá dos
// filas idénticas en `events`; es ruido pero no perjudica.

import { inngest } from "@/lib/inngest";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { createLemlistClient } from "@/channels/lemlist/client";
import {
  getLemlistCampaign,
  type LemlistCampaignSummary,
} from "@/channels/lemlist/campaign-ops";
import {
  LemlistApiError,
  LemlistTimeoutError,
} from "@/channels/lemlist/client";
import type { Database } from "@/lib/supabase/database.types";
import {
  detectInternalStatusDrift,
  type CampaignStatus,
} from "@/lib/lemlist/campaign-status";

type SyncOutcome =
  | { kind: "synced" }
  | {
      kind: "drift";
      driftKind: string;
      provider_status: string | null;
      mapped: CampaignStatus | null;
    }
  | { kind: "error"; error: string };

function getLemlistApiKey(): string {
  const k = process.env.LEMLIST_API_KEY;
  if (!k || k.trim() === "") {
    throw new Error("volt-sync-campaign-status: LEMLIST_API_KEY no configurada");
  }
  return k;
}

export const voltSyncCampaignStatus = inngest.createFunction(
  {
    id: "volt-sync-campaign-status",
    // Cron horario, mismo pattern que healthcheck. Offset :05 para
    // no competir con el healthcheck (:00) por los primeros slots
    // de step.run.
    triggers: [{ cron: "5 * * * *" }],
  },
  async ({ step }) => {
    const startedAt = Date.now();
    const supabase = createSupabaseServiceClient();
    const lemlist = createLemlistClient({ apiKey: getLemlistApiKey() });

    // ===== 1. Lista tenants =====
    // La tabla `tenants` es la tabla PADRE: no tiene columna
    // tenant_id, es la fuente. La regla outpilot/require-tenant-id-filter
    // está pensada para hijas (todo lo que tiene tenant_id FK). Aquí
    // listamos la tabla padre para iterar y hacer per-tenant lookups
    // más abajo. Escape local, documentado.
    // eslint-disable-next-line outpilot/require-tenant-id-filter -- tenants es la tabla padre, no tiene columna tenant_id
    const { data: tenantRows, error: tErr } = await supabase
      .from("tenants")
      .select("id");
    if (tErr) throw new Error(`load-tenants failed: ${tErr.message}`);
    const tenantIds = (tenantRows ?? []).map((t) => t.id);

    let processed = 0;
    let drifts = 0;
    let errors = 0;
    const driftIds: string[] = [];

    for (const tenantId of tenantIds) {
      // ===== 2. Load campaigns del tenant =====
      const campaigns = await step.run(
        `load-campaigns-${tenantId}`,
        async () => {
          const { data, error } = await supabase
            .from("campaigns")
            .select("id, status, provider_external_id")
            .eq("tenant_id", tenantId)
            .not("provider_external_id", "is", null)
            .neq("status", "done");
          if (error) {
            throw new Error(
              `load-campaigns-${tenantId} failed: ${error.message}`,
            );
          }
          return data ?? [];
        },
      );

      if (campaigns.length === 0) continue;

      // ===== 3. Sync 1 a 1 =====
      for (const c of campaigns) {
        // La query de arriba filtra not-null, pero TS mantiene el
        // posible null del tipo generated. Narrow explícito.
        const providerExternalId = c.provider_external_id;
        if (!providerExternalId) continue;

        const outcome = (await step.run(
          `sync-campaign-${c.id}`,
          async () => {
            let summary: LemlistCampaignSummary;
            try {
              summary = await getLemlistCampaign(lemlist, providerExternalId);
            } catch (err: unknown) {
              let msg: string;
              if (err instanceof LemlistApiError) {
                msg = `${err.status}: ${err.bodyPreview.slice(0, 120)}`;
              } else if (err instanceof LemlistTimeoutError) {
                msg = `timeout ${err.timeoutMs}ms`;
              } else if (err instanceof Error) {
                msg = err.message;
              } else {
                msg = String(err);
              }
              return { kind: "error" as const, error: msg };
            }

            const providerStatus = summary.status ?? null;
            const nowIso = new Date().toISOString();

            // UPDATE siempre: provider_status + provider_status_synced_at.
            //
            // Nota de tipos (temporal, pre-gen-types tras aplicar
            // 009a): database.types.ts aún no conoce las columnas
            // nuevas. Cast local con `as unknown as` para que tsc
            // compile; el próximo commit tras `npm run gen-types`
            // retira el cast — es el patrón que ya usamos para 009.
            const update = {
              provider_status: providerStatus,
              provider_status_synced_at: nowIso,
            } as unknown as Database["public"]["Tables"]["campaigns"]["Update"];
            const { error: upErr } = await supabase
              .from("campaigns")
              .update(update)
              .eq("tenant_id", tenantId)
              .eq("id", c.id);
            if (upErr) {
              return {
                kind: "error" as const,
                error: `update failed: ${upErr.message}`,
              };
            }

            // Classify drift y, si lo hay, evento informativo.
            const drift = detectInternalStatusDrift(
              c.status as CampaignStatus,
              providerStatus,
            );
            if (drift.drift) {
              const { error: evErr } = await supabase.from("events").insert({
                tenant_id: tenantId,
                kind: "campaigns.status_drift",
                actor: "volt-sync-campaign-status",
                entity_type: "campaign",
                entity_id: c.id,
                payload: {
                  internal_status: c.status,
                  provider_status: providerStatus,
                  mapped_status: drift.mapped,
                  drift_kind: drift.kind,
                },
              });
              if (evErr) {
                console.error(
                  "[volt-sync-campaign-status] events insert failed",
                  evErr,
                );
              }
              return {
                kind: "drift" as const,
                driftKind: drift.kind,
                provider_status: providerStatus,
                mapped: drift.mapped,
              };
            }
            return { kind: "synced" as const };
          },
        )) as SyncOutcome;

        processed += 1;
        if (outcome.kind === "drift") {
          drifts += 1;
          driftIds.push(c.id);
          console.log(
            `[volt-sync-campaign-status] drift campaign=${c.id} internal=${c.status} provider=${outcome.provider_status} kind=${outcome.driftKind}`,
          );
        } else if (outcome.kind === "error") {
          errors += 1;
          console.error(
            `[volt-sync-campaign-status] sync error campaign=${c.id}: ${outcome.error}`,
          );
        }
      }
    }

    const latencyMs = Date.now() - startedAt;

    // ===== 4. record-event (resumen global, tenant_id null) =====
    // El resumen cross-tenant no "pertenece" a ningún tenant; lo
    // insertamos solo si hubo trabajo. Pere lo lee con service role.
    if (processed > 0 || errors > 0) {
      await step.run("record-run", async () => {
        for (const tenantId of tenantIds) {
          const { error } = await supabase.from("events").insert({
            tenant_id: tenantId,
            kind: "volt.sync_campaign_status.run",
            actor: "volt-sync-campaign-status",
            entity_type: "cron",
            entity_id: null,
            payload: {
              processed,
              drifts,
              errors,
              drift_campaign_ids: driftIds,
              latency_ms: latencyMs,
            },
          });
          if (error) {
            console.error(
              `[volt-sync-campaign-status] record-run insert failed for tenant=${tenantId}`,
              error,
            );
          }
        }
      });
    }

    return {
      tenants: tenantIds.length,
      processed,
      drifts,
      errors,
      drift_campaign_ids: driftIds,
      latency_ms: latencyMs,
    };
  },
);
