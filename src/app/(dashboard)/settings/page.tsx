import Link from "next/link";
import { getLemlistClient } from "@/lib/lemlist/server-client";
import {
  fetchAllMailboxes,
  type MailboxSummary,
} from "@/channels/lemlist/mailboxes";
import {
  computeWeeklyCapacity,
  effectiveDailySendsPerMailbox,
} from "@/channels/lemlist/provider";
import {
  VOLT_ACTIVE_DAYS_PER_WEEK,
  VOLT_SCHEDULE_DAILY_CAP,
} from "@/config/lemlist";

// Cada request re-fetchea. Con un solo usuario y rate limit 20/2s hay
// margen enorme. Si en Fase 3+ se pinta como widget en el dashboard
// principal, evaluamos revalidate.
export const dynamic = "force-dynamic";

type MailboxesResult =
  | { ok: true; mailboxes: MailboxSummary[] }
  | { ok: false; message: string };

async function loadMailboxes(): Promise<MailboxesResult> {
  try {
    const client = getLemlistClient();
    const mailboxes = await fetchAllMailboxes(client);
    return { ok: true, mailboxes };
  } catch (err) {
    // Nunca 500: la page renderiza un bloque de error con Reintentar.
    // Redactar la key por si aparece en el mensaje del client.
    const raw = err instanceof Error ? err.message : String(err);
    const key = process.env.LEMLIST_API_KEY;
    const redacted =
      key && key.length > 0 ? raw.split(key).join("<KEY>") : raw;
    return { ok: false, message: redacted };
  }
}

// Brand refresh 2026: OK neutro (es el default happy), paused ámbar,
// disabled negro sobre gris (señala no-operativo sin verde/rojo).
const STATUS_STYLES: Record<string, string> = {
  OK: "bg-surface text-foreground",
  paused: "bg-amber-100 text-amber-900",
  disabled: "bg-foreground text-background",
};

function statusClass(status: string): string {
  return STATUS_STYLES[status] ?? "bg-surface text-foreground";
}

function CapacitySummary({ active }: { active: MailboxSummary[] }) {
  if (active.length === 0) {
    return (
      <p className="text-sm text-muted">
        No hay mailboxes activos (<code>status === &quot;OK&quot;</code>);
        capacidad semanal 0.
      </p>
    );
  }

  const emailLimits = active.map((m) => m.emailLimit);
  const total = computeWeeklyCapacity(emailLimits);

  // Si todos los mailboxes activos comparten emailLimit, la formula
  // encaja en una linea. Si divergen, mostramos el total con nota.
  const allSameLimit = emailLimits.every((l) => l === emailLimits[0]);

  if (allSameLimit) {
    const limit = emailLimits[0];
    const perDay = effectiveDailySendsPerMailbox(limit);
    const limitedByWindows = perDay < limit;
    return (
      <p className="text-sm text-foreground">
        {active.length} mailboxes × {perDay} envíos/día
        {limitedByWindows && (
          <span className="text-muted">
            {" "}
            (limitado por ventanas; límite Lemlist {limit})
          </span>
        )}{" "}
        × {VOLT_ACTIVE_DAYS_PER_WEEK} días ={" "}
        <strong className="text-accent">{total}</strong>/semana
      </p>
    );
  }

  return (
    <p className="text-sm text-foreground">
      <strong className="text-accent">{total}</strong> emails/semana ·{" "}
      {active.length} mailboxes con caps mixtos (techo por ventanas:{" "}
      {VOLT_SCHEDULE_DAILY_CAP}/día).
    </p>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="space-y-3 rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent"
    >
      <p className="font-medium">No pude leer los mailboxes de Lemlist.</p>
      <pre className="whitespace-pre-wrap break-words text-xs text-accent-hover">
        {message}
      </pre>
      <div>
        <Link
          href="/settings"
          className="inline-block rounded-md bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
        >
          Reintentar
        </Link>
      </div>
    </div>
  );
}

export default async function SettingsPage() {
  const result = await loadMailboxes();

  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-4xl">Settings</h1>
        <p className="mt-2 text-sm text-muted">
          Config del canal Lemlist. Otros ajustes (allowlist, Twenty) se
          añaden aquí a medida que las fases los pidan.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl">Mailboxes de Lemlist</h2>
          <p className="text-xs uppercase tracking-wider text-muted">
            Solo lectura
          </p>
        </div>

        {result.ok ? (
          <>
            <div className="rounded-md border border-hairline bg-surface px-4 py-3">
              <CapacitySummary
                active={result.mailboxes.filter((m) => m.status === "OK")}
              />
            </div>

            <div className="overflow-x-auto rounded-md border border-hairline">
              <table className="w-full text-sm">
                <thead className="bg-surface">
                  <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-muted">
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Provider</th>
                    <th className="px-4 py-3 font-medium">Límite diario</th>
                    <th className="px-4 py-3 font-medium">Warmup</th>
                    <th className="px-4 py-3 font-medium">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {result.mailboxes.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-4 py-10 text-center text-sm text-muted"
                      >
                        No hay mailboxes en la cuenta de Lemlist.
                      </td>
                    </tr>
                  )}
                  {result.mailboxes.map((m) => (
                    <tr
                      key={m.externalId}
                      className="border-b border-hairline last:border-b-0 hover:bg-surface"
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {m.email}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded px-2 py-0.5 text-[10px] font-medium tracking-wide ${statusClass(m.status)}`}
                        >
                          {m.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {m.provider}
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {m.emailLimit}
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {m.warmupActive ? "Activo" : "Inactivo"}
                      </td>
                      <td
                        className="px-4 py-3 text-muted"
                        title="Placeholder — Sage (T035) calculará el health real."
                      >
                        —
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <ErrorBlock message={result.message} />
        )}
      </div>
    </section>
  );
}
