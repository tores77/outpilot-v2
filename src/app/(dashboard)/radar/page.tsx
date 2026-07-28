import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { NOVA_SCORE_BATCH_SIZE } from "@/config/scoring";
import { scoreLeadsAction } from "./actions";

type LeadEstado = Database["public"]["Enums"]["lead_estado"];

const ESTADO_VALUES: LeadEstado[] = [
  "NUEVO",
  "EN_RADAR",
  "EN_SECUENCIA",
  "RESPONDIO",
  "REUNION_AGENDADA",
  "REUNION_REALIZADA",
  "NO_SHOW",
  "PROPUESTA_ENVIADA",
  "NEGOCIACION",
  "CLIENTE",
  "PERDIDO",
  "NURTURING",
];

const ESTADO_STYLES: Record<LeadEstado, string> = {
  NUEVO: "bg-foreground/10 text-foreground/70",
  EN_RADAR: "bg-foreground/10 text-foreground/70",
  EN_SECUENCIA: "bg-blue-500/10 text-blue-300",
  RESPONDIO: "bg-accent/10 text-accent",
  REUNION_AGENDADA: "bg-accent/10 text-accent",
  REUNION_REALIZADA: "bg-accent/10 text-accent",
  NO_SHOW: "bg-red-500/10 text-red-300",
  PROPUESTA_ENVIADA: "bg-blue-500/10 text-blue-300",
  NEGOCIACION: "bg-blue-500/10 text-blue-300",
  CLIENTE: "bg-accent/15 text-accent",
  PERDIDO: "bg-red-500/10 text-red-300",
  NURTURING: "bg-yellow-500/10 text-yellow-300",
};

const PAGE_SIZE = 50;

type RadarSearchParams = {
  estado?: string;
  min_score?: string;
  review?: string;
  page?: string;
  imported?: string;
  duplicates?: string;
  invalid?: string;
  deduped?: string;
  review_count?: string;
  total?: string;
  vibe_started?: string;
  score_started?: string;
};

function parseEstado(raw: string | undefined): LeadEstado | null {
  if (!raw) return null;
  return (ESTADO_VALUES as string[]).includes(raw) ? (raw as LeadEstado) : null;
}

