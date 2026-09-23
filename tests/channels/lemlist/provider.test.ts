import { describe, expect, it, vi } from "vitest";
import {
  computeWeeklyCapacity,
  createLemlistEmailProvider,
} from "@/channels/lemlist/provider";
import { LemlistApiError, type LemlistClient } from "@/channels/lemlist/client";
import {
  VOLT_ACTIVE_DAYS_PER_WEEK,
  VOLT_DEFAULT_SCHEDULES,
} from "@/config/lemlist";
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
    expect(computeWeeklyCapacity(4, 30)).toBe(4 * 30 * VOLT_ACTIVE_DAYS_PER_WEEK);
    expect(computeWeeklyCapacity(0, 30)).toBe(0);
    expect(computeWeeklyCapacity(4, 0)).toBe(0);
  });

  it("clamps a 0 con inputs negativos (defensivo)", () => {
    expect(computeWeeklyCapacity(-2, 30)).toBe(0);
    expect(computeWeeklyCapacity(4, -10)).toBe(0);
  });
});

describe("LemlistEmailProvider - upsertCampaign (create flow 5 pasos)", () => {
  it("crea con body minimo, PATCHea default schedule, POST + asocia el segundo", async () => {
    const postMock = vi.fn(async (path: string) => {
      if (path === "/campaigns") return { _id: "cam_new_123" };
      if (path === "/schedules") return { _id: "skd_afternoon" };
      // associate: POST /campaigns/:cid/schedules/:sid
      return { scheduleId: "skd_afternoon", campaignId: "cam_new_123" };
    });
    const getMock = vi.fn(async () => [{ _id: "skd_default_morning" }]);
    const patchMock = vi.fn(async () => ({ _id: "skd_default_morning" }));
    const client = makeMockClient({
      post: postMock as unknown as LemlistClient["post"],
      get: getMock as unknown as LemlistClient["get"],
      patch: patchMock as unknown as LemlistClient["patch"],
    });
    const provider = createLemlistEmailProvider({ client });

    const ref = await provider.upsertCampaign({
      name: "Test Campaign",
      sequence: undefined,
    });

    expect(ref).toEqual({ externalId: "cam_new_123" });

    // 1. POST /campaigns con body minimo (SIN schedule embebido —
    //    aprendido en el probe: se ignora).
    expect(postMock).toHaveBeenNthCalledWith(1, "/campaigns", {
      name: "Test Campaign",
      senderStrategy: "random",
    });

    // 2. GET /campaigns/:cid/schedules para el default._id.
    expect(getMock).toHaveBeenCalledWith("/campaigns/cam_new_123/schedules");

    // 3. PATCH del default con ventana 1 (morning).
    expect(patchMock).toHaveBeenCalledWith(
      "/schedules/skd_default_morning",
      VOLT_DEFAULT_SCHEDULES[0],
    );

    // 4. POST /schedules con ventana 2 (afternoon).
    expect(postMock).toHaveBeenNthCalledWith(2, "/schedules", VOLT_DEFAULT_SCHEDULES[1]);

    // 5. POST asociar ventana 2 a la campana. Body undefined (aprendido).
    expect(postMock).toHaveBeenNthCalledWith(
      3,
      "/campaigns/cam_new_123/schedules/skd_afternoon",
      undefined,
    );

    // Total calls verificacion.
    expect(postMock).toHaveBeenCalledTimes(3);
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  it("actualiza (PATCH /campaigns/:id) si viene externalId — solo name, no toca schedules", async () => {
    const patchMock = vi.fn(async () => ({ _id: "cam_existing" }));
    const postMock = vi.fn(async () => ({}));
    const getMock = vi.fn(async () => []);
    const client = makeMockClient({
      patch: patchMock as unknown as LemlistClient["patch"],
      post: postMock as unknown as LemlistClient["post"],
      get: getMock as unknown as LemlistClient["get"],
    });
    const provider = createLemlistEmailProvider({ client });

    const ref = await provider.upsertCampaign({
      externalId: "cam_existing",
      name: "Updated",
      sequence: undefined,
    });

    expect(ref).toEqual({ externalId: "cam_existing" });
    // Un unico PATCH con solo el name — no reconciliamos schedules
    // en update (v2.1 no permite cambiarlos por UI).
    expect(patchMock).toHaveBeenCalledWith("/campaigns/cam_existing", {
      name: "Updated",
    });
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("lanza si POST /campaigns no devuelve _id (contrato roto)", async () => {
    const client = makeMockClient({
      post: (async () => ({})) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    await expect(
      provider.upsertCampaign({ name: "x", sequence: undefined }),
    ).rejects.toThrow(/POST \/campaigns sin _id/);
  });

  it("lanza si GET schedules no encuentra el default (contrato roto)", async () => {
    const client = makeMockClient({
      post: (async () => ({ _id: "cam_x" })) as unknown as LemlistClient["post"],
      get: (async () => []) as unknown as LemlistClient["get"],
    });
    const provider = createLemlistEmailProvider({ client });
    await expect(
      provider.upsertCampaign({ name: "x", sequence: undefined }),
    ).rejects.toThrow(/no encuentro Default schedule/);
  });

  it("lanza si POST del segundo schedule no devuelve _id", async () => {
    const postMock = vi.fn(async (path: string) => {
      if (path === "/campaigns") return { _id: "cam_x" };
      if (path === "/schedules") return {}; // sin _id
      return {};
    });
    const client = makeMockClient({
      post: postMock as unknown as LemlistClient["post"],
      get: (async () => [{ _id: "skd_def" }]) as unknown as LemlistClient["get"],
      patch: (async () => ({})) as unknown as LemlistClient["patch"],
    });
    const provider = createLemlistEmailProvider({ client });
    await expect(
      provider.upsertCampaign({ name: "x", sequence: undefined }),
    ).rejects.toThrow(/POST \/schedules \(window2\) sin _id/);
  });
});

describe("LemlistEmailProvider - addLead (idempotencia + result)", () => {
  it("POST /campaigns/:id/leads/:email con personalización y devuelve providerLeadId + providerContactId", async () => {
    const postMock = vi.fn(async () => ({
      _id: "lea_new_123",
      contactId: "ctc_shared_456",
      // Lemlist devuelve mas campos (email, firstName, etc.) — solo _id
      // y contactId nos interesan, el resto es ignorado por el provider.
      email: "lead@example.com",
      firstName: "Alice",
    }));
    const client = makeMockClient({
      post: postMock as unknown as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });

    const result = await provider.addLead({
      campaignExternalId: "cam_x",
      leadEmail: "lead@example.com",
      personalization: { firstName: "Alice", companyName: "Acme" },
    });

    expect(postMock).toHaveBeenCalledWith(
      "/campaigns/cam_x/leads/lead%40example.com",
      { firstName: "Alice", companyName: "Acme" },
    );
    expect(result).toEqual({
      providerLeadId: "lea_new_123",
      providerContactId: "ctc_shared_456",
    });
  });

  it("swallowea 400 con 'Lead already in the campaign' (string exacto del probe) → devuelve {}", async () => {
    const client = makeMockClient({
      post: (async () => {
        throw new LemlistApiError(
          400,
          "Lead already in the campaign",
          "POST",
          "/campaigns/x/leads/y",
        );
      }) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    const result = await provider.addLead({
      campaignExternalId: "cam_x",
      leadEmail: "dup@example.com",
      personalization: {},
    });
    expect(result).toEqual({});
  });

  it("swallowea 409 si algun dia Lemlist cambia al codigo canonico", async () => {
    const client = makeMockClient({
      post: (async () => {
        throw new LemlistApiError(409, "conflict", "POST", "/campaigns/x/leads/y");
      }) as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    const result = await provider.addLead({
      campaignExternalId: "cam_x",
      leadEmail: "dup@example.com",
      personalization: {},
    });
    expect(result).toEqual({});
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

  it("si la respuesta no trae _id ni contactId, devuelve campos undefined (no lanza)", async () => {
    const client = makeMockClient({
      post: (async () => ({})) as unknown as LemlistClient["post"],
    });
    const provider = createLemlistEmailProvider({ client });
    const result = await provider.addLead({
      campaignExternalId: "cam_x",
      leadEmail: "a@b.com",
      personalization: {},
    });
    expect(result).toEqual({
      providerLeadId: undefined,
      providerContactId: undefined,
    });
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
