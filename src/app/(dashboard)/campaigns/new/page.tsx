import Link from "next/link";
import { ICPS, getIcpBySlug } from "@/config/icps";
import { createCampaignAction } from "./actions";
import { SubmitButton } from "./submit-button";

const ERROR_MESSAGES: Record<string, string> = {
  no_name: "Escribe un nombre para la campaña.",
  unknown_icp: "El ICP indicado no existe.",
  duplicate_name: "Ya existe una campaña en draft con ese nombre para tu tenant. Cambia el nombre o abre la existente.",
  validation: "La secuencia no valida (mira el detalle).",
  insert: "El insert en la BD falló (mira el detalle).",
};

type NewCampaignSearchParams = {
  icp?: string;
  error?: string;
  detail?: string;
};

export default async function NewCampaignPage({
  searchParams,
}: {
  searchParams: Promise<NewCampaignSearchParams>;
}) {
  const sp = await searchParams;
  const template = sp.icp ? getIcpBySlug(sp.icp) : null;
  const errorMessage = sp.error ? ERROR_MESSAGES[sp.error] ?? "Error." : null;

  return (
    <section className="max-w-3xl space-y-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl">Nueva campaña</h1>
          <p className="mt-2 text-sm text-muted">
            {template
              ? `Plantilla: ${template.name}. Ajusta subject y body por paso antes de guardar; el sync a Lemlist llega en T023.`
              : "Elige un ICP para arrancar. La plantilla es el punto de partida; cada campaña se puede editar antes de guardar."}
          </p>
        </div>
        <Link
          href="/campaigns"
          className="rounded-md border border-hairline bg-background px-3 py-1.5 text-xs text-foreground hover:border-foreground/40"
        >
          ← Volver a Campaigns
        </Link>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="rounded-md border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent"
        >
          <p>{errorMessage}</p>
          {sp.detail && <p className="mt-1 text-xs text-accent-hover">{sp.detail}</p>}
        </div>
      )}

      {template ? (
        <CampaignForm template={template} />
      ) : (
        <IcpPicker />
      )}
    </section>
  );
}

function IcpPicker() {
  return (
    <div className="space-y-3 rounded-lg border border-hairline bg-surface p-6">
      <p className="text-xs uppercase tracking-wider text-muted">ICPs disponibles</p>
      <ul className="space-y-2">
        {ICPS.map((t) => (
          <li key={t.slug}>
            <Link
              href={`/campaigns/new?icp=${encodeURIComponent(t.slug)}`}
              className="block rounded-md border border-hairline bg-background px-4 py-3 transition-colors hover:border-foreground/40"
            >
              <p className="text-sm font-medium text-foreground">{t.name}</p>
              <p className="mt-1 text-xs text-muted">{t.description}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-muted">
                {t.steps.length} pasos
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CampaignForm({
  template,
}: {
  template: ReturnType<typeof getIcpBySlug> & object;
}) {
  return (
    <form
      action={createCampaignAction}
      className="space-y-6 rounded-lg border border-hairline bg-surface p-6"
    >
      <input type="hidden" name="templateSlug" value={template.slug} />

      <div>
        <label
          htmlFor="campaign-name"
          className="block text-sm font-medium text-foreground"
        >
          Nombre de la campaña
        </label>
        <input
          id="campaign-name"
          type="text"
          name="name"
          required
          maxLength={200}
          placeholder={`${template.name} — ${new Date().toLocaleDateString("es-ES", { month: "short", year: "numeric" })}`}
          className="mt-2 block w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
        />
      </div>

      <div className="space-y-6">
        <p className="text-xs uppercase tracking-wider text-muted">
          Pasos ({template.steps.length})
        </p>
        {template.steps.map((step, i) => (
          <fieldset
            key={step.index}
            className="space-y-3 rounded-md border border-hairline bg-background p-4"
          >
            <legend className="px-2 text-xs uppercase tracking-wider text-muted">
              Paso {step.index}{" "}
              {step.delayDays === 0
                ? "(envío inicial)"
                : `(+${step.delayDays} día${step.delayDays === 1 ? "" : "s"})`}
            </legend>
            <input type="hidden" name={`step-${i}-index`} value={step.index} />
            <input
              type="hidden"
              name={`step-${i}-delayDays`}
              value={step.delayDays}
            />
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-muted">
                Subject{" "}
                {step.index === 1 ? (
                  <span className="text-accent">(obligatorio)</span>
                ) : (
                  <span className="text-muted">
                    (opcional — vacío = respuesta en el hilo del step 1)
                  </span>
                )}
              </span>
              <input
                type="text"
                name={`step-${i}-subject`}
                required={step.index === 1}
                defaultValue={step.subject ?? ""}
                placeholder={
                  step.index === 1
                    ? undefined
                    : "Déjalo vacío para enviar como respuesta al step 1"
                }
                className="mt-1 block w-full rounded-md border border-hairline bg-background px-3 py-2 text-sm text-foreground focus:border-accent focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-muted">
                Body (HTML)
              </span>
              <textarea
                name={`step-${i}-bodyHtml`}
                required
                rows={12}
                defaultValue={step.bodyHtml}
                className="mt-1 block w-full rounded-md border border-hairline bg-background px-3 py-2 font-mono text-xs text-foreground focus:border-accent focus:outline-none"
              />
            </label>
          </fieldset>
        ))}
      </div>

      <p className="text-xs text-muted">
        Variables permitidas:{" "}
        <code>{"{{firstName}}"}</code>, <code>{"{{lastName}}"}</code>,{" "}
        <code>{"{{companyName}}"}</code>, <code>{"{{signature}}"}</code>,{" "}
        <code>{"{{opener}}"}</code>. Cualquier otra hace fallar el submit.
      </p>

      <SubmitButton>Crear campaña en draft</SubmitButton>
    </form>
  );
}