function parseMinScore(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function buildPageLink(sp: RadarSearchParams, nextPage: number): string {
  const params = new URLSearchParams();
  if (sp.estado) params.set("estado", sp.estado);
  if (sp.min_score) params.set("min_score", sp.min_score);
  if (sp.review) params.set("review", sp.review);
  params.set("page", String(nextPage));
  return `/radar?${params.toString()}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<RadarSearchParams>;
}) {
  const sp = await searchParams;
  const estado = parseEstado(sp.estado);
  const minScore = parseMinScore(sp.min_score);
  const reviewOnly = sp.review === "1";
  const page = parsePage(sp.page);
  const offset = (page - 1) * PAGE_SIZE;

  const supabase = await createSupabaseServerClient();

  let query = supabase
    .from("leads")
    .select(
      "id, email, first_name, last_name, company, title, estado, icp_score, source, needs_review, created_at",
    )
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE); // fetch PAGE_SIZE+1 to detect "hasMore"

  if (estado) query = query.eq("estado", estado);
  if (minScore !== null) query = query.gte("icp_score", minScore);
  if (reviewOnly) query = query.eq("needs_review", true);

  const { data, error } = await query;
  if (error) throw error;

  // Count how many leads are still missing an ICP score. Cheap: no rows
  // are transferred (head:true) and the count uses the (tenant_id, ...)
  // index. Used to label the "Puntuar" button with a concrete number.
  const { count: pendingScoreCount } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .is("icp_score", null);

  const rows = data ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const visibleRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const importFlash =
    sp.imported !== undefined
      ? {
          imported: Number.parseInt(sp.imported, 10) || 0,
          duplicates: Number.parseInt(sp.duplicates ?? "0", 10) || 0,
          invalid: Number.parseInt(sp.invalid ?? "0", 10) || 0,
          deduped: Number.parseInt(sp.deduped ?? "0", 10) || 0,
          review: Number.parseInt(sp.review_count ?? "0", 10) || 0,
          total: Number.parseInt(sp.total ?? "0", 10) || 0,
        }
      : null;

  return (
    <section className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="text-4xl font-semibold">Radar</h1>
          <p className="mt-2 text-sm text-foreground/60">
            Leads recibidos por Vibe Prospecting, CSV o el formulario inbound
            de studio. La limpieza (dedupe empresa/cargo, tildes, flag REVIEW)
            corre en el import; el scoring ICP llega en T015.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {pendingScoreCount !== null && pendingScoreCount > 0 && (
            <form action={scoreLeadsAction}>
              <button
                type="submit"
                className="rounded-md border border-hairline px-4 py-2 text-sm text-foreground/80 transition-colors hover:border-accent/40 hover:text-foreground"
                title={`Puntúa los próximos ${Math.min(pendingScoreCount, NOVA_SCORE_BATCH_SIZE)} leads sin score. Restantes tras el batch: ${Math.max(0, pendingScoreCount - NOVA_SCORE_BATCH_SIZE)}.`}
              >
                Puntuar {Math.min(pendingScoreCount, NOVA_SCORE_BATCH_SIZE)} pendientes
                {pendingScoreCount > NOVA_SCORE_BATCH_SIZE && (
                  <span className="ml-1 text-foreground/40">
                    /{pendingScoreCount}
                  </span>
                )}
              </button>
            </form>
          )}
          <Link
            href="/radar/vibe"
            className="rounded-md border border-hairline px-4 py-2 text-sm text-foreground/80 transition-colors hover:border-accent/40 hover:text-foreground"
          >
            Fetch de Vibe
          </Link>
          <Link
            href="/radar/import"
            className="rounded-md border border-accent/40 bg-accent/10 px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
          >
            Importar CSV
          </Link>
        </div>
      </div>

      {sp.vibe_started === "1" && (
        <div
          role="status"
          className="rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent/90"
        >
          Fetch de Vibe encolado. El job corre en Inngest; los leads
          aparecerán aquí en cuanto termine.
        </div>
      )}
      {sp.score_started === "1" && (
        <div
          role="status"
          className="rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent/90"
        >
          Batch de scoring encolado. Refresca en unos segundos para ver
          los ICP scores y las transiciones a EN_RADAR.
        </div>
      )}

      {importFlash && (
        <div
          role="status"
          className="rounded-md border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent/90"
        >
          Importación completada: <strong>{importFlash.imported}</strong>{" "}
          añadidos, {importFlash.duplicates} duplicados en BD,{" "}
          {importFlash.deduped} descartados por dedupe empresa/cargo,{" "}
          {importFlash.review} marcados{" "}
          <Link
            href="/radar?review=1"
            className="underline decoration-dotted underline-offset-2 hover:text-accent"
          >
            REVIEW
          </Link>
          , {importFlash.invalid} filas inválidas ({importFlash.total} totales).
        </div>
      )}

      <form method="get" className="flex flex-wrap items-end gap-4 rounded-md border border-hairline p-4">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted">
          Estado
          <select
            name="estado"
            defaultValue={sp.estado ?? ""}
            className="rounded-md border border-hairline bg-foreground/5 px-3 py-1.5 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          >
            <option value="">Todos</option>
            {ESTADO_VALUES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted">
          ICP score mínimo
          <input
            type="number"
            name="min_score"
            min={0}
            max={100}
            defaultValue={sp.min_score ?? ""}
            placeholder="0-100"
            className="w-32 rounded-md border border-hairline bg-foreground/5 px-3 py-1.5 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          />
        </label>

        <label className="flex items-center gap-2 pb-1.5 text-xs text-foreground/70">
          <input
            type="checkbox"
            name="review"
            value="1"
            defaultChecked={reviewOnly}
            className="h-4 w-4 rounded border-hairline bg-foreground/5 text-accent focus:ring-1 focus:ring-accent/40"
          />
          Solo REVIEW
        </label>

        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-md border border-accent/40 bg-accent/10 px-4 py-1.5 text-sm text-accent transition-colors hover:bg-accent/20"
          >
            Aplicar
          </button>
          {(estado || minScore !== null || reviewOnly) && (
            <Link
              href="/radar"
              className="rounded-md border border-hairline px-4 py-1.5 text-sm text-foreground/70 transition-colors hover:border-accent/40 hover:text-foreground"
            >
              Limpiar
            </Link>
          )}
        </div>
      </form>

      <div className="overflow-x-auto rounded-md border border-hairline">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
              <th className="px-4 py-3 font-medium">Lead</th>
              <th className="px-4 py-3 font-medium">Empresa / cargo</th>
              <th className="px-4 py-3 font-medium">Estado</th>
              <th className="px-4 py-3 font-medium">ICP</th>
              <th className="px-4 py-3 font-medium">Origen</th>
              <th className="px-4 py-3 font-medium">Alta</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-foreground/50"
                >
                  Sin leads que coincidan con los filtros.
                </td>
              </tr>
            )}
            {visibleRows.map((lead) => {
              const displayName =
                [lead.first_name, lead.last_name].filter(Boolean).join(" ") ||
                lead.email;
              const companyLine =
                [lead.company, lead.title].filter(Boolean).join(" · ") || "—";
              return (
                <tr
                  key={lead.id}
                  className="border-b border-hairline/60 last:border-b-0 hover:bg-foreground/[0.03]"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-foreground">{displayName}</div>
                    <div className="text-xs text-foreground/50">{lead.email}</div>
                  </td>
                  <td className="px-4 py-3 text-foreground/80">{companyLine}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium tracking-wide ${
                          ESTADO_STYLES[lead.estado]
                        }`}
                      >
                        {lead.estado}
                      </span>
                      {lead.needs_review && (
                        <span
                          title="Marcado por el pipeline de limpieza (email genérico u otra señal)."
                          className="inline-block rounded bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium tracking-wide text-yellow-300"
                        >
                          REVIEW
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-foreground/80">
                    {lead.icp_score ?? <span className="text-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground/60">{lead.source}</td>
                  <td className="px-4 py-3 text-xs text-foreground/60">
                    {formatDate(lead.created_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-foreground/60">
        <div>
          Página {page} · mostrando {visibleRows.length}
        </div>
        <div className="flex gap-2">
          {page > 1 && (
            <Link
              href={buildPageLink(sp, page - 1)}
              className="rounded-md border border-hairline px-3 py-1 transition-colors hover:border-accent/40 hover:text-foreground"
            >
              ← Anterior
            </Link>
          )}
          {hasMore && (
            <Link
              href={buildPageLink(sp, page + 1)}
              className="rounded-md border border-hairline px-3 py-1 transition-colors hover:border-accent/40 hover:text-foreground"
            >
              Siguiente →
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
