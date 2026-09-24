import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { getIcpBySlug } from "@/config/icps";
import { LEX_MAX_PER_TRIGGER, LEX_STALE_CLAIM_MS } from "@/config/lex";
import { VOLT_MAX_SYNC_PER_TRIGGER } from "@/config/volt";
import { countPending } from "@/lib/lex/claim";
import { getVoltCounts } from "@/lib/volt/counts";
import {
  createLemlistCampaignAction,
  personalizeCampaignAction,
  syncLeadsToLemlistAction,
} from "./actions";
import { PersonalizeButton } from "./personalize-button";
import { SyncButton } from "./sync-button";

type CampaignStatus = Database["public"]["Enums"]["campaign_status"];

const STATUS_STYLES: Record<CampaignStatus, string> = {
  draft: "bg-amber-100 text-amber-900",
  smoke_test: "bg-accent-soft text-accent",
  active: "bg-accent-soft text-accent",
  paused: "bg-surface text-foreground",
  done: "bg-surface text-foreground",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

type CampaignsSearchParams = {
  created?: string;
  personalization_started?: string;
  volt_create_started?: string;
  volt_sync_started?: string;
  error?: string;
};

type CampaignRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  icp_slug: string | null;
  provider_external_id: string | null;
  sequence: unknown;
  created_at: string;
};

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<CampaignsSearchParams>;
}) {
  const sp = await searchParams;

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) throw new Error("Not authenticated");
  const { data: allowed } = await supabase
    .from("allowed_users")
    .select("tenant_id")
    .eq("email", user.email)
    .maybeSingle();
  if (!allowed) throw new Error("Not in allowlist");
  const tenantId = allowed.tenant_id;

  const { data, error } = await supabase
    .from("campaigns")
    .select(
      "id, name, status, icp_slug, provider_external_id, sequence, created_at",
    )
    .order("created_at", { ascending: false });
  if (error) throw error;

  const campaigns: CampaignRow[] = (data ?? []) as CampaignRow[];

  const lexCounts = new Map<
    string,
    { activePending: number; activeProcessing: number }
  >();
  const voltCounts = new Map<
    string,
    { syncable: number; pending_personalization: number; no_company: number }
  >();
  await Promise.all([
    ...campaigns.map(async (c) => {
      lexCounts.set(
        c.id,
        await countPending(supabase, {
          tenantId,
          campaignId: c.id,
          staleMs: LEX_STALE_CLAIM_MS,
        }),
      );
    }),
    ...campaigns.map(async (c) => {
      voltCounts.set(
        c.id,
        await getVoltCounts(supabase, {
          tenantId,
          campaignId: c.id,
        }),
      );
    }),
  ]);

  return (
    <section className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="text-4xl">Campaigns</h1>
          <p className="mt-2 text-sm text-muted">
            Volt: builder de secuencias, orquestación Inngest con ventanas
            M-X-J, smoke test nativo. Lex personaliza pre-envío. Volt sync
            crea la campaña en Lemlist (draft) y sube leads.
          </p>
        </div>
        <Link
          href="/campaigns/new"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          Nueva campaña
        </Link>
      </div>

      {sp.created && (
        <div
          role="status"
          className="rounded-md border border-hairline bg-surface px-4 py-3 text-sm text-foreground"
        >
          Campaña creada en <code>draft</code>. Está lista para editar; el
          sync a Lemlist se dispara desde el botón &quot;Crear en Lemlist&quot;.
        </div>
      )}

      {sp.personalization_started && (
        <div
          role="status"
          className="rounded-md border border-hairline bg-surface px-4 py-3 text-sm text-foreground"
        >
          Personalización encolada. Lex procesa hasta{" "}
          <strong>{LEX_MAX_PER_TRIGGER}</strong> leads por trigger.
        </div>
      )}

      {sp.volt_create_started && (
        <div
          role="status"
          className="rounded-md border border-hairline bg-surface px-4 py-3 text-sm text-foreground"
        >
          &quot;Crear en Lemlist&quot; encolado. Volt creará la campaña en
          <code> draft</code>, configurará los dos schedules (M-X-J
          09-11 / 15-17 Madrid) y subirá los steps del sequence.
          Refresca en un minuto.
        </div>
      )}

      {sp.volt_sync_started && (
        <div
          role="status"
          className="rounded-md border border-hairline bg-surface px-4 py-3 text-sm text-foreground"
        >
          &quot;Sincronizar leads&quot; encolado. Volt sube hasta{" "}
          <strong>{VOLT_MAX_SYNC_PER_TRIGGER}</strong> leads por trigger.
        </div>
      )}

      {sp.error && (
        <div
          role="alert"
          className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent"
        >
          Error: <code>{sp.error}</code>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-hairline">
        <table className="w-full text-sm">
          <thead className="bg-surface">
            <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">Nombre</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium">ICP</th>
              <th className="px-4 py-3 font-medium">Steps</th>
              <th className="px-4 py-3 font-medium">Creada</th>
              <th className="px-4 py-3 font-medium">Personalización</th>
              <th className="px-4 py-3 font-medium">Sync Lemlist</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-muted"
                >
                  Aún no hay campañas. Crea la primera desde{" "}
                  <Link
                    href="/campaigns/new"
                    className="underline decoration-dotted underline-offset-2 hover:text-accent"
                  >
                    Nueva campaña
                  </Link>
                  .
                </td>
              </tr>
            )}
            {campaigns.map((c) => {
              const icp = c.icp_slug ? getIcpBySlug(c.icp_slug) : null;
              const seq = c.sequence as { steps?: unknown } | null;
              const stepCount = Array.isArray(seq?.steps) ? seq.steps.length : 0;
              const { activePending, activeProcessing } = lexCounts.get(c.id) ?? {
                activePending: 0,
                activeProcessing: 0,
              };
              const willProcess = Math.min(activePending, LEX_MAX_PER_TRIGGER);

              const voltC = voltCounts.get(c.id) ?? {
                syncable: 0,
                pending_personalization: 0,
                no_company: 0,
              };
              const willSync = Math.min(voltC.syncable, VOLT_MAX_SYNC_PER_TRIGGER);

              const isCreatedInLemlist = !!c.provider_external_id;

              return (
                <tr
                  key={c.id}
                  className="border-b border-hairline last:border-b-0 hover:bg-surface"
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    {c.name}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium tracking-wide ${STATUS_STYLES[c.status]}`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-foreground">
                    {icp?.name ?? c.icp_slug ?? (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-foreground">{stepCount}</td>
                  <td className="px-4 py-3 text-xs text-muted">
                    {formatDate(c.created_at)}
                  </td>
                  <td className="px-4 py-3">
                    {activeProcessing > 0 ? (
                      <span
                        className="inline-block rounded-md border border-hairline bg-surface px-3 py-1 text-xs text-muted"
                        title={`Lex está procesando ${activeProcessing} leads.`}
                      >
                        Procesando {activeProcessing}…
                      </span>
                    ) : activePending > 0 ? (
                      <form action={personalizeCampaignAction}>
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <PersonalizeButton
                          label={`Personalizar ${willProcess} de ${activePending}`}
                          title={`Encola Lex sobre ${willProcess} campaign_leads.`}
                        />
                      </form>
                    ) : (
                      <span className="text-xs text-muted">Sin pendientes</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {!isCreatedInLemlist ? (
                      <form action={createLemlistCampaignAction}>
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <SyncButton
                          label="Crear en Lemlist"
                          variant="primary"
                          title="Crea campaña + schedules + sequence en Lemlist (draft; no envía)."
                        />
                      </form>
                    ) : voltC.syncable > 0 ? (
                      <form action={syncLeadsToLemlistAction}>
                        <input type="hidden" name="campaign_id" value={c.id} />
                        <SyncButton
                          label={`Sincronizar ${willSync} de ${voltC.syncable}`}
                          title={buildSyncTitle(voltC)}
                        />
                        {(voltC.pending_personalization > 0 ||
                          voltC.no_company > 0) && (
                          <p className="mt-1 text-[10px] text-muted">
                            {voltC.pending_personalization > 0 &&
                              `${voltC.pending_personalization} sin personalizar`}
                            {voltC.pending_personalization > 0 &&
                              voltC.no_company > 0 &&
                              " · "}
                            {voltC.no_company > 0 &&
                              `${voltC.no_company} sin company`}
                          </p>
                        )}
                      </form>
                    ) : (
                      <span className="text-xs text-muted">
                        {voltC.pending_personalization > 0 ||
                        voltC.no_company > 0
                          ? [
                              voltC.pending_personalization > 0 &&
                                `${voltC.pending_personalization} sin personalizar`,
                              voltC.no_company > 0 &&
                                `${voltC.no_company} sin company`,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : "Sincronizada"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function buildSyncTitle(voltC: {
  syncable: number;
  pending_personalization: number;
  no_company: number;
}): string {
  const parts = [`Sincroniza ${voltC.syncable} leads listos`];
  if (voltC.pending_personalization > 0) {
    parts.push(`${voltC.pending_personalization} sin personalizar (correr Lex antes)`);
  }
  if (voltC.no_company > 0) {
    parts.push(`${voltC.no_company} sin company (excluidos)`);
  }
  return parts.join(" · ");
}
