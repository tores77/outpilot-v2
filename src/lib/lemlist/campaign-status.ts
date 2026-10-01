// OUTPILOT v2 · Lemlist campaign status mapper (T025 bloque D)
//
// Funciones puras que:
//   1. Mapean el string de estado que devuelve Lemlist (GET
//      /api/campaigns/:cid) a nuestro enum interno `campaign_status`.
//   2. Detectan "drift" entre el estado interno y el que reporta
//      Lemlist, para que el job pueda emitir un evento informativo.
//
// IMPORTANTE: el job D NO transiciona el status interno. La columna
// `campaigns.status` sigue siendo manual (lifecycle del humano:
// draft → smoke_test → active → paused → done). El job solo refleja
// el estado del provider en una columna nueva (`provider_status`) y
// registra drifts como eventos. Pere decide cuándo transicionar
// `status`. Motivo: `smoke_test` es un estado NUESTRO que Lemlist
// no conoce; si el job pasara automáticamente smoke_test → active
// cuando Lemlist dice "running", perderíamos esa semántica.
//
// Estados Lemlist observados (probes T018/T023/T025):
//   running | started | active | paused | ended
// Otros documentados en developer.lemlist.com (no verificados en
// vivo): stopped, finished, archived.

export type CampaignStatus =
  | "draft"
  | "smoke_test"
  | "active"
  | "paused"
  | "done";

/**
 * Mapea un string de Lemlist a nuestro enum interno. Devuelve null
 * si el estado del provider no corresponde a ningún estado interno
 * mappeable — el caller debe tratarlo como "no toco nada, solo
 * loguea el provider_status crudo". Case-insensitive por defensa.
 */
export function mapLemlistCampaignStatus(
  providerStatus: string | null | undefined,
): CampaignStatus | null {
  if (!providerStatus) return null;
  const s = providerStatus.toLowerCase().trim();
  if (s === "running" || s === "started" || s === "active") return "active";
  if (s === "paused" || s === "stopped") return "paused";
  if (s === "ended" || s === "finished" || s === "archived") return "done";
  return null;
}

export type DriftResult = {
  drift: boolean;
  mapped: CampaignStatus | null;
  /**
   * Clasificación semántica del drift (solo si drift=true). Útil
   * para dashboards / eventos — permite filtrar "campañas enviando
   * sin autorizar" vs "campañas que Lemlist ha pausado por bounce".
   */
  kind:
    | "none"
    | "lemlist_ahead_of_internal"      // internal=draft|smoke_test, provider=active|paused|done
    | "paused_externally"              // internal=active, provider=paused
    | "resumed_externally"             // internal=paused, provider=active
    | "ended_externally"               // internal≠done, provider=done
    | "unmapped";                      // provider devuelve algo que no mapeamos
};

/**
 * Detecta drift entre nuestro `status` interno y el `providerStatus`
 * crudo que acabamos de leer. Returns la clasificación del drift.
 *
 * Reglas:
 *   - mapped=null → no clasificamos, solo reflejamos (unmapped).
 *   - internal ∈ {draft, smoke_test} + mapped ∈ {active, paused, done}
 *     → lemlist_ahead_of_internal. Pere pensaba estar en modo
 *     prueba pero Lemlist ya operaba.
 *   - internal=active + mapped=paused → paused_externally (ej.
 *     Lemlist pausó por bounce rate; viene del bloque C).
 *   - internal=paused + mapped=active → resumed_externally (alguien
 *     reanudó en el panel de Lemlist sin tocar BD).
 *   - internal≠done + mapped=done → ended_externally.
 *   - resto: no drift.
 */
export function detectInternalStatusDrift(
  internal: CampaignStatus,
  providerStatus: string | null | undefined,
): DriftResult {
  const mapped = mapLemlistCampaignStatus(providerStatus);
  if (mapped === null) {
    return {
      drift: Boolean(providerStatus && providerStatus.trim().length > 0),
      mapped: null,
      kind: providerStatus && providerStatus.trim().length > 0 ? "unmapped" : "none",
    };
  }

  if ((internal === "draft" || internal === "smoke_test") &&
      (mapped === "active" || mapped === "paused" || mapped === "done")) {
    return { drift: true, mapped, kind: "lemlist_ahead_of_internal" };
  }
  if (internal === "active" && mapped === "paused") {
    return { drift: true, mapped, kind: "paused_externally" };
  }
  if (internal === "paused" && mapped === "active") {
    return { drift: true, mapped, kind: "resumed_externally" };
  }
  if (internal !== "done" && mapped === "done") {
    return { drift: true, mapped, kind: "ended_externally" };
  }
  return { drift: false, mapped, kind: "none" };
}
