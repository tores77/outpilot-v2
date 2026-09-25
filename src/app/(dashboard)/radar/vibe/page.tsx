import Link from "next/link";
import {
  VIBE_AVAILABLE_COUNTRIES,
  VIBE_CREDITS_PER_LEAD_ENRICH,
  VIBE_CREDITS_PER_LEAD_FETCH,
  VIBE_DEFAULT_LIMIT,
  VIBE_MAX_CREDITS_PER_FETCH,
  VIBE_MAX_LEADS_PER_FETCH,
  estimateCredits,
} from "@/config/vibe";
import { getIcpBySlug, ICPS, type IcpTemplate } from "@/config/icps";
import {
  defaultCountriesFromIcp,
  resolveVibeApiFilters,
} from "@/lib/vibe/filters";
import { verifyEstimate } from "@/lib/vibe/token";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { estimateFetchAction, executeFetchAction } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  no_icp: "Selecciona un ICP.",
  unknown_icp: "El ICP indicado no tiene bloque vibeFilters.",
  no_countries: "Selecciona al menos un país.",
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
  icp?: string;
  countries?: string | string[];
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

  const errorMessage = sp.error ? ERROR_MESSAGES[sp.error] ?? "Error." : null;

  // Sin ICP en la URL → picker inicial.
  const icp = sp.icp ? getIcpBySlug(sp.icp) : null;
  if (!icp || !icp.vibeFilters) {
    return (
      <section className="max-w-3xl space-y-8">
        <Header confirmMode={false} />
        {errorMessage && (
          <ErrorBanner message={errorMessage} detail={sp.detail} />
        )}
        <IcpPicker />
      </section>
    );
  }

  // ICP fijado → reconstruir filtros del form desde URL params.
  const countriesRaw = toArray(sp.countries);
  const countries =
    countriesRaw.length > 0
      ? countriesRaw
      : [...defaultCountriesFromIcp(icp)];
  const limitRaw = Number.parseInt(sp.limit ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw >= 1
      ? Math.min(limitRaw, VIBE_MAX_LEADS_PER_FETCH)
      : VIBE_DEFAULT_LIMIT;
  const uiFilters = { icpSlug: icp.slug, countries, limit };

  // Confirm mode: token válido + matches.
  let confirmMode = false;
  let matches: number | null = null;
  if (typeof sp.token === "string" && sp.matches) {
    const verdict = verifyEstimate(sp.token, uiFilters, user.email);
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
      <Header confirmMode={confirmMode} />
      {errorMessage && <ErrorBanner message={errorMessage} detail={sp.detail} />}
      {confirmMode && matches !== null ? (
        <ConfirmView
          icp={icp}
          uiFilters={uiFilters}
          matches={matches}
          token={sp.token as string}
        />
      ) : (
        <FilterForm icp={icp} uiFilters={uiFilters} />
      )}
    </section>
  );
}

function Header({ confirmMode }: { confirmMode: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h1 className="text-4xl">Fetch de Vibe</h1>
        <p className="mt-2 text-sm text-muted">
          {confirmMode
            ? "Confirma la ejecución. Las estadísticas son gratis; el fetch se descuenta del saldo de Vibe."
            : "Elige un ICP. Sus filtros (vertical, tamaño, seniority, has_email) se envían a Vibe tal cual; los países son editables."}
        </p>
      </div>
      <Link
        href="/radar"
        className="rounded-md border border-hairline bg-background px-3 py-1.5 text-xs text-foreground hover:border-foreground/40"
      >
        ← Volver a Radar
      </Link>
    </div>
  );
}

function ErrorBanner({
  message,
  detail,
}: {
  message: string;
  detail?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent"
    >
      <p>{message}</p>
      {detail && <p className="mt-1 text-xs text-accent-hover">{detail}</p>}
    </div>
  );
}

