import { beforeEach, describe, expect, it } from "vitest";
import {
  getProvider,
  registerProvider,
  resetRegistry,
} from "@/channels/registry";
import type {
  ActiveProviderId,
  ChannelProvider,
  NormalizedEvent,
} from "@/channels/types";

function makeMockProvider(
  overrides: Partial<ChannelProvider> = {},
): ChannelProvider {
  return {
    id: "lemlist" satisfies ActiveProviderId,
    channel: "email",
    async upsertCampaign() {
      return { externalId: "camp-mock-1" };
    },
    async addLead() {
      return {};
    },
    parseWebhookEvent(): NormalizedEvent | null {
      return null;
    },
    ...overrides,
  };
}

describe("channels registry", () => {
  beforeEach(() => {
    resetRegistry();
  });

  it("getProvider lanza si el id no está registrado", () => {
    expect(() => getProvider("lemlist")).toThrow(
      /no registrado.*bootstrap/i,
    );
  });

  it("registerProvider + getProvider roundtrip devuelve la misma instancia", () => {
    const provider = makeMockProvider();
    registerProvider(provider);
    expect(getProvider("lemlist")).toBe(provider);
  });

  it("registrar dos veces el mismo id LANZA (fail loud, no sobrescribe)", () => {
    const first = makeMockProvider();
    const second = makeMockProvider();
    registerProvider(first);

    expect(() => registerProvider(second)).toThrow(
      /ya está registrado.*resetRegistry/i,
    );

    // El primero sigue siendo el activo — el intento fallido no lo tocó.
    expect(getProvider("lemlist")).toBe(first);
  });

  it("resetRegistry permite re-registrar el mismo id (solo para tests)", () => {
    const first = makeMockProvider();
    const second = makeMockProvider();
    registerProvider(first);
    resetRegistry();
    registerProvider(second);
    expect(getProvider("lemlist")).toBe(second);
  });

  it("el mock cumple la firma ChannelProvider sin `as any`", () => {
    // Este test existe para que el compilador (via `satisfies` en el mock)
    // valide la firma. Si ChannelProvider cambia y el mock no compila,
    // el test entero deja de compilar antes de correr.
    const provider = makeMockProvider();
    expect(provider.id).toBe("lemlist");
    expect(provider.channel).toBe("email");
    expect(typeof provider.upsertCampaign).toBe("function");
    expect(typeof provider.addLead).toBe("function");
    expect(typeof provider.parseWebhookEvent).toBe("function");
  });
});
