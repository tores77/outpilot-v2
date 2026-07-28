import Link from "next/link";
import {
  VIBE_AVAILABLE_COUNTRIES,
  VIBE_AVAILABLE_SECTORS,
  VIBE_CREDITS_PER_LEAD_ENRICH,
  VIBE_CREDITS_PER_LEAD_FETCH,
  VIBE_DEFAULT_COUNTRIES,
  VIBE_DEFAULT_LIMIT,
  VIBE_DEFAULT_SECTORS,
  VIBE_DEFAULT_SENIORITY,
  VIBE_MAX_CREDITS_PER_FETCH,
  VIBE_MAX_LEADS_PER_FETCH,
  VIBE_SENIORITY_OPTIONS,
  estimateCredits,
} from "@/config/vibe";
import { verifyEstimate } from "@/lib/vibe/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { estimateFetchAction, executeFetchAction } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  no_countries: "Selecciona al menos un país.",
  no_sectors: "Selecciona al menos un sector.",
  stats: "El endpoint de estadísticas de Vibe falló.",
  missing_token: "Falta el token de estimación.",
  estimate_expired:
    "La estimación caducó (más de 5 minutos). Vuelve a estimar.",
  estimate_invalid:
    "Los filtros han cambiado desde la estimación. Vuelve a estimar.",
  cap_ack_required:
    "El coste estimado supera el límite. Marca la casilla de confirmación explícita.",
};

type SearchParams = {
  countries?: string | string[];
  sectors?: string | string[];
  seniority?: string;
  limit?: string;
  matches?: string;
  token?: string;
  error?: string;
  detail?: string;
};

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export default async function VibeFetchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");

  // Reconstruct filters from URL params (used both to pre-fill the form
  // and — when a token is present — to verify the estimate signature).
  const countriesRaw = toArray(sp.countries);
  const sectorsRaw = toArray(sp.sectors);
  const countries = countriesRaw.length > 0 ? countriesRaw : [...VIBE_DEFAULT_COUNTRIES];
  const sectors = sectorsRaw.length > 0 ? sectorsRaw : [...VIBE_DEFAULT_SECTORS];
  const seniority = sp.seniority ?? VIBE_DEFAULT_SENIORITY;
  const limitRaw = Number.parseInt(sp.limit ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1
    ? Math.min(limitRaw, VIBE_MAX_LEADS_PER_FETCH)
    : VIBE_DEFAULT_LIMIT;

  const filters = { countries, sectors, seniority, limit };

  const errorMessage = sp.error ? ERROR_MESSAGES[sp.error] ?? "Error." : null;

  // Confirm mode: only when we have a valid, non-expired token AND
  // matches. Everything else falls through to the form.
  let confirmMode = false;
  let matches: number | null = null;
  if (typeof sp.token === "string" && sp.matches) {
    const verdict = verifyEstimate(sp.token, filters, user.email);
    if (verdict.valid) {
      const n = Number.parseInt(sp.matches, 10);
      if (Number.isFinite(n)) {
        confirmMode = true;
        matches = n;
      }
    }
  }

  return (
    <section className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-semibold">Fetch de Vibe</h1>
          <p className="mt-2 text-sm text-foreground/60">
            {confirmMode
              ? "Confirma la ejecución. Las estadísticas son gratis; el fetch se descuenta del saldo de Vibe."
              : "Dimensiona con Vibe (Explorium). El fetch nunca se dispara solo: humano, siempre."}
          </p>
        </div>
        <Link
          href="/radar"
          className="rounded-md border border-hairline px-3 py-1.5 text-xs text-foreground/70 hover:border-accent/40 hover:text-foreground"
        >
          ← Volver a Radar
        </Link>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          <p>{errorMessage}</p>
          {sp.detail && <p className="mt-1 text-xs text-red-400/80">{sp.detail}</p>}
        </div>
      )}

      {confirmMode && matches !== null ? (
        <ConfirmView
          filters={filters}
          matches={matches}
          token={sp.token as string}
        />
      ) : (
        <FilterForm filters={filters} />
      )}
    </section>
  );
}