function IcpPicker() {
  const withFilters = ICPS.filter((t) => t.vibeFilters);
  return (
    <div className="space-y-3 rounded-lg border border-hairline bg-surface p-6">
      <p className="text-xs uppercase tracking-wider text-muted">
        ICPs con filtros Vibe configurados
      </p>
      {withFilters.length === 0 ? (
        <p className="text-sm text-muted">
          Ningún ICP tiene bloque <code>vibeFilters</code>. Añádelo en{" "}
          <code>src/config/icps.ts</code>.
        </p>
      ) : (
        <ul className="space-y-2">
          {withFilters.map((t) => (
            <li key={t.slug}>
              <Link
                href={`/radar/vibe?icp=${encodeURIComponent(t.slug)}`}
                className="block rounded-md border border-hairline bg-background px-4 py-3 transition-colors hover:border-foreground/40"
              >
                <p className="text-sm font-medium text-foreground">{t.name}</p>
                <p className="mt-1 text-xs text-muted">{t.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterForm({
  icp,
  uiFilters,
}: {
  icp: IcpTemplate;
  uiFilters: { icpSlug: string; countries: string[]; limit: number };
}) {
  return (
    <form
      action={estimateFetchAction}
      className="space-y-6 rounded-lg border border-hairline bg-surface p-6"
    >
      <input type="hidden" name="icpSlug" value={icp.slug} />

      <div className="rounded-md border border-hairline bg-background px-4 py-3 text-xs text-muted">
        ICP: <strong className="text-foreground">{icp.name}</strong>{" "}
        <Link
          href="/radar/vibe"
          className="ml-2 underline decoration-dotted underline-offset-2 hover:text-accent"
        >
          cambiar
        </Link>
      </div>

      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-muted">
          Países (editable)
        </p>
        <div className="flex flex-wrap gap-3">
          {VIBE_AVAILABLE_COUNTRIES.map((c) => (
            <label
              key={c.code}
              className="flex items-center gap-2 text-sm text-foreground"
            >
              <input
                type="checkbox"
                name="countries"
                value={c.code}
                defaultChecked={uiFilters.countries.includes(c.code)}
                className="h-4 w-4 rounded border-hairline bg-background text-accent focus:ring-1 focus:ring-accent/40"
              />
              {c.label}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          Se aplica a <code>company_country_code</code>. Filtrar por país
          del contacto (<code>country_code</code>) requiere probe primero
          — el conector MCP usa <code>prospect_country_code</code> pero
          la API cruda lo rechaza con 422.
        </p>
      </div>

      <IcpFiltersReadOnly icp={icp} />

      <div>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wider text-muted">
          Límite (máx {VIBE_MAX_LEADS_PER_FETCH})
          <input
            type="number"
            name="limit"
            min={1}
            max={VIBE_MAX_LEADS_PER_FETCH}
            defaultValue={uiFilters.limit}
            className="w-32 rounded-md border border-hairline bg-background px-3 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none"
          />
        </label>
      </div>

      <button
        type="submit"
        className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
      >
        Estimar (gratis)
      </button>
    </form>
  );
}

function IcpFiltersReadOnly({ icp }: { icp: IcpTemplate }) {
  const f = icp.vibeFilters!;
  const rows: Array<{ key: string; values: string; note?: string }> = [];
  if (f.linkedin_category) {
    rows.push({
      key: "linkedin_category",
      values: f.linkedin_category.values.join(", "),
    });
  }
  if (f.company_size) {
    rows.push({
      key: "company_size",
      values: f.company_size.values.join(", "),
    });
  }
  if (f.job_level) {
    rows.push({ key: "job_level", values: f.job_level.values.join(", ") });
  }
  if (f.has_contact_details) {
    rows.push({
      key: "has_contact_details",
      values: f.has_contact_details.value,
      note: "solo prospects con email disponible",
    });
  }
  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wider text-muted">
        Filtros del ICP (solo lectura — se envían a Vibe tal cual)
      </p>
      <dl className="space-y-2 rounded-md border border-hairline bg-background px-4 py-3 text-xs">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[10rem_1fr] gap-3">
            <dt className="font-mono text-muted">{row.key}</dt>
            <dd className="text-foreground">
              {row.values}
              {row.note && (
                <span className="ml-2 text-muted">— {row.note}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ConfirmView({
  icp,
  uiFilters,
  matches,
  token,
}: {
  icp: IcpTemplate;
  uiFilters: { icpSlug: string; countries: string[]; limit: number };
  matches: number;
  token: string;
}) {
  const cost = estimateCredits(uiFilters.limit);
  const overCap = cost.total > VIBE_MAX_CREDITS_PER_FETCH;
  const apiFilters = resolveVibeApiFilters(icp, uiFilters.countries);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-accent/30 bg-accent-soft p-6 text-sm">
        <p className="text-xs uppercase tracking-wider text-muted">
          Estimación (con filtros del ICP {icp.name})
        </p>
        <p className="mt-2 text-3xl font-semibold text-foreground">
          {matches.toLocaleString("es-ES")} matches
        </p>
        <p className="mt-1 text-foreground">
          países {uiFilters.countries.join(", ")} · límite {uiFilters.limit}
        </p>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer select-none">
            ver filtros enviados a Vibe
          </summary>
          <pre className="mt-2 overflow-x-auto rounded bg-background p-3 font-mono text-[11px] text-foreground">
{JSON.stringify(apiFilters, null, 2)}
          </pre>
        </details>
        <div className="mt-5 space-y-1 text-foreground">
          <p className="text-xs uppercase tracking-wider text-muted">
            Desglose de coste
          </p>
          <div className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 text-sm">
            <span>
              Fetch ({uiFilters.limit} × {VIBE_CREDITS_PER_LEAD_FETCH} cr/lead)
            </span>
            <span className="text-right tabular-nums">{cost.fetch} cr</span>
            <span>
              Enrich ({uiFilters.limit} × {VIBE_CREDITS_PER_LEAD_ENRICH}{" "}
              cr/lead)
            </span>
            <span className="text-right tabular-nums">{cost.enrich} cr</span>
            <span className="border-t border-hairline pt-1 font-medium text-foreground">
              Total estimado
            </span>
            <span className="border-t border-hairline pt-1 text-right font-semibold tabular-nums text-foreground">
              {cost.total} cr
            </span>
          </div>
          <p className="pt-2 text-xs text-muted">
            Coste orientativo; el descuento real lo fija Vibe. El enrich cubre
            solo los supervivientes tras el cleanup (dedupe empresa/cargo).
            La heurística se irá calibrando con los primeros fetches reales.
          </p>
        </div>
      </div>

      {overCap && (
        <div className="rounded-md border border-amber-400 bg-amber-100 px-4 py-3 text-sm text-amber-900">
          El coste estimado ({cost.total} créditos) supera el cap por defecto
          de {VIBE_MAX_CREDITS_PER_FETCH}. Marca la casilla para confirmar
          explícitamente.
        </div>
      )}

      <form action={executeFetchAction} className="space-y-4">
        <input type="hidden" name="icpSlug" value={icp.slug} />
        <input type="hidden" name="token" value={token} />
        {uiFilters.countries.map((c) => (
          <input key={`c-${c}`} type="hidden" name="countries" value={c} />
        ))}
        <input type="hidden" name="limit" value={String(uiFilters.limit)} />

        {overCap && (
          <label className="flex items-center gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              name="acknowledge_cap"
              className="h-4 w-4 rounded border-amber-400 bg-background text-amber-600 focus:ring-1 focus:ring-amber-400/40"
            />
            Entiendo que el coste supera el cap; confirmar y ejecutar.
          </label>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            className="rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Ejecutar y guardar en Radar
          </button>
          <Link
            href={`/radar/vibe?icp=${encodeURIComponent(icp.slug)}`}
            className="rounded-md border border-hairline bg-background px-4 py-2 text-sm text-foreground transition-colors hover:border-foreground/40"
          >
            Reestimar con otros filtros
          </Link>
        </div>
      </form>
    </div>
  );
}
