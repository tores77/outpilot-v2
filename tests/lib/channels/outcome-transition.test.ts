import { describe, expect, it } from "vitest";
import { nextOutcome } from "@/lib/channels/outcome-transition";

describe("nextOutcome (T025 bloque B)", () => {
  describe("primer evento (current=null)", () => {
    it("null + sent → sent", () => {
      expect(nextOutcome(null, "sent")).toBe("sent");
    });
    it("null + bounced → bounced", () => {
      expect(nextOutcome(null, "bounced")).toBe("bounced");
    });
    it("null + unsubscribed → unsubscribed", () => {
      expect(nextOutcome(null, "unsubscribed")).toBe("unsubscribed");
    });
  });

  describe("progresión de rank (monotónica, nunca degrada)", () => {
    it("sent + bounced → bounced (rank 1 → 2)", () => {
      expect(nextOutcome("sent", "bounced")).toBe("bounced");
    });
    it("sent + replied → replied", () => {
      expect(nextOutcome("sent", "replied")).toBe("replied");
    });
    it("sent + interested → interested (rank 1 → 3)", () => {
      expect(nextOutcome("sent", "interested")).toBe("interested");
    });
    it("replied + interested → interested (rank 2 → 3)", () => {
      expect(nextOutcome("replied", "interested")).toBe("interested");
    });
    it("replied + not_interested → not_interested", () => {
      expect(nextOutcome("replied", "not_interested")).toBe("not_interested");
    });
  });

  describe("no degrada (incoming < current)", () => {
    it("replied + sent → null (no toca)", () => {
      expect(nextOutcome("replied", "sent")).toBeNull();
    });
    it("interested + sent → null", () => {
      expect(nextOutcome("interested", "sent")).toBeNull();
    });
    it("interested + replied → null", () => {
      expect(nextOutcome("interested", "replied")).toBeNull();
    });
    it("bounced + sent → null", () => {
      expect(nextOutcome("bounced", "sent")).toBeNull();
    });
  });

  describe("desempate dentro de rank 2", () => {
    it("bounced + replied → replied (una respuesta vale más que un bounce previo)", () => {
      expect(nextOutcome("bounced", "replied")).toBe("replied");
    });
    it("replied + bounced → null (una vez respondió, no bajamos a bounced)", () => {
      expect(nextOutcome("replied", "bounced")).toBeNull();
    });
  });

  describe("unsubscribed terminal especial", () => {
    it("sent + unsubscribed → unsubscribed", () => {
      expect(nextOutcome("sent", "unsubscribed")).toBe("unsubscribed");
    });
    it("replied + unsubscribed → unsubscribed", () => {
      expect(nextOutcome("replied", "unsubscribed")).toBe("unsubscribed");
    });
    it("interested + unsubscribed → unsubscribed", () => {
      expect(nextOutcome("interested", "unsubscribed")).toBe("unsubscribed");
    });
    it("unsubscribed + sent → null (terminal: no se mueve)", () => {
      expect(nextOutcome("unsubscribed", "sent")).toBeNull();
    });
    it("unsubscribed + replied → null (reply tardío NO reactiva)", () => {
      expect(nextOutcome("unsubscribed", "replied")).toBeNull();
    });
    it("unsubscribed + interested → null (coherencia terminal)", () => {
      expect(nextOutcome("unsubscribed", "interested")).toBeNull();
    });
  });

  describe("idempotencia (mismo evento dos veces)", () => {
    it("sent + sent → null (no cambia)", () => {
      expect(nextOutcome("sent", "sent")).toBeNull();
    });
    it("replied + replied → null", () => {
      expect(nextOutcome("replied", "replied")).toBeNull();
    });
    it("interested + interested → null", () => {
      expect(nextOutcome("interested", "interested")).toBeNull();
    });
    it("unsubscribed + unsubscribed → null", () => {
      expect(nextOutcome("unsubscribed", "unsubscribed")).toBeNull();
    });
  });
});
