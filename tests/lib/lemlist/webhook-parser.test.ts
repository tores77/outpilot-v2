import { describe, expect, it } from "vitest";
import {
  parseLemlistWebhook,
  hashEmail,
} from "@/lib/lemlist/webhook-parser";

// Fixtures sintéticas (sin PII real). Las usamos para verificar que
// el parser maneja cada tipo de evento que Lemlist envía — bloque B
// cableará cada uno a su acción, pero bloque A ya los persiste raw
// con type correcto.
//
// Shape derivado del probe real contra /api/activities?version=v2
// (T025, 2026-10-01) — campos conservados, PII sustituida.

function baseEvent(overrides = {}) {
  return {
    _id: "act_test_000001",
    type: "emailsSent",
    campaignId: "cam_test_abc",
    leadId: "lea_test_xyz",
    leadEmail: "person@example.test",
    to: [{ address: "person@example.test", name: "Test Person" }],
    createdAt: "2026-10-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("parseLemlistWebhook — shape por tipo de evento", () => {
  it("emailsSent → ok con todos los campos canónicos", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsSent" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.eventExternalId).toBe("act_test_000001");
    expect(r.event.type).toBe("emailsSent");
    expect(r.event.campaignExternalId).toBe("cam_test_abc");
    expect(r.event.leadExternalId).toBe("lea_test_xyz");
    expect(r.event.email).toBe("person@example.test");
    expect(r.event.emailHash).toBe(hashEmail("person@example.test"));
    expect(r.event.eventCreatedAt).toBeInstanceOf(Date);
    expect(r.event.eventCreatedAt?.toISOString()).toBe(
      "2026-10-01T10:00:00.000Z",
    );
  });

  it("emailsBounced → ok, type preservado", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsBounced" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("emailsBounced");
  });

  it("emailsUnsubscribed → ok, type preservado", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsUnsubscribed" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("emailsUnsubscribed");
  });

  it("emailsReplied → ok, type preservado", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsReplied" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("emailsReplied");
  });

  it("emailsInterested → ok, type preservado", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsInterested" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("emailsInterested");
  });

  it("emailsNotInterested → ok, type preservado", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsNotInterested" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("emailsNotInterested");
  });

  it("tipo desconocido → ok (el procesado en B marca unhandled_type, aquí solo persiste)", () => {
    const r = parseLemlistWebhook(baseEvent({ type: "emailsFooBar" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("emailsFooBar");
  });
});

describe("parseLemlistWebhook — validación mínima", () => {
  it("body=null → not_an_object", () => {
    const r = parseLemlistWebhook(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("not_an_object");
  });

  it("body=array → not_an_object (defensivo, aunque Lemlist envía objetos)", () => {
    const r = parseLemlistWebhook([{ _id: "act_1", type: "emailsSent" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("not_an_object");
  });

  it("falta _id → missing_id", () => {
    const r = parseLemlistWebhook(baseEvent({ _id: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_id");
  });

  it("_id vacío → missing_id (trim)", () => {
    const r = parseLemlistWebhook(baseEvent({ _id: "   " }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_id");
  });

  it("falta type → missing_type", () => {
    const r = parseLemlistWebhook(baseEvent({ type: undefined }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_type");
  });
});

describe("parseLemlistWebhook — extracción de email", () => {
  it("usa leadEmail cuando está presente", () => {
    const r = parseLemlistWebhook(
      baseEvent({ leadEmail: "a@example.test", to: undefined }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.email).toBe("a@example.test");
  });

  it("fallback a to[0].address si no hay leadEmail", () => {
    const r = parseLemlistWebhook(
      baseEvent({
        leadEmail: undefined,
        to: [{ address: "fallback@example.test" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.email).toBe("fallback@example.test");
  });

  it("email a lowercase + trim", () => {
    const r = parseLemlistWebhook(
      baseEvent({ leadEmail: "  Mixed.CASE@Example.Test  " }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.email).toBe("mixed.case@example.test");
  });

  it("sin email → email null + emailHash null (parser sigue ok)", () => {
    const r = parseLemlistWebhook(
      baseEvent({ leadEmail: undefined, to: undefined }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.email).toBeNull();
    expect(r.event.emailHash).toBeNull();
  });
});

describe("hashEmail — determinismo + normalización", () => {
  it("mismo email → mismo hash", () => {
    expect(hashEmail("a@b.com")).toBe(hashEmail("a@b.com"));
  });

  it("case + whitespace → mismo hash tras normalizar", () => {
    expect(hashEmail("A@B.com")).toBe(hashEmail("  a@b.com  "));
  });

  it("hash tiene 64 chars hex", () => {
    const h = hashEmail("x@y.com");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("emails distintos → hashes distintos", () => {
    expect(hashEmail("a@b.com")).not.toBe(hashEmail("c@d.com"));
  });
});

describe("parseLemlistWebhook — campos opcionales ausentes", () => {
  it("sin campaignId → campaignExternalId null (el endpoint lo marca tenant_lookup_failed)", () => {
    const r = parseLemlistWebhook(
      baseEvent({ campaignId: undefined }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.campaignExternalId).toBeNull();
  });

  it("sin leadId → leadExternalId null", () => {
    const r = parseLemlistWebhook(baseEvent({ leadId: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.leadExternalId).toBeNull();
  });

  it("createdAt malformado → eventCreatedAt null (no rompe parse)", () => {
    const r = parseLemlistWebhook(baseEvent({ createdAt: "not-a-date" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.eventCreatedAt).toBeNull();
  });

  it("sin createdAt → eventCreatedAt null", () => {
    const r = parseLemlistWebhook(baseEvent({ createdAt: undefined }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.eventCreatedAt).toBeNull();
  });
});
