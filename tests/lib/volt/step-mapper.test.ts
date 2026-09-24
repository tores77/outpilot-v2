import { describe, expect, it } from "vitest";
import {
  composeAddStepBody,
  describeStep,
  stepMatches,
} from "@/lib/volt/step-mapper";

describe("composeAddStepBody", () => {
  it("step 1 con subject: incluye la clave subject", () => {
    const body = composeAddStepBody({
      subject: "{{firstName}}, una observación sobre {{companyName}}",
      bodyHtml: "<p>Hola {{firstName}}</p>",
      delayDays: 0,
    });
    expect(body).toEqual({
      type: "email",
      subject: "{{firstName}}, una observación sobre {{companyName}}",
      message: "<p>Hola {{firstName}}</p>",
      delay: 0,
    });
    // Assert explícito: la clave subject está presente.
    expect("subject" in body).toBe(true);
  });

  it("step follow-up sin subject (undefined): OMITE la clave subject", () => {
    const body = composeAddStepBody({
      bodyHtml: "<p>{{firstName}}, sigo el hilo.</p>",
      delayDays: 4,
    });
    expect(body).toEqual({
      type: "email",
      message: "<p>{{firstName}}, sigo el hilo.</p>",
      delay: 4,
    });
    // Assert crítico para el reply-thread: enviar "" NO dispara el
    // comportamiento; hay que OMITIR la clave.
    expect("subject" in body).toBe(false);
  });

  it('step con subject "" (empty): también omite la clave (defensivo)', () => {
    const body = composeAddStepBody({
      subject: "",
      bodyHtml: "<p>x</p>",
      delayDays: 1,
    });
    expect("subject" in body).toBe(false);
  });

  it("step con subject whitespace-only: omite la clave (trim)", () => {
    const body = composeAddStepBody({
      subject: "   ",
      bodyHtml: "<p>x</p>",
      delayDays: 1,
    });
    expect("subject" in body).toBe(false);
  });

  it("trim del subject: no se envía con whitespace circundante", () => {
    const body = composeAddStepBody({
      subject: "  hola  ",
      bodyHtml: "<p>x</p>",
      delayDays: 0,
    });
    expect(body.subject).toBe("hola");
  });
});

describe("stepMatches", () => {
  const expected = {
    subject: "Hola {{firstName}}",
    bodyHtml: "<p>Hola {{firstName}}, este es un email de prueba.</p>",
    delayDays: 0,
  };

  it("ambos con subject: match si iguales", () => {
    expect(
      stepMatches(
        { _id: "stp_x", subject: "Hola {{firstName}}", message: "cualquier msg" },
        expected,
      ),
    ).toBe(true);
  });

  it("ambos con subject distinto: divergent", () => {
    expect(
      stepMatches(
        { _id: "stp_x", subject: "Otra cosa", message: expected.bodyHtml },
        expected,
      ),
    ).toBe(false);
  });

  it("ambos SIN subject (reply-thread): match si message[:80] iguales", () => {
    const followUp = {
      bodyHtml: "<p>{{firstName}}, una matemática rápida sobre vuestra web.</p>",
      delayDays: 4,
    };
    // Lemlist devuelve `message` (nuestro `bodyHtml`).
    expect(
      stepMatches(
        {
          _id: "stp_x",
          message:
            "<p>{{firstName}}, una matemática rápida sobre vuestra web.</p>",
        },
        followUp,
      ),
    ).toBe(true);
  });

  it("ambos SIN subject pero message distinto en los primeros 80 chars: divergent", () => {
    const followUp = {
      bodyHtml: "<p>Un follow-up completamente distinto.</p>",
      delayDays: 4,
    };
    expect(
      stepMatches(
        { _id: "stp_x", message: "<p>Este es otro follow-up totalmente diferente.</p>" },
        followUp,
      ),
    ).toBe(false);
  });

  it("actual con subject, expected sin: divergent (uno u otro, pero no mezclar)", () => {
    expect(
      stepMatches(
        { _id: "stp_x", subject: "algo", message: "x" },
        { bodyHtml: "x", delayDays: 0 },
      ),
    ).toBe(false);
  });

  it("actual sin subject, expected con: divergent", () => {
    expect(
      stepMatches(
        { _id: "stp_x", message: "x" },
        { subject: "algo", bodyHtml: "x", delayDays: 0 },
      ),
    ).toBe(false);
  });

  it("subject con whitespace: se trimea antes de comparar", () => {
    expect(
      stepMatches(
        { _id: "stp_x", subject: "  hola  ", message: "x" },
        { subject: "hola", bodyHtml: "x", delayDays: 0 },
      ),
    ).toBe(true);
  });

  it("actual sin campo subject definido (undefined): equivalente a vacío", () => {
    // Cuando Lemlist responde sin la clave `subject` en un step
    // follow-up, el shape puede llegar como { _id, message, ... } sin
    // subject. Se debe tratar como reply-thread.
    expect(
      stepMatches(
        { _id: "stp_x", message: "<p>reply text follows up here nicely.</p>" },
        { bodyHtml: "<p>reply text follows up here nicely.</p>", delayDays: 4 },
      ),
    ).toBe(true);
  });
});

describe("describeStep", () => {
  it("acorta el message a 80 chars", () => {
    const longMsg = "<p>" + "x".repeat(200) + "</p>";
    const s = describeStep({ subject: "hola", message: longMsg });
    // El slice(0, 80) del msg completo.
    expect(s).toContain('subject="hola"');
    expect(s).toContain('msg[:80]=');
    // El string después de msg[:80]= debe medir 80 chars (más las
    // comillas envolventes que añade el helper).
    const match = s.match(/msg\[:80\]="([^"]*)"/);
    expect(match?.[1].length).toBe(80);
  });

  it("subject vacío se representa como \"\"", () => {
    const s = describeStep({ message: "reply msg" });
    expect(s).toContain('subject=""');
  });

  it("acepta bodyHtml (para expected) o message (para actual)", () => {
    const a = describeStep({ subject: "s", message: "actual msg" });
    const b = describeStep({ subject: "s", bodyHtml: "expected msg" });
    expect(a).toContain("actual msg");
    expect(b).toContain("expected msg");
  });
});
