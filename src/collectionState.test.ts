import { describe, expect, it } from "vitest";
import {
  cardMetadataChanged,
  compactSourceCards,
  mergeIntoCollection,
  upsertCards
} from "./collectionState";
import type { CardRecord } from "./types";

const card = (id: string, name: string, extra: Partial<CardRecord> = {}): CardRecord => ({
  id, name, set: "tst", collectorNumber: "1", lang: "en", foil: false, count: 1,
  addedAt: 1, updatedAt: 1, manaValue: 1, colors: [], colorIdentity: [], ...extra
});

describe("collection state", () => {
  it("ersetzt und ergänzt Karten sortiert nach Name", () => {
    const next = upsertCards([card("b", "Beta"), card("c", "Gamma")], [card("a", "Alpha"), card("c", "Gamma", { count: 3 })]);
    expect(next.map(item => item.name)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(next.find(item => item.id === "c")?.count).toBe(3);
  });

  it("addiert Non-Foil und Foil getrennt auf den Bestand", () => {
    const existing = card("a", "Alpha", { count: 2, finishCounts: { nonfoil: 2, foil: 0 }, comment: "Ordner 1" });
    const merged = mergeIntoCollection(
      [existing],
      [
        card("a", "Alpha", { count: 1, foil: true, finishCounts: { nonfoil: 0, foil: 1 } }),
        card("a", "Alpha", { count: 2, finishCounts: { nonfoil: 2, foil: 0 } }),
        card("n", "Neu", { count: 4 })
      ],
      99
    );
    const alpha = merged.find(item => item.id === "a");
    expect(alpha?.finishCounts).toEqual({ nonfoil: 4, foil: 1 });
    expect(alpha?.count).toBe(5);
    expect(alpha?.comment).toBe("Ordner 1");
    expect(alpha?.addedAt).toBe(1);
    expect(merged.find(item => item.id === "n")?.count).toBe(4);
  });

  it("erkennt nur echte Metadatenänderungen", () => {
    const before = card("a", "Alpha", { priceEur: 1, finishCounts: { nonfoil: 1, foil: 0 }, availableFinishes: ["nonfoil"] });
    expect(cardMetadataChanged(before, { ...before, priceUpdatedAt: 5 })).toBe(false);
    expect(cardMetadataChanged(before, { ...before, priceEur: 2 })).toBe(true);
  });

  it("verkleinert sourceCards für Deck-Dokumente", () => {
    const [compact] = compactSourceCards([
      card("a", "Alpha", { comment: "privat", legalities: { commander: "legal", modern: "legal" } })
    ]) ?? [];
    expect(compact.comment).toBeUndefined();
    expect(compact.legalities).toEqual({ commander: "legal" });
  });
});
