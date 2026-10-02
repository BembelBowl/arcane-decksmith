import { describe, expect, it } from "vitest";
import {
  collectorNumberVariants,
  decidePrinting,
  normalizeCollectorNumber,
  type MatchableCard
} from "./printingMatch";

const card = (id: string, name: string, set: string, cn: string, extra: Partial<MatchableCard> = {}): MatchableCard =>
  ({ id, name, set, collector_number: cn, lang: "en", released_at: "2021-11-19", ...extra });

const catgeist = card("a69", "A-Mischievous Catgeist // A-Catlike Curiosity", "vow", "A-69");
const catgeistOriginal = card("n69", "Mischievous Catgeist // Catlike Curiosity", "vow", "69");

describe("printing match", () => {
  it("normalisiert Collector Numbers symmetrisch", () => {
    expect(normalizeCollectorNumber("A-69")).toBe(normalizeCollectorNumber("a69"));
    expect(normalizeCollectorNumber("069")).toBe("69");
    expect(normalizeCollectorNumber("100")).toBe("100");
    expect(normalizeCollectorNumber("0")).toBe("0");
    expect(normalizeCollectorNumber("123★")).toBe("123");
    expect(collectorNumberVariants("A69")).toEqual(expect.arrayContaining(["A69", "A-69"]));
    expect(collectorNumberVariants("007")).toEqual(expect.arrayContaining(["007", "7"]));
  });

  it("Set + Collector Number sind autoritativ, der Name überschreibt sie nicht", () => {
    const decision = decidePrinting("Mischievous Catgeist", { exactRaw: [catgeist] }, "collection");
    expect(decision).toEqual({ status: "resolved", card: catgeist });
  });

  it("A-69 wechselt nie auf die nicht rebalancierte Fassung", () => {
    const name = "A-Mischievous Catgeist // A-Catlike Curiosity";
    // Name-Stufe enthält beide Karten (z. B. über Seitennamen) – nur die A-Karte passt.
    const decision = decidePrinting(name, { name: [catgeistOriginal, catgeist] }, "collection");
    expect(decision).toEqual({ status: "resolved", card: catgeist });
    // Normalisierte Nummer "A69" findet die A-Karte, nicht #69.
    const normalized = decidePrinting(name, { exactRaw: [], exactNormalized: [catgeist] }, "collection");
    expect(normalized).toEqual({ status: "resolved", card: catgeist });
  });

  it("markiert mehrere Druckversionen im Sammlungsimport als mehrdeutig", () => {
    const a = card("1", "Island", "neo", "293");
    const b = card("2", "Island", "neo", "294");
    expect(decidePrinting("Island", { setName: [a, b] }, "collection").status).toBe("ambiguous");
  });

  it("wählt im Deckimport deterministisch, unabhängig von der Reihenfolge", () => {
    const a = card("1", "Sol Ring", "cmm", "396", { released_at: "2023-08-04" });
    const b = card("2", "Sol Ring", "c21", "263", { released_at: "2021-04-23" });
    const first = decidePrinting("Sol Ring", { name: [a, b] }, "deck");
    const second = decidePrinting("Sol Ring", { name: [b, a] }, "deck");
    expect(first).toEqual(second);
    expect(first).toEqual({ status: "resolved", card: a });
  });

  it("übernimmt einen setübergreifenden Fallback nur bei genau einem Treffer", () => {
    const only = card("1", "Sol Ring", "cmm", "396");
    expect(decidePrinting("Sol Ring", { exactRaw: [], nameCollector: [only] }, "collection"))
      .toEqual({ status: "resolved", card: only });
    const other = card("2", "Sol Ring", "xyz", "396");
    expect(decidePrinting("Sol Ring", { nameCollector: [only, other] }, "collection").status).toBe("ambiguous");
  });

  it("verwirft namensbasierte Kandidaten mit falschem Namen", () => {
    expect(decidePrinting("Sol Ring", { name: [card("1", "Sol Talisman", "x", "1")] }, "collection").status)
      .toBe("not_found");
  });
});
