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

// T024: por defecto, Volt desactiva open tracking en cada campaña
// nueva. Motivo: Apple MPP y Gmail invalidan el píxel de apertura;
// el "open rate" resultante no es señal accionable y el píxel añade
// peso HTML + un dominio de tracking extra que empeora entregabilidad.
// La decisión GO/NO-GO del smoke se toma sobre reply/bounce/quejas,
// no sobre opens.
export const VOLT_DISABLE_OPEN_TRACKING = true;

// T024: tope duro del smoke_size que la server action de
// /campaigns/[id]/prepare-smoke acepta. Guard de coste: 50 es la
// dirección (Fase 2 R2, spec §7); dejamos 100 de margen para pruebas
// mayores puntuales. Si algún día hace falta subirlo, se cambia
// aquí (audit en el commit).
export const VOLT_SMOKE_MAX_SIZE = 100;
export const VOLT_SMOKE_MIN_SIZE = 1;
