// Etiquetas aceptadas en /inbox (T025 bloque E).
//
// Archivo separado de actions.ts porque Next 16 exige que un
// archivo con "use server" solo exporte funciones async; aquí
// vive la const + el type.

export const INBOX_LABELS = [
  "interesado",
  "no_ahora",
  "no_interesado",
  "fuera_de_icp",
  "baja",
] as const;

export type InboxLabel = (typeof INBOX_LABELS)[number];
