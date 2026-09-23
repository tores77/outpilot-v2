import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { getIcpBySlug } from "@/config/icps";
import { LEX_MAX_PER_TRIGGER } from "@/config/lex";
import { personalizeCampaignAction } from "./actions";

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
};

type CampaignRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  icp_slug: string | null;
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
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, name, status, icp_slug, sequence, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const campaigns: CampaignRow[] = (data ?? []) as CampaignRow[];

  // Cuenta paralela de campaign_leads sin personalizar por campaña.
  // Simple: N roundtrips concurrentes (Pere tiene ~pocas campañas).
  // Si crece, mover a un RPC/GROUP BY.
  const pendingCounts = new Map<string, number>();
  await Promise.all(
    campaigns.map(async (c) => {
      const { count } = await supabase
        .from("campaign_leads")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", c.id)
        .is("personalization", null)
        .is("removed_at", null);
      pendingCounts.set(c.id, count ?? 0);
    }),
  );

  return (
    <section className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="text-4xl">Campaigns</h1>
          <p className="mt-2 text-sm text-muted">
            Volt: builder de secuencias, orquestación Inngest con ventanas
            M-X-J, smoke test nativo. Lex personaliza pre-envío. El
            builder ya crea campañas en <code>draft</code>; el sync a
            Lemlist llega en T023.
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
          envío real llega con T023 (Volt orchestration).
        </div>
      )}

      {sp.personalization_started && (
        <div
          role="status"
          className="rounded-md border border-hairline bg-surface px-4 py-3 text-sm text-foreground"
        >
          Personalización encolada. Lex procesa hasta{" "}
          <strong>{LEX_MAX_PER_TRIGGER}</strong> leads por trigger; refresca
          en un minuto y vuelve a pulsar si quedan pendientes.
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
            </tr>
          </thead>
          <tbody>
            {campaigns.length === 0 && (
              <tr>
                <td
                  colSpan={6}
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
              const pending = pendingCounts.get(c.id) ?? 0;
              const willProcess = Math.min(pending, LEX_MAX_PER_TRIGGER);
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
                    {pending === 0 ? (
                      <span className="text-xs text-muted">
                        Sin pendientes
                      </span>
                    ) : (
                      <form action={personalizeCampaignAction}>
                        <input
                          type="hidden"
                          name="campaign_id"
                          value={c.id}
                        />
                        <button
                          type="submit"
                          className="rounded-md border border-hairline bg-background px-3 py-1 text-xs text-foreground transition-colors hover:border-foreground/40"
                          title={`Encola Lex sobre ${willProcess} campaign_leads sin personalizar. Restantes tras este batch: ${Math.max(0, pending - LEX_MAX_PER_TRIGGER)}.`}
                        >
                          Personalizar {willProcess} de {pending}
                        </button>
                      </form>
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
