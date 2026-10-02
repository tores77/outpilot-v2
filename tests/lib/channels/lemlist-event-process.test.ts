import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  processLemlistEvent,
  type LemlistEventDeps,
  type LemlistEventRow,
} from "@/lib/channels/lemlist-event-process";

function loadFixture(name: string): Record<string, unknown> {
  const path = join(process.cwd(), "tests/fixtures/lemlist-events", name);
  return JSON.parse(readFileSync(path, "utf8"));
}

function wrapAsEvent(fx: Record<string, unknown>): LemlistEventRow {
  return {
    id: `evt-uuid-${fx._id}`,
    tenant_id: "tenant-xyz",
    type: fx.type as string,
    event_external_id: fx._id as string,
    campaign_external_id: (fx.campaignId as string) ?? null,
    lead_external_id: (fx.leadId as string) ?? null,
    event_created_at: (fx.createdAt as string) ?? null,
    payload: fx,
  };
}

function makeDeps(
  overrides: Partial<LemlistEventDeps> = {},
): LemlistEventDeps {
  return {
    findCampaignLead: vi.fn(async () => ({
      id: "cl-1",
      lead_id: "lead-1",
      outcome: null,
    })),
    getLeadEmail: vi.fn(async () => "person@example.test"),
    updateCampaignLeadOutcome: vi.fn(async () => undefined),
    markLeadNeedsReview: vi.fn(async () => undefined),
    insertReply: vi.fn(async () => ({ duplicate: false })),
    addOutreachExclusion: vi.fn(async () => undefined),
    finalizeEvent: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("processLemlistEvent — un test por tipo con fixture (T025 bloque B)", () => {
  it("emailsSent → outcome=sent + finalize sin error", async () => {
    const deps = makeDeps();
    const event = wrapAsEvent(loadFixture("emailsSent.json"));
    const r = await processLemlistEvent(deps, event);

    expect(r.kind).toBe("processed");
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "sent" }),
    );
    expect(deps.insertReply).not.toHaveBeenCalled();
    expect(deps.addOutreachExclusion).not.toHaveBeenCalled();
    expect(deps.finalizeEvent).toHaveBeenCalledWith({
      tenantId: "tenant-xyz",
      eventId: event.id,
      processingError: null,
    });
  });

  it("emailsBounced → outcome=bounced + outreach_exclusion(reason=bounce) + needs_review", async () => {
    const deps = makeDeps();
    const event = wrapAsEvent(loadFixture("emailsBounced.json"));
    const r = await processLemlistEvent(deps, event);

    expect(r.kind).toBe("processed");
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "bounced" }),
    );
    expect(deps.addOutreachExclusion).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "bounce", email: "person@example.test" }),
    );
    expect(deps.markLeadNeedsReview).toHaveBeenCalledWith({
      tenantId: "tenant-xyz",
      leadId: "lead-1",
    });
    expect(deps.finalizeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ processingError: null }),
    );
  });

  it("emailsUnsubscribed → outcome=unsubscribed + outreach_exclusion(reason=unsubscribe)", async () => {
    const deps = makeDeps();
    const event = wrapAsEvent(loadFixture("emailsUnsubscribed.json"));
    const r = await processLemlistEvent(deps, event);

    expect(r.kind).toBe("processed");
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unsubscribed" }),
    );
    expect(deps.addOutreachExclusion).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "unsubscribe" }),
    );
    expect(deps.markLeadNeedsReview).not.toHaveBeenCalled();
  });

  it("emailsReplied → outcome=replied + insertReply con body_text/html + traza lemlistEventId", async () => {
    const deps = makeDeps();
    const event = wrapAsEvent(loadFixture("emailsReplied.json"));
    const r = await processLemlistEvent(deps, event);

    expect(r.kind).toBe("processed");
    if (r.kind !== "processed") return;
    expect(r.replyInserted).toBe(true);
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "replied" }),
    );
    expect(deps.insertReply).toHaveBeenCalledWith(
      expect.objectContaining({
        lemlistEventId: event.id,
        bodyText: expect.stringContaining("gracias"),
        bodyHtml: expect.stringContaining("<p>"),
      }),
    );
    expect(deps.addOutreachExclusion).not.toHaveBeenCalled();
  });

  it("emailsReplied SIN bodyText/bodyHtml → reply con null (parser tolerante, no excepción)", async () => {
    const deps = makeDeps();
    const event: LemlistEventRow = {
      id: "evt-uuid-replied-nobody",
      tenant_id: "tenant-xyz",
      type: "emailsReplied",
      event_external_id: "act_replied_nobody",
      campaign_external_id: "cam_x",
      lead_external_id: "lea_x",
      event_created_at: "2026-10-02T10:00:00.000Z",
      payload: { _id: "act_replied_nobody", type: "emailsReplied" },
    };
    const r = await processLemlistEvent(deps, event);
    expect(r.kind).toBe("processed");
    expect(deps.insertReply).toHaveBeenCalledWith(
      expect.objectContaining({ bodyText: null, bodyHtml: null }),
    );
  });

  it("emailsInterested → outcome=interested (sin side effects)", async () => {
    const deps = makeDeps();
    const event: LemlistEventRow = {
      id: "evt-uuid-interested",
      tenant_id: "tenant-xyz",
      type: "emailsInterested",
      event_external_id: "act_interested",
      campaign_external_id: "cam_x",
      lead_external_id: "lea_x",
      event_created_at: "2026-10-02T10:00:00.000Z",
      payload: { _id: "act_interested", type: "emailsInterested" },
    };
    const r = await processLemlistEvent(deps, event);
    expect(r.kind).toBe("processed");
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "interested" }),
    );
    expect(deps.insertReply).not.toHaveBeenCalled();
    expect(deps.addOutreachExclusion).not.toHaveBeenCalled();
  });

  it("emailsNotInterested → outcome=not_interested", async () => {
    const deps = makeDeps();
    const event: LemlistEventRow = {
      id: "evt-uuid-ni",
      tenant_id: "tenant-xyz",
      type: "emailsNotInterested",
      event_external_id: "act_ni",
      campaign_external_id: "cam_x",
      lead_external_id: "lea_x",
      event_created_at: "2026-10-02T10:00:00.000Z",
      payload: { _id: "act_ni", type: "emailsNotInterested" },
    };
    const r = await processLemlistEvent(deps, event);
    expect(r.kind).toBe("processed");
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not_interested" }),
    );
  });

  it("tipo desconocido → finalize con processing_error='unhandled_type' (sin tocar otras tablas)", async () => {
    const deps = makeDeps();
    const event: LemlistEventRow = {
      id: "evt-uuid-unknown",
      tenant_id: "tenant-xyz",
      type: "linkedinSent",
      event_external_id: "act_unknown",
      campaign_external_id: "cam_x",
      lead_external_id: "lea_x",
      event_created_at: "2026-10-02T10:00:00.000Z",
      payload: { _id: "act_unknown", type: "linkedinSent" },
    };
    const r = await processLemlistEvent(deps, event);
    expect(r.kind).toBe("unhandled_type");
    expect(deps.findCampaignLead).not.toHaveBeenCalled();
    expect(deps.updateCampaignLeadOutcome).not.toHaveBeenCalled();
    expect(deps.finalizeEvent).toHaveBeenCalledWith({
      tenantId: "tenant-xyz",
      eventId: event.id,
      processingError: "unhandled_type",
    });
  });
});

