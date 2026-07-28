import { describe, expect, it } from "vitest";
import {
  extractFetchProspects,
  indexEnrichResponseByProspectId,
  mapProspectToLeadDraft,
  mergeEnrichedContact,
} from "@/lib/vibe/mapper";
import type { LeadDraft } from "@/lib/nova/cleanup";
import {
  ENRICH_ITEM_FEDERICO,
  ENRICH_ITEM_INVALID_STATUS,
  ENRICH_ITEM_NO_BLOCK,
  ENRICH_ITEM_NO_EMAIL,
  ENRICH_RESPONSE,
  FETCH_RESPONSE_ONE,
  PROSPECT_FEDERICO,
} from "../fixtures/vibe";

describe("mapProspectToLeadDraft — real fetch shape", () => {
  it("maps the verified round-1 fields into LeadDraft with email null", () => {
    const draft = mapProspectToLeadDraft(PROSPECT_FEDERICO);
    if (!draft) throw new Error("mapper returned null");

    expect(draft.email).toBeNull();
    expect(draft.first_name).toBe("Federico");
    expect(draft.company).toBe("EY");
    expect(draft.title).toBe("Consultor");
    expect(draft.website).toBe("https://www.ey.com");
    expect(draft.linkedin_url).toBe("https://www.linkedin.com/in/federico-example");
    expect(draft.country).toBe("Spain");
    expect(draft.city).toBe("Madrid");
    expect(draft.sector).toBe("professional services");
    expect(draft.custom_fields?.prospect_id).toBe(PROSPECT_FEDERICO.prospect_id);
  });

  it("returns null when prospect_id is missing", () => {
    const draft = mapProspectToLeadDraft({
      ...PROSPECT_FEDERICO,
      prospect_id: "",
    });
    expect(draft).toBeNull();
  });

  it("prefers the single linkedin field, falls back to the array", () => {
    const arrayOnly = mapProspectToLeadDraft({
      prospect_id: "id",
      linkedin: null,
      linkedin_url_array: ["https://linkedin.com/in/from-array"],
    });
    expect(arrayOnly?.linkedin_url).toBe("https://linkedin.com/in/from-array");
  });
});

describe("extractFetchProspects", () => {
  it("returns the data array when present", () => {
    const arr = extractFetchProspects(FETCH_RESPONSE_ONE);
    expect(arr).toHaveLength(1);
    expect(arr[0].prospect_id).toBe(PROSPECT_FEDERICO.prospect_id);
  });

  it("returns an empty array when data is missing", () => {
    expect(extractFetchProspects({})).toEqual([]);
    expect(extractFetchProspects({ total_results: 0 })).toEqual([]);
  });
});

describe("indexEnrichResponseByProspectId", () => {
  it("indexes items by prospect_id for O(1) lookup during the merge", () => {
    const map = indexEnrichResponseByProspectId(ENRICH_RESPONSE);
    expect(map.size).toBe(1);
    const item = map.get(PROSPECT_FEDERICO.prospect_id);
    expect(item?.data?.professions_email).toBe("federico@example.com");
  });
});

describe("mergeEnrichedContact — email + status gate", () => {
  const baseDraft: LeadDraft = {
    email: null,
    first_name: "Federico",
    company: "EY",
    custom_fields: { prospect_id: PROSPECT_FEDERICO.prospect_id },
  };

  it("accepts a valid current_professional email and copies status into custom_fields", () => {
    const outcome = mergeEnrichedContact(baseDraft, ENRICH_ITEM_FEDERICO);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.draft.email).toBe("federico@example.com");
    expect(outcome.draft.custom_fields?.email_status).toBe("valid");
    expect(outcome.draft.custom_fields?.email_type).toBe("current_professional");
  });

  it("rejects when the contact block is null", () => {
    const outcome = mergeEnrichedContact(baseDraft, ENRICH_ITEM_NO_BLOCK);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("no_contact_block");
  });

  it("rejects when there is no email", () => {
    const outcome = mergeEnrichedContact(baseDraft, ENRICH_ITEM_NO_EMAIL);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("no_email");
  });

  it("rejects when professional_email_status is not 'valid'", () => {
    const outcome = mergeEnrichedContact(baseDraft, ENRICH_ITEM_INVALID_STATUS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("invalid_status");
  });

  it("preserves custom_fields already on the draft", () => {
    const outcome = mergeEnrichedContact(
      {
        ...baseDraft,
        custom_fields: {
          prospect_id: PROSPECT_FEDERICO.prospect_id,
          note: "carried over",
        },
      },
      ENRICH_ITEM_FEDERICO,
    );
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.draft.custom_fields?.note).toBe("carried over");
    expect(outcome.draft.custom_fields?.email_status).toBe("valid");
  });
});
