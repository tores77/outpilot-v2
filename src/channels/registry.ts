// OUTPILOT v2 — Channels: registry
// Fase 2 · T017
//
// Registro por id de provider. Un provider por id — registrar dos veces
// el mismo id LANZA (evita que un bootstrap doble esconda que dos
// implementaciones distintas comparten id y gana la última en silencio).
// Los tests que necesiten reemplazar un provider usan resetRegistry().

import type { ActiveProviderId, ChannelProvider } from './types'

const registry = new Map<ActiveProviderId, ChannelProvider>()

export function registerProvider(provider: ChannelProvider): void {
  if (registry.has(provider.id)) {
    throw new Error(
      `Channel provider '${provider.id}' ya está registrado. ` +
        `Registrar dos veces indica un error de bootstrap. ` +
        `Usa resetRegistry() en tests si necesitas reemplazar uno.`,
    )
  }
  registry.set(provider.id, provider)
}

export function getProvider(id: ActiveProviderId): ChannelProvider {
  const provider = registry.get(id)
  if (!provider) {
    throw new Error(
      `Channel provider '${id}' no registrado. ` +
        `Falta llamar a registerProvider() en el bootstrap.`,
    )
  }
  return provider
}

// Solo para tests. En runtime no debería llamarse — el registro es
// build-time por bootstrap explícito.
export function resetRegistry(): void {
  registry.clear()
}
