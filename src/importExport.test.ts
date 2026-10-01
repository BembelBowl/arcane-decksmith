import { describe, expect, it } from "vitest";
import { parseExternalImport, toCsv } from "./importExport";
import type { CardRecord } from "./types";

describe("parseExternalImport", () => {
  it("reads the Moxfield-style CSV used by the external import", () => {
    const csv = [
      'Count,"Tradelist Count",Name,Edition,Condition,Language,Foil,Tags,"Last Modified","Collector Number",Alter,Proxy,"Purchase Price"',
      '2,0,Abjure,wth,"Near Mint",German,,,,31,FALSE,FALSE,',
      '1,0,"Voldaren Estate",vow,"Near Mint",English,foil,,,403,FALSE,FALSE,'
    ].join("\n");

    const result = parseExternalImport("collection.csv", csv);

    expect(result.provider).toBe("Moxfield");
    expect(result.rows).toEqual([
      {
        count: 2,
        name: "Abjure",
        edition: "wth",
        collectorNumber: "31",
        foil: false,
        section: "main"
      },
      {
        count: 1,
        name: "Voldaren Estate",
        edition: "vow",
        collectorNumber: "403",
        foil: true,
        section: "main"
      }
    ]);
  });

  it("maps CSV columns by header name instead of column position", () => {
    const csv = [
      '"Collector Number",Foil,Edition,Name,Count',
      '396,foil,cmm,"Sol Ring",2',
      '31,,wth,Abjure,1'
    ].join("\n");

    const result = parseExternalImport("reordered.csv", csv);

    expect(result.rows).toEqual([
      {
        count: 2,
        name: "Sol Ring",
        edition: "cmm",
        collectorNumber: "396",
        foil: true,
        section: "main"
      },
      {
        count: 1,
        name: "Abjure",
        edition: "wth",
        collectorNumber: "31",
        foil: false,
        section: "main"
      }
    ]);
  });

  it("reads printing details and foil markers from text deck lists", () => {
    const text = [
      "Format: Commander",
      "Commander",
      "1 Atraxa, Praetors' Voice (2X2) 190 *F*",
      "Deck",
      "1 Sol Ring [CMM:396]",
      "Sideboard",
      "1 Counterspell"
    ].join("\n");

    const result = parseExternalImport("deck.txt", text);

    expect(result.format).toBe("commander");
    expect(result.rows[0]).toMatchObject({
      name: "Atraxa, Praetors' Voice",
      edition: "2X2",
      collectorNumber: "190",
      foil: true,
      section: "commander"
    });
    expect(result.rows[1]).toMatchObject({
      name: "Sol Ring",
      edition: "CMM",
      collectorNumber: "396",
      section: "main"
    });
    expect(result.rows[2].section).toBe("sideboard");
  });

  it("überspringt Zeilen mit Anzahl 0 oder ungültiger Anzahl und meldet sie", () => {
    const csv = ["Count,Name", "0,Abjure", "abc,Sol Ring", "2,Counterspell"].join("\n");
    const result = parseExternalImport("c.csv", csv);
    expect(result.rows).toEqual([{ count: 2, name: "Counterspell", foil: false, section: "main" }]);
    expect(result.skipped?.map(item => item.line)).toEqual([2, 3]);

    const text = parseExternalImport("d.txt", "0 Sol Ring\n1 Counterspell");
    expect(text.rows).toHaveLength(1);
    expect(text.skipped).toHaveLength(1);
  });

  it("verwendet 1 nur, wenn die Count-Spalte fehlt", () => {
    const result = parseExternalImport("c.csv", "Name,Edition\nSol Ring,cmm");
    expect(result.rows[0].count).toBe(1);
  });

  it("liest Collector Numbers mit Sonderzeichen aus Textlisten", () => {
    const result = parseExternalImport("d.txt", "1 A-Mischievous Catgeist // A-Catlike Curiosity (VOW) A-69\n1 Foo (SLD) 123★");
    expect(result.rows[0]).toMatchObject({ edition: "VOW", collectorNumber: "A-69" });
    expect(result.rows[1]).toMatchObject({ edition: "SLD", collectorNumber: "123★" });
  });

  it("CSV-Export bleibt per Roundtrip inkl. Foil-Aufteilung importierbar", () => {
    const cards: CardRecord[] = [{
      id: "x", name: "Sol Ring, the \"Classic\"", set: "cmm", setName: "Commander Masters", collectorNumber: "396",
      lang: "en", foil: false, count: 3, finishCounts: { nonfoil: 2, foil: 1 }, addedAt: 1, updatedAt: 1,
      manaValue: 1, colors: [], colorIdentity: [], priceEur: 1.5
    }];
    const csv = toCsv(cards);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const result = parseExternalImport("collection.csv", csv);
    expect(result.rows).toEqual([
      { count: 2, name: "Sol Ring, the \"Classic\"", edition: "cmm", collectorNumber: "396", foil: false, section: "main" },
      { count: 1, name: "Sol Ring, the \"Classic\"", edition: "cmm", collectorNumber: "396", foil: true, section: "main" }
    ]);
  });
});
