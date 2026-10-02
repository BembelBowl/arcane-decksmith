import { describe, expect, it } from "vitest";
import { parseScannerMetadata } from "./cardRecognition";
import type { ScryfallSet } from "../scryfall";

const sets = ["ONE", "ALL", "WAR", "ICE", "VOW", "MKM"].map(code => ({ code: code.toLowerCase(), name: code }) as ScryfallSet);

describe("parseScannerMetadata", () => {
  it("liest Set, Nummer und Sprache aus der Metadatenzeile", () => {
    const text = [
      "Elesh Norn, Mother of Machines",
      "Legendary Creature — Phyrexian Praetor",
      "Vigilance",
      "4/7",
      "0010/0271 M",
      "ONE • EN Martina Fačková"
    ].join("\n");
    expect(parseScannerMetadata(text, sets)).toMatchObject({ setCode: "one", collectorNumber: "10", language: "en" });
  });

  it("ignoriert Set- und Sprachcodes im Regeltext", () => {
    const text = [
      "Lightning Helix",
      "Lightning Helix deals 3 damage to any target and you gain 3 life. ALL IT DOES IS WAR ON ICE",
      "LA ES DE"
    ].join("\n");
    const result = parseScannerMetadata(text, sets);
    expect(result.setCode).toBeUndefined();
    expect(result.language).toBeUndefined();
    expect(result.collectorNumber).toBeUndefined();
  });

  it("wertet Jahreszahlen nicht als Collector Number", () => {
    const text = ["TM & © 2021/2022 Wizards of the Coast", "ONE • EN"].join("\n");
    expect(parseScannerMetadata(text, sets).collectorNumber).toBeUndefined();
  });

  it("erkennt das neuere Format mit Seltenheitsbuchstaben", () => {
    const text = ["Some Card", "R 0123", "MKM • DE Artist"].join("\n");
    expect(parseScannerMetadata(text, sets)).toMatchObject({ setCode: "mkm", collectorNumber: "123", language: "de" });
  });

  it("erkennt A-Nummern", () => {
    const text = ["A-Mischievous Catgeist", "A-69/277 U", "VOW • EN"].join("\n");
    expect(parseScannerMetadata(text, sets)).toMatchObject({ setCode: "vow", collectorNumber: "a-69" });
  });

  it("4/7 (Stärke/Widerstand) zählt nicht ohne Metadatenkontext als Set", () => {
    const text = ["Some Creature", "War Elemental", "4/7"].join("\n");
    const result = parseScannerMetadata(text, sets);
    expect(result.setCode).toBeUndefined();
  });
});
