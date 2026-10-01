import { describe, expect, it } from "vitest";
import {
  candidateWithinPerCardBudget,
  normalizedPurchaseBudget,
  takeWithinDeckBudget,
  type PurchaseCandidate
} from "./ai";

const candidate = (name: string, priceEur?: number): PurchaseCandidate => ({
  id: name, name, gameChanger: false, category: "x", roleName: "x", manaValue: 2,
  typeLine: "Instant", oracleText: "", currentRoleCount: 0, targetRoleCount: 1, deficit: 1, priceEur
});

describe("Kaufvorschläge: Budget", () => {
  it("ignoriert ungültige Budgetwerte", () => {
    expect(normalizedPurchaseBudget({ maxPricePerCardEur: -1, maxPricePerDeckEur: Number.NaN }))
      .toEqual({ maxPricePerCardEur: undefined, maxPricePerDeckEur: undefined });
    expect(normalizedPurchaseBudget({ maxPricePerCardEur: 0 })).toEqual({ maxPricePerCardEur: 0, maxPricePerDeckEur: undefined });
  });

  it("Preis pro Karte ist eine harte Grenze; ohne Preis kein Vorschlag bei aktivem Limit", () => {
    expect(candidateWithinPerCardBudget(5, { maxPricePerCardEur: 5 })).toBe(true);
    expect(candidateWithinPerCardBudget(5.01, { maxPricePerCardEur: 5 })).toBe(false);
    expect(candidateWithinPerCardBudget(undefined, { maxPricePerCardEur: 5 })).toBe(false);
    expect(candidateWithinPerCardBudget(undefined, {})).toBe(true);
  });

  it("Gesamtbudget pro Deck wird nie überschritten", () => {
    const selected = takeWithinDeckBudget(
      [candidate("A", 6), candidate("B", 5), candidate("C"), candidate("D", 4), candidate("E", 1)],
      { maxPricePerDeckEur: 10 }
    );
    expect(selected.map(item => item.name)).toEqual(["A", "D"]);
    expect(selected.reduce((sum, item) => sum + (item.priceEur ?? 0), 0)).toBeLessThanOrEqual(10);
  });

  it("ohne Gesamtbudget höchstens drei Vorschläge", () => {
    expect(takeWithinDeckBudget([candidate("A"), candidate("B"), candidate("C"), candidate("D")], {})).toHaveLength(3);
  });
});
