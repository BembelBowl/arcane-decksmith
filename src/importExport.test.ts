import { describe, expect, it } from "vitest";
import { parseExternalImport } from "./importExport";

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
});
