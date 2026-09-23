import { describe, expect, it, vi } from "vitest";
import {
  computeWeeklyCapacity,
  createLemlistEmailProvider,
} from "@/channels/lemlist/provider";
import { LemlistApiError, type LemlistClient } from "@/channels/lemlist/client";
import { VOLT_DEFAULT_SCHEDULE } from "@/config/lemlist";
import {
  lemlistActivityBounced,
  lemlistActivityClicked,
  lemlistActivityFailed,
  lemlistActivityInterested,
  lemlistActivityOpened,
  lemlistActivityReplied,
  lemlistActivitySent,
  lemlistActivityUnsubscribed,
} from "../../fixtures/lemlist";

function makeMockClient(overrides: Partial<LemlistClient> = {}): LemlistClient {
  // Los defaults devuelven undefined; los tests que necesiten inspeccionar
  // sobreescriben con vi.fn(...) casteado a la firma correspondiente.
  const noop = async () => undefined as unknown;
  return {
    get: noop as LemlistClient["get"],
    post: noop as LemlistClient["post"],
    patch: noop as LemlistClient["patch"],
    delete: noop as LemlistClient["delete"],
    ...overrides,
  };
}

describe("computeWeeklyCapacity", () => {
  it("mailboxes x limit x dias del schedule (M-X-J = 3)", () => {
    expect(computeWeeklyCapacity(4, 30)).toBe(4 * 30 * VOLT_DEFAULT_SCHEDULE.weekdays.length);
    expect(computeWeeklyCapacity(0, 30)).toBe(0);
    expect(computeWeeklyCapacity(4, 0)).toBe(0);
  });

  it("clamps a 0 con inputs negativos (defensivo)", () => {
    expect(computeWeeklyCapacity(-2, 30)).toBe(0);
    expect(computeWeeklyCapacity(4, -10)).toBe(0);
  });
});