function FilterForm({ filters }: { filters: { countries: string[]; sectors: string[]; seniority: string; limit: number } }) {
  return (
    <form
      action={estimateFetchAction}
      className="space-y-6 rounded-lg border border-hairline p-6"
    >
      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-muted">Países</p>
        <div className="flex flex-wrap gap-3">
          {VIBE_AVAILABLE_COUNTRIES.map((c) => (
            <label
              key={c.code}
              className="flex items-center gap-2 text-sm text-foreground/80"
            >
              <input
                type="checkbox"
                name="countries"
                value={c.code}
                defaultChecked={filters.countries.includes(c.code)}
                className="h-4 w-4 rounded border-hairline bg-foreground/5 text-accent focus:ring-1 focus:ring-accent/40"
              />
              {c.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-muted">
          Sectores (post-filtro en cleanup)
        </p>
        <div className="flex flex-wrap gap-3">
          {VIBE_AVAILABLE_SECTORS.map((s) => (
            <label
              key={s}
              className="flex items-center gap-2 text-sm text-foreground/80"
            >
              <input
                type="checkbox"
                name="sectors"
                value={s}
                defaultChecked={filters.sectors.includes(s)}
                className="h-4 w-4 rounded border-hairline bg-foreground/5 text-accent focus:ring-1 focus:ring-accent/40"
              />
              {s}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-foreground/50">
          Los sectores y el seniority se aplican tras el fetch en el pipeline
          de limpieza (T013). La API se llama solo con países hasta que
          probemos la taxonomía real.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted">
          Seniority mínimo
          <select
            name="seniority"
            defaultValue={filters.seniority}
            className="rounded-md border border-hairline bg-foreground/5 px-3 py-1.5 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          >
            {VIBE_SENIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted">
          Límite (máx {VIBE_MAX_LEADS_PER_FETCH})
          <input
            type="number"
            name="limit"
            min={1}
            max={VIBE_MAX_LEADS_PER_FETCH}
            defaultValue={filters.limit}
            className="rounded-md border border-hairline bg-foreground/5 px-3 py-1.5 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          />
        </label>
      </div>

      <button
        type="submit"
        className="rounded-md border border-accent/40 bg-accent/10 px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
      >
        Estimar (gratis)
      </button>
    </form>
  );
}

function ConfirmView({
  filters,
  matches,
  token,
}: {
  filters: { countries: string[]; sectors: string[]; seniority: string; limit: number };
  matches: number;
  token: string;
}) {
  const cost = estimateCredits(filters.limit);
  const overCap = cost.total > VIBE_MAX_CREDITS_PER_FETCH;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-6 text-sm">
        <p className="text-xs uppercase tracking-wider text-muted">Estimación</p>
        <p className="mt-2 text-3xl font-semibold text-foreground">
          {matches.toLocaleString("es-ES")} matches
        </p>
        <p className="mt-1 text-foreground/60">
          {filters.countries.join(", ")} · sectores {filters.sectors.join(", ") || "—"} · seniority {filters.seniority} · límite {filters.limit}
        </p>
        <div className="mt-5 space-y-1 text-foreground/70">
          <p className="text-xs uppercase tracking-wider text-muted">Desglose de coste</p>
          <div className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 text-sm">
            <span>Fetch ({filters.limit} × {VIBE_CREDITS_PER_LEAD_FETCH} cr/lead)</span>
            <span className="text-right tabular-nums">{cost.fetch} cr</span>
            <span>Enrich ({filters.limit} × {VIBE_CREDITS_PER_LEAD_ENRICH} cr/lead)</span>
            <span className="text-right tabular-nums">{cost.enrich} cr</span>
            <span className="border-t border-hairline pt-1 font-medium text-foreground">Total estimado</span>
            <span className="border-t border-hairline pt-1 text-right font-semibold tabular-nums text-foreground">{cost.total} cr</span>
          </div>
          <p className="pt-2 text-xs text-foreground/40">
            Coste orientativo; el descuento real lo fija Vibe. El enrich cubre
            solo los supervivientes tras el cleanup (dedupe empresa/cargo).
            La heurística se irá calibrando con los primeros fetches reales.
          </p>
        </div>
      </div>

      {overCap && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
          El coste estimado ({cost.total} créditos) supera el cap por defecto
          de {VIBE_MAX_CREDITS_PER_FETCH}. Marca la casilla para confirmar
          explícitamente.
        </div>
      )}

      <form action={executeFetchAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        {filters.countries.map((c) => (
          <input key={`c-${c}`} type="hidden" name="countries" value={c} />
        ))}
        {filters.sectors.map((s) => (
          <input key={`s-${s}`} type="hidden" name="sectors" value={s} />
        ))}
        <input type="hidden" name="seniority" value={filters.seniority} />
        <input type="hidden" name="limit" value={String(filters.limit)} />

        {overCap && (
          <label className="flex items-center gap-2 text-sm text-yellow-200">
            <input
              type="checkbox"
              name="acknowledge_cap"
              className="h-4 w-4 rounded border-hairline bg-foreground/5 text-yellow-400 focus:ring-1 focus:ring-yellow-400/40"
            />
            Entiendo que el coste supera el cap; confirmar y ejecutar.
          </label>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md border border-accent/40 bg-accent/10 px-5 py-2.5 text-sm font-medium text-accent transition-colors hover:bg-accent/20"
          >
            Ejecutar y guardar en Radar
          </button>
          <Link
            href="/radar/vibe"
            className="rounded-md border border-hairline px-4 py-2 text-sm text-foreground/70 transition-colors hover:border-accent/40 hover:text-foreground"
          >
            Reestimar con otros filtros
          </Link>
        </div>
      </form>
    </div>
  );
}
