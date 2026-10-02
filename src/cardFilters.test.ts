import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  cardMatchesColorFilter,
  emptyCardFilters,
  filterCards,
  manaValueBucket,
  primaryTypeGroup
} from "./cardFilters";
import type { CardRecord } from "./types";

const card = (id: string, extra: Partial<CardRecord> = {}): CardRecord => ({
  id, name: `Karte ${id}`, set: "cmm", setName: "Commander Masters", collectorNumber: "1", lang: "en",
  foil: false, count: 1, addedAt: 1, updatedAt: 1, manaValue: 2, colors: [], colorIdentity: [], ...extra
});

describe("Kartenfilter (Sammlung und Marketplace)", () => {
  const cards = [
    card("1", { name: "Sol Ring", typeLine: "Artifact", manaValue: 1 }),
    card("2", { name: "Lightning Bolt", typeLine: "Instant", colors: ["R"], set: "2xm", setName: "Double Masters" }),
    card("3", { name: "Atraxa", typeLine: "Legendary Creature — Phyrexian", colors: ["W", "U", "B", "G"], manaValue: 4 }),
    card("4", { name: "Hochmana", typeLine: "Sorcery", colors: ["B"], manaValue: 9 })
  ];

  it("filtert nach Name, Set und Typtext", () => {
    expect(filterCards(cards, "bolt", emptyCardFilters()).map(c => c.id)).toEqual(["2"]);
    expect(filterCards(cards, "double masters", emptyCardFilters()).map(c => c.id)).toEqual(["2"]);
    expect(filterCards(cards, "", emptyCardFilters())).toHaveLength(4);
  });

  it("kombiniert Farbe, Typ, Set und Mana Value", () => {
    const filters = emptyCardFilters();
    filters.colors = new Set(["C"]);
    expect(filterCards(cards, "", filters).map(c => c.id)).toEqual(["1"]);

    filters.colors = new Set(["M"]);
    expect(filterCards(cards, "", filters).map(c => c.id)).toEqual(["3"]);

    const typed = emptyCardFilters();
    typed.types = new Set(["Spontanzauber", "Hexerei"]);
    expect(filterCards(cards, "", typed).map(c => c.id)).toEqual(["2", "4"]);

    const bySet = emptyCardFilters();
    bySet.sets = new Set(["2xm"]);
    expect(filterCards(cards, "", bySet).map(c => c.id)).toEqual(["2"]);

    const mana = emptyCardFilters();
    mana.mana = new Set(["7+"]);
    expect(filterCards(cards, "", mana).map(c => c.id)).toEqual(["4"]);
    expect(activeFilterCount(mana)).toBe(1);
  });

  it("ordnet Typen und Mana-Value-Gruppen zu", () => {
    expect(primaryTypeGroup("Basic Land — Island")).toBe("Land");
    expect(primaryTypeGroup("Artifact Creature")).toBe("Kreatur");
    expect(primaryTypeGroup(undefined)).toBe("Sonstiges");
    expect(manaValueBucket(card("x", { manaValue: 12 }))).toBe("7+");
    expect(cardMatchesColorFilter(card("y", { colors: ["R"] }), new Set(["R", "G"]))).toBe(true);
  });
});
