import { describe, expect, it } from "vitest";
import {
  clampOffer,
  listingFromCard,
  marketListingId,
  offeredByCardId,
  planOfferSave,
  syncListingWithCard,
  validateDisplayName
} from "./marketplace";
import type { CardRecord } from "./types";

const card = (id: string, extra: Partial<CardRecord> = {}): CardRecord => ({
  id, name: `Karte ${id}`, set: "cmm", setName: "Commander Masters", collectorNumber: "396", lang: "en",
  foil: false, count: 3, finishCounts: { nonfoil: 2, foil: 1 }, addedAt: 1, updatedAt: 1,
  manaValue: 1, colors: [], colorIdentity: [], priceEur: 1.5, priceEurFoil: 4,
  imageUris: { normal: "https://cards.scryfall.io/normal/front/a/b/x.jpg" }, ...extra
});

describe("Marketplace", () => {
  it("prüft den Anzeigenamen (keine E-Mail, keine Links, Länge)", () => {
    expect(validateDisplayName("  Mox   Meister ")).toEqual({ ok: true, name: "Mox Meister" });
    expect(validateDisplayName("a").ok).toBe(false);
    expect(validateDisplayName("x".repeat(31)).ok).toBe(false);
    expect(validateDisplayName("ben@example.com").ok).toBe(false);
    expect(validateDisplayName("https://evil.example").ok).toBe(false);
    expect(validateDisplayName("www.evil.example").ok).toBe(false);
  });

  it("begrenzt Angebote auf den Bestand je Finish", () => {
    expect(clampOffer(card("1"), 5, 5)).toEqual({ nonfoil: 2, foil: 1 });
    expect(clampOffer(card("1"), -3, 0.9)).toEqual({ nonfoil: 0, foil: 0 });
    expect(clampOffer(card("1"), Number.NaN, 1)).toEqual({ nonfoil: 0, foil: 1 });
  });

  it("erzeugt ein Angebot mit öffentlichen Angaben und Scryfall-Bild", () => {
    const listing = listingFromCard(card("1"), { nonfoil: 1, foil: 0 }, "u1", "Mox", undefined, 10);
    expect(listing.id).toBe(marketListingId("u1", "1"));
    expect(listing.nameLower).toBe("karte 1");
    expect(listing.imageUri).toContain("cards.scryfall.io");
    expect(listing.createdAt).toBe(10);
    expect(Object.keys(listing)).not.toContain("email");

    const foreign = listingFromCard(
      card("2", { imageUris: { normal: "https://tracker.example/x.png" }, imageUri: undefined }),
      { nonfoil: 1, foil: 0 }, "u1", "Mox"
    );
    expect(foreign.imageUri).toBeUndefined();
  });

  it("plant Speichern und Entfernen; 0/0 entfernt, Namenswechsel aktualisiert alle", () => {
    const a = listingFromCard(card("a"), { nonfoil: 1, foil: 0 }, "u1", "Alt", undefined, 1);
    const b = listingFromCard(card("b"), { nonfoil: 2, foil: 0 }, "u1", "Alt", undefined, 1);
    const c = listingFromCard(card("c"), { nonfoil: 1, foil: 0 }, "u1", "Alt", undefined, 1);

    const plan = planOfferSave(
      [a, b, c],
      [
        { card: card("a"), nonfoil: 0, foil: 0 },
        { card: card("b"), nonfoil: 1, foil: 1 },
        { card: card("n"), nonfoil: 0, foil: 0 }
      ],
      "u1", "Neu", 99
    );

    expect(plan.toRemove).toEqual([a.id]);
    expect(plan.toSave.map(l => l.cardId).sort()).toEqual(["b", "c"]);
    const savedB = plan.toSave.find(l => l.cardId === "b")!;
    expect(savedB.offered).toEqual({ nonfoil: 1, foil: 1 });
    expect(savedB.createdAt).toBe(1);
    expect(savedB.ownerName).toBe("Neu");
    expect(plan.toSave.find(l => l.cardId === "c")!.ownerName).toBe("Neu");
  });

  it("gleicht Angebote mit der Sammlung ab", () => {
    const listing = listingFromCard(card("1"), { nonfoil: 2, foil: 1 }, "u1", "Mox", undefined, 1);

    expect(syncListingWithCard(listing, card("1"))).toEqual({ action: "keep" });
    expect(syncListingWithCard(listing, undefined)).toEqual({ action: "remove" });

    const reduced = syncListingWithCard(listing, card("1", { count: 1, finishCounts: { nonfoil: 1, foil: 0 } }), 5);
    expect(reduced.action).toBe("update");
    if (reduced.action === "update") expect(reduced.listing.offered).toEqual({ nonfoil: 1, foil: 0 });

    expect(syncListingWithCard(listing, card("1", { count: 0, finishCounts: { nonfoil: 0, foil: 0 }, foil: false })).action)
      .toBe("remove");
  });

  it("zählt angebotene Exemplare je Karte", () => {
    const listing = listingFromCard(card("1"), { nonfoil: 2, foil: 1 }, "u1", "Mox");
    expect(offeredByCardId([listing]).get("1")).toBe(3);
  });
});
