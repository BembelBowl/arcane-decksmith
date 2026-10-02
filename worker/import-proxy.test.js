import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./import-proxy.js";

const call = (path, init = {}, env = {}) =>
  worker.fetch(new Request(`https://proxy.test/${path}`, init), env);

function mockFetch(handler) {
  const mock = vi.fn(async (input) => handler(String(input)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });

describe("Import-Proxy (Cloudflare Worker)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("liest ein Archidekt-Deck und liefert Zeilen mit Set, Nummer und Foil", async () => {
    mockFetch(url => {
      expect(url).toBe("https://archidekt.com/api/decks/123/");
      return json({
        name: "Testdeck",
        deckFormat: 3,
        cards: [
          { quantity: 2, modifier: "Foil", categories: ["Commander"], card: { oracleCard: { name: "Sol Ring" }, edition: { editioncode: "cmm" }, collectorNumber: "396" } },
          { quantity: 1, categories: ["Sideboard"], card: { oracleCard: { name: "Counterspell" } } }
        ]
      });
    });

    const response = await call("?url=" + encodeURIComponent("https://archidekt.com/decks/123/x"));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const data = await response.json();
    expect(data.provider).toBe("Archidekt");
    expect(data.deckName).toBe("Testdeck");
    expect(data.format).toBe("commander");
    expect(data.rows).toEqual([
      { count: 2, name: "Sol Ring", edition: "cmm", collectorNumber: "396", foil: true, section: "commander" },
      { count: 1, name: "Counterspell", foil: false, section: "sideboard" }
    ]);
  });

  it("liest ein Moxfield-Deck", async () => {
    mockFetch(() => json({
      name: "Mox",
      commanders: { a: { quantity: 1, card: { name: "Atraxa", set: "2x2", cn: "190" } } },
      mainboard: { b: { quantity: 3, finish: "foil", card: { name: "Island", set: "neo", cn: "293" } } }
    }));
    const data = await (await call("?url=" + encodeURIComponent("https://www.moxfield.com/decks/abc"))).json();
    expect(data.rows).toHaveLength(2);
    expect(data.rows[1]).toMatchObject({ count: 3, name: "Island", foil: true, section: "main" });
  });

  it("lehnt andere Anbieter, HTTP und fehlende URLs ab", async () => {
    const other = await call("?url=" + encodeURIComponent("https://example.com/deck"));
    expect(other.status).toBe(400);
    expect((await other.json()).error).toMatch(/nicht unterstützt/);

    const http = await call("?url=" + encodeURIComponent("http://archidekt.com/decks/1"));
    expect(http.status).toBe(400);

    expect((await call("")).status).toBe(400);
    expect((await call("?url=kaputt")).status).toBe(400);
  });

  it("blockiert Weiterleitungen auf nicht erlaubte Hosts", async () => {
    const mock = mockFetch(url =>
      url.startsWith("https://archidekt.com")
        ? new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } })
        : json({})
    );
    const response = await call("?url=" + encodeURIComponent("https://archidekt.com/decks/9"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/nicht erlaubten Host/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("bricht zu große Antworten ab", async () => {
    mockFetch(() => new Response("x".repeat(6 * 1024 * 1024), { status: 200 }));
    const response = await call("?url=" + encodeURIComponent("https://archidekt.com/decks/9"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/zu groß/);
  });

  it("meldet Fehler des Anbieters mit Hinweis statt abzustürzen", async () => {
    mockFetch(() => new Response("blocked", { status: 403 }));
    const response = await call("?url=" + encodeURIComponent("https://www.moxfield.com/decks/abc"));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/CSV\/TXT/);
  });

  it("erlaubt nur konfigurierte Webseiten (CORS)", async () => {
    mockFetch(() => json({ name: "x", cards: [{ quantity: 1, card: { oracleCard: { name: "Sol Ring" } } }] }));
    const env = { ALLOWED_ORIGINS: "https://bembelbowl.github.io/" };
    const url = "?url=" + encodeURIComponent("https://archidekt.com/decks/1");

    const ok = await call(url, { headers: { Origin: "https://bembelbowl.github.io" } }, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://bembelbowl.github.io");

    const denied = await call(url, { headers: { Origin: "https://evil.example" } }, env);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    // Direktaufruf ohne Origin (Test in der Adresszeile) bleibt möglich.
    expect((await call(url, {}, env)).status).toBe(200);

    const preflight = await call("", { method: "OPTIONS", headers: { Origin: "https://bembelbowl.github.io" } }, env);
    expect(preflight.status).toBe(204);
  });

  it("akzeptiert nur GET", async () => {
    expect((await call("?url=x", { method: "POST" })).status).toBe(405);
  });
});
