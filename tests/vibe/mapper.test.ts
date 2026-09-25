import { describe, expect, it } from "vitest";
import {
  extractFetchProspects,
  indexEnrichResponseByProspectId,
  mapProspectToLeadDraft,
  mergeBusinessFirmographics,
  mergeEnrichedContact,
  rootDomain,
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

// ==============================================================
// T024: guard de coherencia de dominio para firmographics
// ==============================================================

describe("rootDomain (T024)", () => {
  it("elimina protocolo, path y www", () => {
    expect(rootDomain("https://www.acme.com/about?x=1")).toBe("acme.com");
    expect(rootDomain("http://acme.com")).toBe("acme.com");
    expect(rootDomain("acme.com")).toBe("acme.com");
    expect(rootDomain("www.acme.com")).toBe("acme.com");
  });

  it("conserva subdominios distintos (mismatch conservador)", () => {
    // Un lead con website subdominado y un enrich con root son
    // técnicamente empresas distintas — el guard los separa.
    expect(rootDomain("shop.acme.com")).toBe("shop.acme.com");
    expect(rootDomain("https://shop.acme.com/")).toBe("shop.acme.com");
  });

  it("lowercase", () => {
    expect(rootDomain("HTTPS://Acme.COM")).toBe("acme.com");
  });

  it("null/inválido → null", () => {
    expect(rootDomain(null)).toBeNull();
    expect(rootDomain("")).toBeNull();
    expect(rootDomain("  ")).toBeNull();
    expect(rootDomain("not a url with spaces")).toBeNull();
  });
});

describe("mergeBusinessFirmographics — guard de dominio (T024)", () => {
  const baseDraft = {
    email: "x@intarcon.com",
    company: "Intarcon",
    website: "https://www.intarcon.com/",
    custom_fields: { business_id: "biz1" },
  };

  it("dominios coinciden → merge completo + domainVerified=true", () => {
    const outcome = mergeBusinessFirmographics(baseDraft, {
      website: "https://intarcon.com",
      business_description: "Spanish leading manufacturer for refrigeration.",
      number_of_employees_range: "201-500",
      yearly_revenue_range: "75M-200M",
      linkedin_industry_category: "industrial machinery manufacturing",
      naics_description: "Industrial Machinery Manufacturing",
    });
    expect(outcome.mismatch).toBeUndefined();
    expect(outcome.domainVerified).toBe(true);
    expect(outcome.draft.custom_fields?.company_description).toContain("refrigeration");
    expect(outcome.draft.custom_fields?.company_size).toBe("201-500");
    expect(outcome.draft.custom_fields?.firmographics_domain_verified).toBe("true");
    expect(outcome.draft.sector).toBe("industrial machinery manufacturing");
  });

  it("REGRESIÓN Linq: mismatch → NO persiste description + marca mismatch", () => {
    // El lead viene con linqcase.com (fundas de móvil). Vibe matchea
    // otra "Linq" (inspection systems, dominio linq.com). El guard
    // debe descartar la contaminación y marcar data_mismatch.
    const linqDraft = {
      email: "founder@linqcase.com",
      company: "Linq",
      website: "https://linqcase.com/",
      custom_fields: { business_id: "biz-wrong" },
    };
    const outcome = mergeBusinessFirmographics(linqDraft, {
      website: "https://linq.com",
      business_description: "nondestructive electromagnetic inspection systems for metal components",
      number_of_employees_range: "11-50",
      linkedin_industry_category: "industrial machinery manufacturing",
    });
    expect(outcome.mismatch).toEqual({
      vibe_domain: "linq.com",
      lead_domain: "linqcase.com",
    });
    expect(outcome.domainVerified).toBe(false);
    // NO se persiste la descripción contaminada
    expect(outcome.draft.custom_fields?.company_description).toBeUndefined();
    expect(outcome.draft.custom_fields?.company_size).toBeUndefined();
    // Sí se guarda el mismatch para diagnóstico
    const mm = outcome.draft.custom_fields?.firmographics_mismatch;
    expect(mm).toBeDefined();
    expect(JSON.parse(mm as string)).toEqual({
      vibe_domain: "linq.com",
      lead_domain: "linqcase.com",
    });
    expect(outcome.draft.custom_fields?.firmographics_domain_verified).toBe("false");
    // Sector NO se importa de la empresa equivocada
    expect(outcome.draft.sector).toBeUndefined();
  });

  it("enrich sin website → merge normal pero domainVerified=false (señal débil)", () => {
    const outcome = mergeBusinessFirmographics(baseDraft, {
      // website ausente en el firmographics
      business_description: "Some description",
      number_of_employees_range: "51-200",
      linkedin_industry_category: "furniture manufacturing",
    });
    expect(outcome.mismatch).toBeUndefined();
    expect(outcome.domainVerified).toBe(false);
    expect(outcome.draft.custom_fields?.company_description).toBe("Some description");
    expect(outcome.draft.custom_fields?.firmographics_domain_verified).toBe("false");
  });

  it("lead sin website → domainVerified=false", () => {
    const draftNoWebsite = { ...baseDraft, website: null };
    const outcome = mergeBusinessFirmographics(draftNoWebsite, {
      website: "https://intarcon.com",
      business_description: "text",
    });
    expect(outcome.mismatch).toBeUndefined();
    expect(outcome.domainVerified).toBe(false);
    expect(outcome.draft.custom_fields?.firmographics_domain_verified).toBe("false");
  });

  it("no sobrescribe sector si el lead ya lo tenía", () => {
    const draftWithSector = { ...baseDraft, sector: "prior sector" };
    const outcome = mergeBusinessFirmographics(draftWithSector, {
      website: "https://intarcon.com",
      linkedin_industry_category: "different sector",
    });
    expect(outcome.draft.sector).toBe("prior sector");
  });
});
