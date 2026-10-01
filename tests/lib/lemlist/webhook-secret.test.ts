import { describe, expect, it } from "vitest";
import {
  checkBodySecret,
  parseBodySecretMode,
} from "@/lib/lemlist/webhook-secret";

describe("parseBodySecretMode (T025 — toggle observe/enforce)", () => {
  it("undefined → observe (default)", () => {
    expect(parseBodySecretMode(undefined)).toBe("observe");
  });

  it("'observe' → observe", () => {
    expect(parseBodySecretMode("observe")).toBe("observe");
  });

  it("'enforce' → enforce", () => {
    expect(parseBodySecretMode("enforce")).toBe("enforce");
  });

  it("string vacía → observe (nunca accidentalmente enforce)", () => {
    expect(parseBodySecretMode("")).toBe("observe");
  });

  it("typo 'ENFORCE' (mayúsculas) → observe (match exacto)", () => {
    // Decisión: solo "enforce" exacto activa el modo estricto. Un
    // typo o case-sensitive no debe endurecer accidentalmente;
    // debe quedar en observe hasta que el operador lo escriba bien.
    expect(parseBodySecretMode("ENFORCE")).toBe("observe");
  });

  it("valor arbitrario → observe", () => {
    expect(parseBodySecretMode("audit")).toBe("observe");
  });
});

describe("checkBodySecret (T025 — comparación en tiempo constante)", () => {
  it("match exacto → ok", () => {
    const r = checkBodySecret("abc123", "abc123");
    expect(r.ok).toBe(true);
  });

  it("provided null → body_secret_missing", () => {
    const r = checkBodySecret(null, "abc123");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("body_secret_missing");
  });

  it("provided string vacía → body_secret_missing", () => {
    const r = checkBodySecret("", "abc123");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("body_secret_missing");
  });

  it("longitudes distintas → body_secret_mismatch (no RangeError)", () => {
    // timingSafeEqual lanza RangeError si los buffers tienen tamaños
    // distintos. El guard evita ese crash y devuelve mismatch.
    const r = checkBodySecret("short", "much-longer-secret");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("body_secret_mismatch");
  });

  it("misma longitud distinto valor → body_secret_mismatch", () => {
    const r = checkBodySecret("aaaaaa", "bbbbbb");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("body_secret_mismatch");
  });

  it("case-sensitive: 'ABC' != 'abc' → mismatch", () => {
    const r = checkBodySecret("ABC", "abc");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("body_secret_mismatch");
  });

  it("secret hex típico (openssl rand -hex 32) → ok si coincide", () => {
    const hex = "a".repeat(64);
    expect(checkBodySecret(hex, hex).ok).toBe(true);
    const other = "b".repeat(64);
    const r = checkBodySecret(hex, other);
    expect(r.ok).toBe(false);
  });
});