describe("processLemlistEvent — idempotencia (procesar dos veces)", () => {
  it("emailsSent dos veces (mismo outcome): segunda no cambia outcome ni duplica side effects", async () => {
    const deps = makeDeps({
      // Primera llamada: outcome=null → cambia a sent.
      // Segunda llamada: outcome=sent (ya está) → no cambia.
      findCampaignLead: vi
        .fn()
        .mockResolvedValueOnce({ id: "cl-1", lead_id: "lead-1", outcome: null })
        .mockResolvedValueOnce({ id: "cl-1", lead_id: "lead-1", outcome: "sent" }),
    });
    const event = wrapAsEvent(loadFixture("emailsSent.json"));

    const r1 = await processLemlistEvent(deps, event);
    const r2 = await processLemlistEvent(deps, event);

    expect(r1.kind).toBe("processed");
    expect(r2.kind).toBe("processed");
    if (r1.kind === "processed") expect(r1.outcomeChanged).toBe(true);
    if (r2.kind === "processed") expect(r2.outcomeChanged).toBe(false);

    // updateCampaignLeadOutcome llamado SOLO una vez (en el primer run).
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledTimes(1);
  });

  it("emailsReplied dos veces: segunda inserción es duplicate (unique en lemlist_event_id)", async () => {
    const deps = makeDeps({
      findCampaignLead: vi
        .fn()
        .mockResolvedValueOnce({ id: "cl-1", lead_id: "lead-1", outcome: "sent" })
        .mockResolvedValueOnce({ id: "cl-1", lead_id: "lead-1", outcome: "replied" }),
      insertReply: vi
        .fn()
        .mockResolvedValueOnce({ duplicate: false })
        .mockResolvedValueOnce({ duplicate: true }),
    });
    const event = wrapAsEvent(loadFixture("emailsReplied.json"));

    const r1 = await processLemlistEvent(deps, event);
    const r2 = await processLemlistEvent(deps, event);

    if (r1.kind === "processed") expect(r1.replyInserted).toBe(true);
    if (r2.kind === "processed") expect(r2.replyInserted).toBe(false);

    // insertReply se LLAMA 2 veces (es el callback quien decide
    // duplicate=true por la unique constraint). Lo importante:
    // el segundo run NO lanza excepción.
    expect(deps.insertReply).toHaveBeenCalledTimes(2);
  });

  it("emailsUnsubscribed dos veces: addOutreachExclusion idempotente (callback usa upsert ignoreDuplicates)", async () => {
    const deps = makeDeps({
      findCampaignLead: vi
        .fn()
        .mockResolvedValueOnce({ id: "cl-1", lead_id: "lead-1", outcome: "sent" })
        .mockResolvedValueOnce({ id: "cl-1", lead_id: "lead-1", outcome: "unsubscribed" }),
    });
    const event = wrapAsEvent(loadFixture("emailsUnsubscribed.json"));

    await processLemlistEvent(deps, event);
    await processLemlistEvent(deps, event);

    // Primer run: outcome=sent → unsubscribed, exclusion escrita.
    // Segundo run: outcome ya es unsubscribed (terminal) → no cambia.
    //   addOutreachExclusion se llama otra vez pero el upsert con
    //   ignoreDuplicates lo absorbe sin fallo.
    expect(deps.updateCampaignLeadOutcome).toHaveBeenCalledTimes(1);
    expect(deps.addOutreachExclusion).toHaveBeenCalledTimes(2);
  });
});

