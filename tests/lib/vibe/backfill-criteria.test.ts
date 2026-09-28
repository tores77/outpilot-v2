import { describe, expect, it } from "vitest";
import {
  classifyBackfillEligibility,
  isEligibleForFirmographicsBackfill,
} from "@/lib/vibe/backfill-criteria";

describe("classifyBackfillEligibility (T024 fix re-run)", () => {
  it("lead completo (sector + vibe_website) → null (no seleccionado)", () => {
    expect(
      classifyBackfillEligibility({
        sector: "industrial machinery manufacturing",
        custom_fields: {
          firmographics_vibe_website: "https://intarcon.com",
        },
      }),
    ).toBeNull();
  });

  it("REGRESIÓN 2026-09-28: lead con sector pero SIN firmographics_vibe_website → seleccionado", () => {
    // Este es el caso real del re-run fallido: los 114 leads tenían
    // sector rellenado por el backfill previo pero NO tenían
    // firmographics_vibe_website persistido (lección T024
    // §Integraciones aplicada después). El SELECT antiguo (sector
    // IS NULL) los descartaba a todos.
    expect(
      classifyBackfillEligibility({
        sector: "industrial machinery manufacturing",
        custom_fields: { prospect_id: "abc" },
      }),
    ).toBe("vibe_website_missing");
    expect(
      isEligibleForFirmographicsBackfill({
        sector: "industrial machinery manufacturing",
        custom_fields: { prospect_id: "abc" },
      }),
    ).toBe(true);
  });

  it("lead sin sector pero con vibe_website → sector_missing", () => {
    expect(
      classifyBackfillEligibility({
        sector: null,
        custom_fields: {
          firmographics_vibe_website: "https://intarcon.com",
        },
      }),
    ).toBe("sector_missing");
  });

  it("lead sin sector NI vibe_website → both", () => {
    expect(
      classifyBackfillEligibility({
        sector: null,
        custom_fields: null,
      }),
    ).toBe("both");
  });

  it("sector empty string (trim) equivale a NULL", () => {
    expect(
      classifyBackfillEligibility({
        sector: "   ",
        custom_fields: {
          firmographics_vibe_website: "https://intarcon.com",
        },
      }),
    ).toBe("sector_missing");
  });

  it("firmographics_vibe_website empty string equivale a NULL", () => {
    expect(
      classifyBackfillEligibility({
        sector: "x",
        custom_fields: { firmographics_vibe_website: "   " },
      }),
    ).toBe("vibe_website_missing");
  });

  it("custom_fields undefined → vibe_website_missing (sector presente)", () => {
    expect(
      classifyBackfillEligibility({
        sector: "x",
        custom_fields: undefined,
      }),
    ).toBe("vibe_website_missing");
  });
});
