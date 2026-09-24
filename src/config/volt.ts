// OUTPILOT v2 — Volt config
// Fase 2 · T023
//
// Constantes del orquestador Volt (Inngest). Nada de coste ni de
// prompts aquí — Volt no llama a IA. Se limita a orquestar llamadas
// a Lemlist.

// Cuántos leads sincroniza un solo trigger de "Sincronizar N leads".
// Mismo patrón que Lex: tope por trigger para acotar el work-in-flight
// del run de Inngest y darle la opción al humano de repetir clic si
// quedan pendientes.
export const VOLT_MAX_SYNC_PER_TRIGGER = 100;

// Estados de Lemlist en los que ES INSEGURO añadir leads (podrían
// entrar en cola de envío inmediatamente). Cualquier estado fuera de
// esta lista se considera "seguro" para addLead (typically draft o
// paused). El guard se ejecuta antes de sync-lead-*.
export const LEMLIST_UNSAFE_CAMPAIGN_STATES: readonly string[] = [
  "running",
  "started",
  "active",
];

// Firma del error que lanza el guard cuando ve un estado inseguro.
// Nombre estable para que el operador lo reconozca en Inngest UI.
export const VOLT_ERROR_CAMPAIGN_UNSAFE = "campaign_status_unsafe_abort";