describe("processLemlistEvent — evento huérfano", () => {
  it("campaign_lead no encontrado → processing_error='lead_not_found' (sin excepción, finalize OK)", async () => {
    const deps = makeDeps({
      findCampaignLead: vi.fn(async () => null),
    });
    const event = wrapAsEvent(loadFixture("emailsSent.json"));
    const r = await processLemlistEvent(deps, event);

    expect(r.kind).toBe("lead_not_found");
    expect(deps.updateCampaignLeadOutcome).not.toHaveBeenCalled();
    expect(deps.insertReply).not.toHaveBeenCalled();
    expect(deps.finalizeEvent).toHaveBeenCalledWith({
      tenantId: "tenant-xyz",
      eventId: event.id,
      processingError: "lead_not_found",
    });
  });

  it("evento sin lead_external_id → processing_error='lead_not_found' (sin lookup)", async () => {
    const deps = makeDeps();
    const event: LemlistEventRow = {
      id: "evt-no-lead",
      tenant_id: "tenant-xyz",
      type: "emailsSent",
      event_external_id: "act_no_lead",
      campaign_external_id: "cam_x",
      lead_external_id: null,
      event_created_at: null,
      payload: { _id: "act_no_lead", type: "emailsSent" },
    };
    const r = await processLemlistEvent(deps, event);
    expect(r.kind).toBe("lead_not_found");
    expect(deps.findCampaignLead).not.toHaveBeenCalled();
    expect(deps.finalizeEvent).toHaveBeenCalledWith({
      tenantId: "tenant-xyz",
      eventId: event.id,
      processingError: "lead_not_found",
    });
  });
});
