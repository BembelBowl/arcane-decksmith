import { describe, expect, it } from "vitest";
import { parsePreconDeck, parsePreconDeckList, preconCollectionCards } from "./precons";
import type { ScryfallCard } from "./scryfall";

const summary = { fileName: "Test_C21", name: "Test", code: "C21", type: "Commander Deck", releaseDate: "2021-04-23" };

describe("precons", () => {
  it("liest die Deckliste und sortiert neueste zuerst", () => {
    const decks = parsePreconDeckList({
      data: [
        { fileName: "Old_C13", name: "Old", code: "c13", type: "Commander Deck", releaseDate: "2013-11-01" },
        { fileName: "../evil", name: "Evil", code: "x", type: "Deck", releaseDate: "2030-01-01" },
        summary
      ]
    });
    expect(decks.map(deck => deck.fileName)).toEqual(["Test_C21", "Old_C13"]);
    expect(decks[1].code).toBe("C13");
  });

  it("übernimmt Commander, Hauptdeck und Zusatzkarten mit exakten Printings", () => {
    const deck = parsePreconDeck({
      data: {
        name: "Lorehold Legacies",
        commander: [{ name: "Osgir", count: 1, isFoil: true, setCode: "C21", number: "4", identifiers: { scryfallId: "id-1" } }],
        mainBoard: [
          { name: "Sol Ring", count: 1, setCode: "C21", number: "263", identifiers: { scryfallId: "id-2" } },
          { name: "Mountain", count: 0, setCode: "C21", number: "300" }
        ],
        sideBoard: [{ name: "Extra", count: 2, setCode: "C21", number: "5" }]
      }
    }, summary);

    expect(deck.name).toBe("Lorehold Legacies");
    expect(deck.rows).toEqual([
      { name: "Osgir", count: 1, foil: true, section: "commander", scryfallId: "id-1", setCode: "c21", collectorNumber: "4" },
      { name: "Sol Ring", count: 1, foil: false, section: "main", scryfallId: "id-2", setCode: "c21", collectorNumber: "263" },
      { name: "Extra", count: 2, foil: false, section: "sideboard", setCode: "c21", collectorNumber: "5" }
    ]);
  });

  it("fasst gleiche Druckversionen mit Foil-Aufteilung zusammen", () => {
    const scry = { id: "x", oracle_id: "o", name: "Sol Ring", set: "c21", set_name: "C21", collector_number: "263", lang: "en", cmc: 1, colors: [], color_identity: [], type_line: "Artifact", finishes: ["nonfoil", "foil"], prices: {} } as unknown as ScryfallCard;
    const cards = preconCollectionCards([
      { row: { name: "Sol Ring", count: 1, foil: false, section: "main" }, card: scry },
      { row: { name: "Sol Ring", count: 1, foil: true, section: "main" }, card: scry }
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].finishCounts).toEqual({ nonfoil: 1, foil: 1 });
    expect(cards[0].count).toBe(2);
  });
});
