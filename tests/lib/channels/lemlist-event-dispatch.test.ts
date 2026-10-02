import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchLemlistEvent } from "@/lib/channels/lemlist-event-dispatch";

function loadFixture(name: string): Record<string, unknown> {
  const path = join(process.cwd(), "tests/fixtures/lemlist-events", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("dispatchLemlistEvent (T025 bloque B) — un test por tipo con fixture", () => {
  it("emailsSent fixture → outcome_only sent", () => {
    const fx = loadFixture("emailsSent.json");
    const r = dispatchLemlistEvent(fx.type as string, fx);
    expect(r.kind).toBe("outcome_only");
    if (r.kind !== "outcome_only") return;
    expect(r.outcome).toBe("sent");
  });

  it("emailsBounced fixture → outcome_and_bounce con bounceReason", () => {
    const fx = loadFixture("emailsBounced.json");
    const r = dispatchLemlistEvent(fx.type as string, fx);
    expect(r.kind).toBe("outcome_and_bounce");
    if (r.kind !== "outcome_and_bounce") return;
    expect(r.outcome).toBe("bounced");
    // bounceReason viene de la fixture (campo "supuesto" del README).
    expect(r.bounceReason).toContain("User unknown");
  });

  it("emailsBounced sin bounceReason → bounceReason=null (parser tolerante)", () => {
    const r = dispatchLemlistEvent("emailsBounced", { _id: "x", type: "emailsBounced" });
    expect(r.kind).toBe("outcome_and_bounce");
    if (r.kind !== "outcome_and_bounce") return;
    expect(r.bounceReason).toBeNull();
  });

  it("emailsUnsubscribed fixture → outcome_and_unsubscribe", () => {
    const fx = loadFixture("emailsUnsubscribed.json");
    const r = dispatchLemlistEvent(fx.type as string, fx);
    expect(r.kind).toBe("outcome_and_unsubscribe");
    if (r.kind !== "outcome_and_unsubscribe") return;
    expect(r.outcome).toBe("unsubscribed");
    expect(r.unsubscribeReason).toBe("no_longer_interested");
  });

  it("entityUnsubscribed → mismo mapping que emailsUnsubscribed (sinónimo doc oficial)", () => {
    const r = dispatchLemlistEvent("entityUnsubscribed", { _id: "x", type: "entityUnsubscribed" });
    expect(r.kind).toBe("outcome_and_unsubscribe");
  });

  it("variableUnsubscribed → mismo mapping", () => {
    const r = dispatchLemlistEvent("variableUnsubscribed", { _id: "x", type: "variableUnsubscribed" });
    expect(r.kind).toBe("outcome_and_unsubscribe");
  });

  it("emailsReplied fixture → outcome_and_reply con bodyText + bodyHtml", () => {
    const fx = loadFixture("emailsReplied.json");
    const r = dispatchLemlistEvent(fx.type as string, fx);
    expect(r.kind).toBe("outcome_and_reply");
    if (r.kind !== "outcome_and_reply") return;
    expect(r.outcome).toBe("replied");
    expect(r.bodyText).toContain("gracias por el mensaje");
    expect(r.bodyHtml).toContain("<p>");
  });

  it("emailsReplied sin bodyText/bodyHtml → nulls (parser tolerante, nunca excepción)", () => {
    const r = dispatchLemlistEvent("emailsReplied", {
      _id: "x",
      type: "emailsReplied",
    });
    expect(r.kind).toBe("outcome_and_reply");
    if (r.kind !== "outcome_and_reply") return;
    expect(r.bodyText).toBeNull();
    expect(r.bodyHtml).toBeNull();
  });

  it("emailsInterested → outcome_only interested", () => {
    const r = dispatchLemlistEvent("emailsInterested", { _id: "x", type: "emailsInterested" });
    expect(r.kind).toBe("outcome_only");
    if (r.kind !== "outcome_only") return;
    expect(r.outcome).toBe("interested");
  });

  it("emailsNotInterested → outcome_only not_interested", () => {
    const r = dispatchLemlistEvent("emailsNotInterested", { _id: "x", type: "emailsNotInterested" });
    expect(r.kind).toBe("outcome_only");
    if (r.kind !== "outcome_only") return;
    expect(r.outcome).toBe("not_interested");
  });

  it("tipo desconocido → unhandled (sin excepción)", () => {
    const r = dispatchLemlistEvent("linkedinSent", { _id: "x", type: "linkedinSent" });
    expect(r.kind).toBe("unhandled");
  });

  it("payload no-objeto → unhandled o defaults sin excepción", () => {
    // null como payload: el mapper acepta y usa objeto vacío.
    const r = dispatchLemlistEvent("emailsSent", null);
    expect(r.kind).toBe("outcome_only");
  });

  it("whitespace en bodyText → null (trim defensivo)", () => {
    const r = dispatchLemlistEvent("emailsReplied", {
      _id: "x",
      type: "emailsReplied",
      bodyText: "   ",
      bodyHtml: "",
    });
    expect(r.kind).toBe("outcome_and_reply");
    if (r.kind !== "outcome_and_reply") return;
    expect(r.bodyText).toBeNull();
    expect(r.bodyHtml).toBeNull();
  });
});
