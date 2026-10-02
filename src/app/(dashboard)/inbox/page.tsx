// Inbox — lista mínima de replies sin etiquetar (T025 bloque E).
//
// Pedido Pere: texto, empresa (company_display del
// campaign_lead.personalization), 5 botones de etiqueta
// (interesado / no ahora / no interesado / fuera de ICP / baja).
// Al etiquetar: label + labeled_by='human' + labeled_at.
//
// Scope: nada más. Sin filtros, sin paginación (volumen esperado:
// decenas de replies). Si crece, se refactoriza.

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { labelReplyAction } from "./actions";
import { INBOX_LABELS } from "./labels";

type PageSearchParams = Promise<Record<string, string | undefined>>;

const LABEL_UI: Record<(typeof INBOX_LABELS)[number], string> = {
  interesado: "Interesado",
  no_ahora: "No ahora",
  no_interesado: "No interesado",
  fuera_de_icp: "Fuera de ICP",
  baja: "Baja",
};

function companyFromPersonalization(p: unknown): string | null {
  if (!p || typeof p !== "object") return null;
  const v = (p as Record<string, unknown>).company_display;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function formatReceived(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  });
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const sp = await searchParams;
  const supabase = await createSupabaseServerClient();

  // RLS filtra por tenant del caller — no hace falta .eq("tenant_id").
  const { data, error } = await supabase
    .from("replies")
    .select(
      "id, received_at, body_text, body_html, campaign_lead:campaign_leads!inner(id, personalization, lead:leads!inner(company))",
    )
    .is("label", null)
    .order("received_at", { ascending: false })
    .limit(100);

  const replies = (data ?? []) as Array<{
    id: string;
    received_at: string;
    body_text: string | null;
    body_html: string | null;
    campaign_lead: {
      id: string;
      personalization: unknown;
      lead: { company: string | null };
    };
  }>;

  return (
    <section className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-4xl">Inbox</h1>
        <p className="mt-2 text-sm text-muted">
          Replies sin etiquetar. Etiqueta para que salgan de aquí; el
          histórico queda en <code>replies</code>.
        </p>
      </div>

      {sp.error && (
        <div
          role="alert"
          className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent"
        >
          Error: <code>{sp.error}</code>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent"
        >
          Error cargando replies: <code>{error.message}</code>
        </div>
      )}

      {replies.length === 0 && !error && (
        <p className="rounded-md border border-hairline bg-surface px-4 py-10 text-center text-sm text-muted">
          No hay replies sin etiquetar.
        </p>
      )}

      <ul className="space-y-4">
        {replies.map((r) => {
          const company =
            companyFromPersonalization(r.campaign_lead.personalization) ??
            r.campaign_lead.lead.company ??
            "—";
          return (
            <li
              key={r.id}
              className="rounded-md border border-hairline bg-background p-4"
            >
              <header className="mb-3 flex items-center justify-between gap-4 text-xs text-muted">
                <span className="font-medium text-foreground">{company}</span>
                <time>{formatReceived(r.received_at)}</time>
              </header>
              <div className="mb-4 whitespace-pre-wrap break-words text-sm text-foreground">
                {r.body_text ?? (
                  <span className="italic text-muted">
                    (sin body_text; ver body_html o /api/activities)
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {INBOX_LABELS.map((label) => (
                  <form key={label} action={labelReplyAction}>
                    <input type="hidden" name="reply_id" value={r.id} />
                    <input type="hidden" name="label" value={label} />
                    <button
                      type="submit"
                      className="rounded-md border border-hairline bg-surface px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent-soft hover:text-accent"
                    >
                      {LABEL_UI[label]}
                    </button>
                  </form>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