describe("LemlistEmailProvider - upsertCampaign", () => {
  it("crea (POST /campaigns) con senderStrategy random y schedule M-X-J forzados", async () => {
    const postMock = vi.fn(async () => ({ _id: "cam_new_123" }));
    const client = makeMockClient({ post: postMock as unknown as LemlistClient["post"] });
    const provider = createLemlistEmailProvider({ client });

    const ref = await provider.upsertCampaign({
      name: "Test Campaign",
      sequence: undefined,
    });

    expect(ref).toEqual({ externalId: "cam_new_123" });
    expect(postMock).toHaveBeenCalledWith("/campaigns", {
      name: "Test Campaign",
      senderStrategy: "random",
      schedule: {
        name: VOLT_DEFAULT_SCHEDULE.name,
        timezone: "Europe/Madrid",
        weekdays: [2, 3, 4],
        windows: [
          { start: "09:00", end: "11:00" },
          { start: "15:00", end: "17:00" },
        ],
        secondsToWait: VOLT_DEFAULT_SCHEDULE.secondsBetweenSends,
      },
    });
  });

  it("actualiza (PATCH /campaigns/:id) si viene externalId", async () => {
    const patchMock = vi.fn(async () => ({ _id: "cam_existing" }));
    const client = makeMockClient({ patch: patchMock as unknown as LemlistClient["patch"] });
    const provider = createLemlistEmailProvider({ client });

    const ref = await provider.upsertCampaign({
      externalId: "cam_existing",
      name: "Updated",
      sequence: undefined,
    });

    expect(ref).toEqual({ externalId: "cam_existing" });
    expect(patchMock).toHaveBeenCalledWith(
      "/campaigns/cam_existing",
      expect.objectContaining({ name: "Updated", senderStrategy: "random" }),
    );
  });

  it("lanza si el POST no devuelve _id (contrato roto)", async () => {
    const client = makeMockClient({
      post: (async () => ({})) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    await expect(
      provider.upsertCampaign({ name: "x", sequence: undefined }),
    ).rejects.toThrow(/sin _id/);
  });
});

describe("LemlistEmailProvider - addLead (idempotencia)", () => {
  it("POST /campaigns/:id/leads/:email con la personalización", async () => {
    const postMock = vi.fn(async () => ({}));
    const client = makeMockClient({ post: postMock as unknown as LemlistClient["post"] });
    const provider = createLemlistEmailProvider({ client });

    await provider.addLead({
      campaignExternalId: "cam_x",
      leadEmail: "lead@example.com",
      personalization: { firstName: "Alice", companyName: "Acme" },
    });

    expect(postMock).toHaveBeenCalledWith(
      "/campaigns/cam_x/leads/lead%40example.com",
      { firstName: "Alice", companyName: "Acme" },
    );
  });

  it("swallowea 409 (lead ya existe) como éxito silencioso", async () => {
    const client = makeMockClient({
      post: (async () => {
        throw new LemlistApiError(409, "already in campaign", "POST", "/campaigns/x/leads/y");
      }) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });

    await expect(
      provider.addLead({
        campaignExternalId: "cam_x",
        leadEmail: "dup@example.com",
        personalization: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("swallowea 400 con 'already' en el body", async () => {
    const client = makeMockClient({
      post: (async () => {
        throw new LemlistApiError(
          400,
          "lead already added to this campaign",
          "POST",
          "/campaigns/x/leads/y",
        );
      }) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    await expect(
      provider.addLead({
        campaignExternalId: "cam_x",
        leadEmail: "dup@example.com",
        personalization: {},
      }),
    ).resolves.toBeUndefined();
  });

  it("propaga otros errores (500, 401, etc.)", async () => {
    const client = makeMockClient({
      post: (async () => {
        throw new LemlistApiError(500, "server exploded", "POST", "/x");
      }) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    await expect(
      provider.addLead({
        campaignExternalId: "cam_x",
        leadEmail: "a@b.com",
        personalization: {},
      }),
    ).rejects.toBeInstanceOf(LemlistApiError);
  });
});

describe("LemlistEmailProvider - parseWebhookEvent (mapping)", () => {
  const provider = createLemlistEmailProvider({ client: makeMockClient() });

  const casos: Array<[string, unknown, string, "outbound" | "inbound"]> = [
    ["sent → email_sent (outbound)", lemlistActivitySent, "email_sent", "outbound"],
    ["opened → email_opened (outbound)", lemlistActivityOpened, "email_opened", "outbound"],
    ["clicked → email_clicked (outbound)", lemlistActivityClicked, "email_clicked", "outbound"],
    ["bounced → email_bounced (outbound)", lemlistActivityBounced, "email_bounced", "outbound"],
    ["failed → email_failed (outbound)", lemlistActivityFailed, "email_failed", "outbound"],
    [
      "unsubscribed → email_unsubscribed (outbound)",
      lemlistActivityUnsubscribed,
      "email_unsubscribed",
      "outbound",
    ],
    ["replied → email_replied (INBOUND)", lemlistActivityReplied, "email_replied", "inbound"],
  ];

  for (const [label, activity, expectedKind, expectedDirection] of casos) {
    it(label, () => {
      const evt = provider.parseWebhookEvent(JSON.stringify(activity), {});
      expect(evt).not.toBeNull();
      expect(evt!.kind).toBe(expectedKind);
      expect(evt!.direction).toBe(expectedDirection);
    });
  }

  it("devuelve null para emailsInterested (Echo clasifica en T027)", () => {
    const evt = provider.parseWebhookEvent(JSON.stringify(lemlistActivityInterested), {});
    expect(evt).toBeNull();
  });

  it("lanza para type desconocido (no silencio)", () => {
    expect(() =>
      provider.parseWebhookEvent(
        JSON.stringify({
          _id: "act_x",
          type: "emailsInvented",
          createdAt: "2026-09-20T00:00:00Z",
          leadEmail: "a@b.com",
        }),
        {},
      ),
    ).toThrow(/desconocido/);
  });

  it("lanza si el body no es JSON válido", () => {
    expect(() => provider.parseWebhookEvent("not json", {})).toThrow(/JSON/);
  });

  it("lanza si falta 'type'", () => {
    expect(() =>
      provider.parseWebhookEvent(
        JSON.stringify({ _id: "act_x", createdAt: "2026-09-20T00:00:00Z" }),
        {},
      ),
    ).toThrow(/type/);
  });

  it("lanza si falta leadEmail/email (sin lead no hay touchpoint)", () => {
    expect(() =>
      provider.parseWebhookEvent(
        JSON.stringify({
          _id: "act_x",
          type: "emailsSent",
          createdAt: "2026-09-20T00:00:00Z",
        }),
        {},
      ),
    ).toThrow(/leadEmail/);
  });
});

describe("LemlistEmailProvider - parseWebhookEvent (PII stripping)", () => {
  const provider = createLemlistEmailProvider({ client: makeMockClient() });

  it("raw NO contiene campos PII en un email_sent", () => {
    const evt = provider.parseWebhookEvent(JSON.stringify(lemlistActivitySent), {});
    const raw = evt!.raw as Record<string, unknown>;

    // Estos NO deben estar
    expect(raw).not.toHaveProperty("email");
    expect(raw).not.toHaveProperty("firstName");
    expect(raw).not.toHaveProperty("lastName");
    expect(raw).not.toHaveProperty("leadEmail");
    expect(raw).not.toHaveProperty("leadFirstName");
    expect(raw).not.toHaveProperty("leadLastName");
    expect(raw).not.toHaveProperty("leadCompanyName");
    expect(raw).not.toHaveProperty("companyDomain");
    expect(raw).not.toHaveProperty("linkedinUrl");

    // Estos SI (campos operativos)
    expect(raw).toHaveProperty("type", "emailsSent");
    expect(raw).toHaveProperty("_id");
    expect(raw).toHaveProperty("sendUserMailboxId");
  });

  it("raw NO contiene subject/body en un email_sent (no es replied)", () => {
    // Añadimos body/subject artificialmente a un sent para verificar el strip.
    const sentConCopy = { ...lemlistActivitySent, subject: "Hi", body: "<p>x</p>" };
    const evt = provider.parseWebhookEvent(JSON.stringify(sentConCopy), {});
    const raw = evt!.raw as Record<string, unknown>;
    expect(raw).not.toHaveProperty("subject");
    expect(raw).not.toHaveProperty("body");
  });

  it("raw SI contiene subject/body/text en email_replied (Echo lo necesita)", () => {
    const evt = provider.parseWebhookEvent(JSON.stringify(lemlistActivityReplied), {});
    const raw = evt!.raw as Record<string, unknown>;
    expect(raw).toHaveProperty("subject");
    expect(raw).toHaveProperty("body");
    expect(raw).toHaveProperty("text");
    // Pero la PII sigue fuera
    expect(raw).not.toHaveProperty("leadEmail");
    expect(raw).not.toHaveProperty("leadFirstName");
  });

  it("providerEventId es _id del activity, leadEmail viene top-level", () => {
    const evt = provider.parseWebhookEvent(JSON.stringify(lemlistActivitySent), {});
    expect(evt!.providerEventId).toBe(lemlistActivitySent._id);
    expect(evt!.leadEmail).toBe(lemlistActivitySent.leadEmail);
    expect(evt!.channelAccountExternalId).toBe(lemlistActivitySent.sendUserMailboxId);
    expect(evt!.occurredAt.toISOString()).toBe(lemlistActivitySent.createdAt);
  });

  it("providerEventId es null si el activity no trae _id (raro pero soportado)", () => {
    const sinId = { ...lemlistActivitySent };
    delete (sinId as unknown as { _id?: unknown })._id;
    const evt = provider.parseWebhookEvent(JSON.stringify(sinId), {});
    expect(evt!.providerEventId).toBeNull();
  });
});
