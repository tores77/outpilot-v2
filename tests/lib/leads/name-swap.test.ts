import { describe, expect, it } from "vitest";
import { detectNameSwap } from "@/lib/leads/name-swap";

describe("detectNameSwap (T024 guard barato pre-Lemlist, smoke 2026-09-29)", () => {
  describe("caso real Ibarmia", () => {
    it("first_name='Arandia' last_name='Koldo' email='koldo.arandia@…' → suspect (last_precedes_first)", () => {
      // Estado real detectado en BD antes del UPDATE: apellido en
      // el hueco de first_name. Ambos aparecen en el local, pero
      // "koldo" (last) va antes que "arandia" (first) — patrón
      // inequívoco de swap en emails corporate "nombre.apellido".
      const r = detectNameSwap({
        first_name: "Arandia",
        last_name: "Koldo",
        email: "koldo.arandia@ibarmia.com",
      });
      expect(r.suspect).toBe(true);
      expect(r.reason).toBe("last_precedes_first");
    });

    it("post-UPDATE (first='Koldo' last='Arandia' mismo email) → NO suspect", () => {
      // Sanity check: la corrección manual del UPDATE deja el lead
      // limpio para el guard. Si esto fallase, el guard bloquearía
      // el reenvío tras corregir a mano.
      const r = detectNameSwap({
        first_name: "Koldo",
        last_name: "Arandia",
        email: "koldo.arandia@ibarmia.com",
      });
      expect(r.suspect).toBe(false);
    });
  });

  describe("regla R1 (first_absent_last_present)", () => {
    it("firstName ausente del local + lastName presente → suspect", () => {
      // Peor caso: el "first_name" cargado es un apellido que no
      // tiene nada que ver con el email. Aparece last, no aparece
      // first → swap claro.
      const r = detectNameSwap({
        first_name: "Ramirez",
        last_name: "Garcia",
        email: "garcia@empresa.com",
      });
      expect(r.suspect).toBe(true);
      expect(r.reason).toBe("first_absent_last_present");
    });
  });

  describe("caso normal (patrón esperado nombre.apellido)", () => {
    it("first='Ana' last='Perez' email='ana.perez@…' → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "Ana",
        last_name: "Perez",
        email: "ana.perez@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("first='Juan' last='Gomez' email='juan.gomez@…' → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "Juan",
        last_name: "Gomez",
        email: "juan.gomez@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("first='Juan' last='Gomez' email='jgomez@…' (inicial+apellido) → NO suspect", () => {
      // firstName no aparece como palabra completa pero tampoco
      // aparece el last SOLO — este caso es opaco para el guard y
      // se acepta como NO suspect (falso negativo previsto: no es
      // peor que el estado anterior).
      const r = detectNameSwap({
        first_name: "Juan",
        last_name: "Gomez",
        email: "jgomez@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });
  });

  describe("normalización (tildes + case)", () => {
    it("acentos: first='José' last='Martínez' email='jose.martinez@…' → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "José",
        last_name: "Martínez",
        email: "jose.martinez@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("acentos + swap: first='Martínez' last='José' email='jose.martinez@…' → suspect", () => {
      const r = detectNameSwap({
        first_name: "Martínez",
        last_name: "José",
        email: "jose.martinez@empresa.com",
      });
      expect(r.suspect).toBe(true);
      expect(r.reason).toBe("last_precedes_first");
    });

    it("mayúsculas del email: first='Ana' last='Perez' email='ANA.PEREZ@…' → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "Ana",
        last_name: "Perez",
        email: "ANA.PEREZ@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });
  });

  describe("edge cases · datos ausentes o incompletos", () => {
    it("first_name null → NO suspect (defensivo: otro sistema se ocupa)", () => {
      const r = detectNameSwap({
        first_name: null,
        last_name: "Arandia",
        email: "koldo.arandia@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("last_name vacío → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "Koldo",
        last_name: "",
        email: "koldo.arandia@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("email sin @ → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "Koldo",
        last_name: "Arandia",
        email: "koldo.arandia",
      });
      expect(r.suspect).toBe(false);
    });

    it("email null → NO suspect", () => {
      const r = detectNameSwap({
        first_name: "Koldo",
        last_name: "Arandia",
        email: null,
      });
      expect(r.suspect).toBe(false);
    });
  });

  describe("edge cases · nombres cortos (min-length 3)", () => {
    it("first='Al' (2 chars) → NO suspect (min-length evita falsos)", () => {
      // Nombres muy cortos matchean por casualidad en muchos
      // locales ("albert.torres@" contiene "al"). Solo evaluamos
      // ≥3 chars.
      const r = detectNameSwap({
        first_name: "Al",
        last_name: "Torres",
        email: "albert.torres@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });
  });

  describe("edge cases · segundos apellidos", () => {
    it("first='Koldo' last='Arandia' email='koldo.arandia.perez@…' → NO suspect (extensión con 2º apellido)", () => {
      // Formato corporate con dos apellidos. First aparece
      // primero → orden correcto.
      const r = detectNameSwap({
        first_name: "Koldo",
        last_name: "Arandia",
        email: "koldo.arandia.perez@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("first='Arandia' last='Koldo' email='koldo.arandia.perez@…' → suspect (last antes que first)", () => {
      const r = detectNameSwap({
        first_name: "Arandia",
        last_name: "Koldo",
        email: "koldo.arandia.perez@empresa.com",
      });
      expect(r.suspect).toBe(true);
      expect(r.reason).toBe("last_precedes_first");
    });
  });

  describe("edge cases · email sin separadores", () => {
    it("first='Ana' last='Perez' email='anaperez@…' → NO suspect", () => {
      // Ambos aparecen concatenados; first va primero.
      const r = detectNameSwap({
        first_name: "Ana",
        last_name: "Perez",
        email: "anaperez@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });

    it("first='Perez' last='Ana' email='anaperez@…' → suspect (last precede first)", () => {
      const r = detectNameSwap({
        first_name: "Perez",
        last_name: "Ana",
        email: "anaperez@empresa.com",
      });
      expect(r.suspect).toBe(true);
      expect(r.reason).toBe("last_precedes_first");
    });
  });

  describe("edge cases · email opaco (falso negativo aceptado)", () => {
    it("first='Koldo' last='Arandia' email='info@…' → NO suspect", () => {
      // El email no refleja ni nombre ni apellido. El guard no
      // dispara; el opener puede ser subóptimo pero no hay swap
      // detectable. Aceptado: no es peor que el estado anterior.
      const r = detectNameSwap({
        first_name: "Koldo",
        last_name: "Arandia",
        email: "info@empresa.com",
      });
      expect(r.suspect).toBe(false);
    });
  });
});
