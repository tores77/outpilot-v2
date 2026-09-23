import { describe, expect, it } from "vitest";
import { extractSummary, hasBlanketDisallow } from "@/lib/lex/website";

describe("extractSummary", () => {
  it("extrae title + description + body y los concatena", () => {
    const html = `
      <html>
        <head>
          <title>Acme Industrial</title>
          <meta name="description" content="Fabricantes de válvulas premium.">
        </head>
        <body>
          <script>window.foo = 1;</script>
          <style>.x { color: red; }</style>
          <h1>Bienvenidos</h1>
          <p>Somos una fábrica de Valencia con 40 años de historia.</p>
        </body>
      </html>
    `;
    const s = extractSummary(html);
    expect(s).toContain("Title: Acme Industrial");
    expect(s).toContain("Description: Fabricantes de válvulas premium.");
    expect(s).toContain("Body:");
    expect(s).toContain("Bienvenidos");
    expect(s).toContain("Valencia");
    // scripts/styles fuera
    expect(s).not.toContain("window.foo");
    expect(s).not.toContain("color: red");
  });

  it("recorta a maxChars con ellipsis", () => {
    const long = "<title>t</title><body>" + "x".repeat(3000) + "</body>";
    const s = extractSummary(long, 200);
    expect(s.length).toBeLessThanOrEqual(200);
    expect(s.endsWith("…")).toBe(true);
  });

  it("funciona sin title ni meta description", () => {
    const html = "<body><p>Solo cuerpo.</p></body>";
    const s = extractSummary(html);
    expect(s).toContain("Body: Solo cuerpo.");
    expect(s).not.toContain("Title:");
    expect(s).not.toContain("Description:");
  });

  it("decodifica entidades básicas", () => {
    const html =
      "<title>Foo &amp; Bar</title><body>Hola&nbsp;mundo &lt;3</body>";
    const s = extractSummary(html);
    expect(s).toContain("Foo & Bar");
    expect(s).toContain("Hola mundo <3");
  });
});

describe("hasBlanketDisallow (robots.txt parser mínimo)", () => {
  it("false para robots.txt vacío", () => {
    expect(hasBlanketDisallow("")).toBe(false);
  });

  it("false si solo hay User-agent: * sin Disallow", () => {
    expect(hasBlanketDisallow("User-agent: *\nAllow: /")).toBe(false);
  });

  it("true si User-agent: * y Disallow: /", () => {
    expect(hasBlanketDisallow("User-agent: *\nDisallow: /")).toBe(true);
  });

  it("true si Disallow: * bajo User-agent: *", () => {
    expect(hasBlanketDisallow("User-agent: *\nDisallow: *")).toBe(true);
  });

  it("respeta bloques por User-agent — otro bot bloqueado no nos afecta", () => {
    const body = [
      "User-agent: BadBot",
      "Disallow: /",
      "",
      "User-agent: *",
      "Allow: /",
    ].join("\n");
    expect(hasBlanketDisallow(body)).toBe(false);
  });

  it("detecta bloqueo específico a Outpilot/Umania", () => {
    const body = [
      "User-agent: Umania-Labs-Outpilot",
      "Disallow: /",
    ].join("\n");
    expect(hasBlanketDisallow(body)).toBe(true);
  });

  it("ignora comentarios con #", () => {
    const body = [
      "# comentario",
      "User-agent: * # esto también es comentario",
      "Disallow: /",
    ].join("\n");
    expect(hasBlanketDisallow(body)).toBe(true);
  });

  it("Disallow parcial (path específico distinto de /) NO cuenta como blanket", () => {
    const body = ["User-agent: *", "Disallow: /admin"].join("\n");
    expect(hasBlanketDisallow(body)).toBe(false);
  });
});
