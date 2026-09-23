// OUTPILOT v2 — Channels: interfaz común
// Fase 2 · T017
//
// Spec §2 constitución: "Canal ≠ Proveedor. La interfaz ChannelProvider se
// mantiene aunque v2.1 solo implemente email/Lemlist. Añadir LinkedIn
// después será añadir un provider, no refactorizar."
//
// Los enums se importan de database.types.ts para que un ALTER TYPE en la
// BD (p. ej. añadir `spam_report` a touchpoint_kind — avisado en el header
// de 003) obligue a regenerar tipos y actualice esta superficie sin drift.

import type { Database } from '@/lib/supabase/database.types'

type DBEnums = Database['public']['Enums']

export type ChannelKind         = DBEnums['channel_kind']
export type ActiveProviderId    = DBEnums['channel_provider']
export type TouchpointKind      = DBEnums['touchpoint_kind']
export type TouchpointDirection = DBEnums['touchpoint_direction']

// LinkedIn queda como stub tipado (spec §2). No es valor válido del enum
// channel_provider en BD todavía; para activarlo hay que ampliar
// ActiveProviderId con un ALTER TYPE y registrar el provider real.
export type KnownProviderId = ActiveProviderId | 'linkedin'

export interface CampaignSpec {
  // undefined → crear en el provider; string → actualizar el existente.
  externalId?: string
  name: string
  // Shape acotado en T021 (builder de secuencias). Hoy opaco a propósito.
  sequence: unknown
}

export interface CampaignRef {
  externalId: string
}

export interface AddLeadInput {
  campaignExternalId: string
  leadEmail: string
  // Lex (T022) inyecta las variables aquí; el provider las expande en la
  // plantilla de la secuencia.
  personalization: Record<string, string>
}

export interface NormalizedEvent {
  // Idempotencia. Cae contra el UNIQUE parcial de touchpoints
  // (migración 003): (tenant_id, channel_account_id, provider_event_id)
  // WHERE provider_event_id IS NOT NULL. Si el provider no emite id de
  // evento, null; el unique parcial lo tolera y el caller puede aplicar
  // deduplicación por hash de payload si le hace falta.
  providerEventId: string | null
  kind: TouchpointKind
  direction: TouchpointDirection
  // Mailbox id en el provider — mapea a channel_accounts.external_id.
  channelAccountExternalId: string
  leadEmail: string
  occurredAt: Date
  // Body crudo del webhook. Va sin transformar a touchpoints.payload jsonb
  // para no perder nada que el mapping haya descartado.
  raw: unknown
}

// Contrato ChannelProvider.
//
// Reglas que las tareas siguientes deben respetar (documentadas aquí para
// que ni T018 ni T025 las olviden):
//
//   1. addLead DEBE ser idempotente. Añadir el mismo (campaignExternalId,
//      leadEmail) dos veces no puede crear duplicados en el provider ni
//      resetear el estado del lead en la secuencia. Si el provider no
//      lo garantiza nativamente, la implementación consulta antes de
//      insertar.
//
//   2. La verificación de autenticidad del webhook (firma HMAC, secret
//      compartido, IP allowlist, etc.) NO va en parseWebhookEvent. Va en
//      la ruta que recibe el POST (T025) y se ejecuta ANTES de llamar al
//      parser. parseWebhookEvent asume que el body ya es de confianza.
//
//   3. parseWebhookEvent devuelve null para eventos reconocidos pero
//      ignorables (p. ej. tipos que aún no mapean a touchpoint_kind).
//      Lanza si el payload es inválido o no reconocido — errores duros,
//      no silencio.
export interface ChannelProvider {
  readonly id: ActiveProviderId
  readonly channel: ChannelKind
  upsertCampaign(input: CampaignSpec): Promise<CampaignRef>
  addLead(input: AddLeadInput): Promise<void>
  parseWebhookEvent(
    rawBody: string,
    headers: Record<string, string>,
  ): NormalizedEvent | null
}
