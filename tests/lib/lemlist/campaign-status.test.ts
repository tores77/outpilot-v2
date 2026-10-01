import { describe, expect, it } from "vitest";
import {
  mapLemlistCampaignStatus,
  detectInternalStatusDrift,
} from "@/lib/lemlist/campaign-status";

describe("mapLemlistCampaignStatus (T025 bloque D)", () => {
  it("running → active", () => {
    expect(mapLemlistCampaignStatus("running")).toBe("active");
  });

  it("started → active (observed en probe T018)", () => {
    expect(mapLemlistCampaignStatus("started")).toBe("active");
  });

  it("active → active", () => {
    expect(mapLemlistCampaignStatus("active")).toBe("active");
  });

  it("paused → paused", () => {
    expect(mapLemlistCampaignStatus("paused")).toBe("paused");
  });

  it("stopped → paused (sinónimo documentado)", () => {
    expect(mapLemlistCampaignStatus("stopped")).toBe("paused");
  });

  it("ended → done", () => {
    expect(mapLemlistCampaignStatus("ended")).toBe("done");
  });

  it("finished / archived → done (documentados, no verificados)", () => {
    expect(mapLemlistCampaignStatus("finished")).toBe("done");
    expect(mapLemlistCampaignStatus("archived")).toBe("done");
  });

  it("case-insensitive + trim defensivo", () => {
    expect(mapLemlistCampaignStatus("  RUNNING  ")).toBe("active");
    expect(mapLemlistCampaignStatus("Paused")).toBe("paused");
  });

  it("null / undefined / '' → null", () => {
    expect(mapLemlistCampaignStatus(null)).toBeNull();
    expect(mapLemlistCampaignStatus(undefined)).toBeNull();
    expect(mapLemlistCampaignStatus("")).toBeNull();
  });

  it("estado desconocido → null (no mapea, el caller refleja raw)", () => {
    expect(mapLemlistCampaignStatus("warming_up")).toBeNull();
    expect(mapLemlistCampaignStatus("foo_bar")).toBeNull();
  });
});

describe("detectInternalStatusDrift (T025 bloque D)", () => {
  describe("caso real smoke_test vs running (Pere 2026-10-01)", () => {
    it("internal=smoke_test + provider=running → lemlist_ahead_of_internal", () => {
      const r = detectInternalStatusDrift("smoke_test", "running");
      expect(r.drift).toBe(true);
      expect(r.mapped).toBe("active");
      expect(r.kind).toBe("lemlist_ahead_of_internal");
    });
  });

  describe("sin drift", () => {
    it("internal=active + provider=running → no drift", () => {
      const r = detectInternalStatusDrift("active", "running");
      expect(r.drift).toBe(false);
      expect(r.kind).toBe("none");
    });

    it("internal=paused + provider=paused → no drift", () => {
      const r = detectInternalStatusDrift("paused", "paused");
      expect(r.drift).toBe(false);
    });

    it("internal=done + provider=ended → no drift", () => {
      const r = detectInternalStatusDrift("done", "ended");
      expect(r.drift).toBe(false);
    });

    it("internal=draft + provider=null → no drift (no sync aún)", () => {
      const r = detectInternalStatusDrift("draft", null);
      expect(r.drift).toBe(false);
      expect(r.kind).toBe("none");
    });
  });

  describe("transiciones externas", () => {
    it("internal=active + provider=paused → paused_externally", () => {
      const r = detectInternalStatusDrift("active", "paused");
      expect(r.drift).toBe(true);
      expect(r.kind).toBe("paused_externally");
    });

    it("internal=paused + provider=running → resumed_externally", () => {
      const r = detectInternalStatusDrift("paused", "running");
      expect(r.drift).toBe(true);
      expect(r.kind).toBe("resumed_externally");
    });

    it("internal=active + provider=ended → ended_externally", () => {
      const r = detectInternalStatusDrift("active", "ended");
      expect(r.drift).toBe(true);
      expect(r.kind).toBe("ended_externally");
    });

    it("internal=draft + provider=ended → lemlist_ahead_of_internal (prioridad)", () => {
      // Si internal es draft/smoke_test y Lemlist dice done, el
      // mensaje más informativo es "Lemlist iba por delante", no
      // "campaña terminó" (que suena a final feliz). La clasificación
      // elige la que mejor describe la sorpresa.
      const r = detectInternalStatusDrift("draft", "ended");
      expect(r.drift).toBe(true);
      expect(r.kind).toBe("lemlist_ahead_of_internal");
    });
  });

  describe("provider status desconocido (unmapped)", () => {
    it("provider devuelve 'warming_up' → drift unmapped (reflejamos raw, no transicionamos)", () => {
      const r = detectInternalStatusDrift("active", "warming_up");
      expect(r.drift).toBe(true);
      expect(r.mapped).toBeNull();
      expect(r.kind).toBe("unmapped");
    });

    it("provider devuelve '' (vacío) → no drift unmapped (equivale a no respuesta)", () => {
      const r = detectInternalStatusDrift("active", "");
      expect(r.drift).toBe(false);
      expect(r.kind).toBe("none");
    });
  });
});
