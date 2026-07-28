import { describe, expect, it } from "vitest";
import {
  cleanupLeadBatch,
  isGenericEmail,
  normaliseCompanyKey,
  normaliseText,
  titleRank,
  type LeadDraft,
} from "@/lib/nova/cleanup";

describe("normaliseText", () => {
  it("strips accents, lowercases and collapses whitespace", () => {
    expect(normaliseText("Ácme S.L.")).toBe("acme s.l.");
    expect(normaliseText("  DELTA   Producción  ")).toBe("delta produccion");
    expect(normaliseText("España")).toBe("espana");
  });
});

describe("normaliseCompanyKey", () => {
  it("collapses legal-form variants of the same company", () => {
    const a = normaliseCompanyKey("Acme S.L.");
    const b = normaliseCompanyKey("Ácme S.L");
    const c = normaliseCompanyKey("Acme SL");
    const d = normaliseCompanyKey("ACME Inc");
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toBe(d);
    expect(a).toBe("acme");
  });

  it("returns null for empty / whitespace input", () => {
    expect(normaliseCompanyKey(null)).toBeNull();
    expect(normaliseCompanyKey(undefined)).toBeNull();
    expect(normaliseCompanyKey("   ")).toBeNull();
  });
});

describe("isGenericEmail", () => {
  it("flags common generic prefixes", () => {
    expect(isGenericEmail("info@company.com")).toBe(true);
    expect(isGenericEmail("hello@company.com")).toBe(true);
    expect(isGenericEmail("sales@company.com")).toBe(true);
    expect(isGenericEmail("no-reply@company.com")).toBe(true);
  });

  it("splits on dot/hyphen/underscore to catch composite generics", () => {
    expect(isGenericEmail("sales-eu@company.com")).toBe(true);
    expect(isGenericEmail("info.spain@company.com")).toBe(true);
  });

  it("does not flag personal-looking addresses", () => {
    expect(isGenericEmail("ana.garcia@company.com")).toBe(false);
    expect(isGenericEmail("federico@company.com")).toBe(false);
    expect(isGenericEmail("j.pere@company.com")).toBe(false);
  });
});

describe("titleRank", () => {
  it("ranks top decision-makers as 1-2", () => {
    expect(titleRank("CEO")).toBe(1);
    expect(titleRank("Founder & CEO")).toBe(1);
    expect(titleRank("Chief Executive Officer")).toBe(1);
    expect(titleRank("Owner")).toBe(1);
    expect(titleRank("CTO")).toBe(2);
  });

  it("ranks middle-management progressively higher (bigger number)", () => {
    expect(titleRank("VP Product")).toBe(3);
    expect(titleRank("Director de Marketing")).toBe(4);
    expect(titleRank("Head of Growth")).toBe(5);
    expect(titleRank("Marketing Manager")).toBe(6);
    expect(titleRank("Team Lead")).toBe(7);
    expect(titleRank("Senior Analyst")).toBe(8);
  });

  it("defaults to 100 when no pattern matches", () => {
    expect(titleRank("Software Engineer")).toBe(100);
    expect(titleRank("Junior Analyst")).toBe(100);
    expect(titleRank(null)).toBe(100);
    expect(titleRank(undefined)).toBe(100);
  });
});

describe("cleanupLeadBatch — dedupe by company with rank tiebreak", () => {
  it("keeps the CEO over the Manager over the generic email", () => {
    const rows: LeadDraft[] = [
      { email: "ana@acme.io", company: "Acme S.L.", title: "CEO" },
      {
        email: "luis@acme.io",
        company: "Ácme S.L",
        title: "Marketing Manager",
      },
      { email: "info@acme.io", company: "Acme SL", title: "Sales Director" },
    ];
    const { clean, dropped, stats } = cleanupLeadBatch(rows);
    expect(clean).toHaveLength(1);
    expect(clean[0].email).toBe("ana@acme.io");
    expect(dropped).toHaveLength(2);
    expect(new Set(dropped.map((d) => d.row.email))).toEqual(
      new Set(["luis@acme.io", "info@acme.io"]),
    );
    expect(stats.dropped_dedupe).toBe(2);
    expect(stats.kept).toBe(1);
  });

  it("marks generic emails as needs_review when kept", () => {
    const rows: LeadDraft[] = [
      { email: "contacto@epsilon.example", company: "Epsilon" },
    ];
    const { clean, stats } = cleanupLeadBatch(rows);
    expect(clean[0].needs_review).toBe(true);
    expect(stats.marked_review).toBe(1);
  });

  it("handles LeadDraft without email (Vibe pre-enrich flow)", () => {
    const rows: LeadDraft[] = [
      { company: "Product Hackers", title: "CMO & Partner" },
      { company: "Acme S.L.", title: "CEO" },
    ];
    const { clean, stats } = cleanupLeadBatch(rows);
    expect(clean).toHaveLength(2);
    expect(stats.marked_review).toBe(0);
    for (const row of clean) expect(row.needs_review).toBe(false);
  });

  it("does not dedupe rows without a company (orphans all survive)", () => {
    const rows: LeadDraft[] = [
      { email: "a@example.com", title: "CEO" },
      { email: "b@example.com", title: "Manager" },
    ];
    const { clean, stats } = cleanupLeadBatch(rows);
    expect(clean).toHaveLength(2);
    expect(stats.dropped_dedupe).toBe(0);
  });
});
