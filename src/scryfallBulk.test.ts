import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCardsFromDefaultBulkData, type ScryfallCard } from "./scryfall";

const card = (id: string, name: string, set: string, cn: string, setName = set.toUpperCase()): ScryfallCard => ({
  id, name, set, set_name: setName, collector_number: cn, lang: "en", released_at: "2021-11-19",
  cmc: 2, colors: [], color_identity: [], type_line: "Creature", finishes: ["nonfoil"], prices: {}
} as unknown as ScryfallCard);

const relevant = [
  card("a69", "A-Mischievous Catgeist // A-Catlike Curiosity", "vow", "A-69", "Innistrad: Crimson Vow"),
  card("n69", "Mischievous Catgeist // Catlike Curiosity", "vow", "69", "Innistrad: Crimson Vow"),
  card("isl1", "Island", "neo", "293"),
  card("isl2", "Island", "neo", "294"),
  card("sol", "Sol Ring", "cmm", "396")
];

function filler(count: number): ScryfallCard[] {
  return Array.from({ length: count }, (_, i) => card(`f${i}`, `Filler ${i}`, "zzz", String(i)));
}

function mockBulk(cards: ScryfallCard[]) {
  const body = cards.map(item => JSON.stringify(item)).join("\n");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/bulk-data/")) {
      return new Response(JSON.stringify({ type: "default_cards", jsonl_download_uri: "https://data.test/default.jsonl" }));
    }
    return new Response(body);
  }));
}

const identifiers = [
  { index: 0, name: "A-Mischievous Catgeist // A-Catlike Curiosity", set: "VOW", collectorNumber: "A69", count: 1 },
  { index: 1, name: "Island", set: "neo", count: 4 },
  { index: 2, name: "Sol Ring", set: "xyz", collectorNumber: "396", count: 1 },
  { index: 3, name: "Mischievous Catgeist", set: "Innistrad: Crimson Vow", collectorNumber: "069", count: 1 },
  { index: 4, name: "Does Not Exist", count: 1 }
];

describe("Bulk-Matching", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ist deterministisch, erkennt A-69 und markiert Mehrdeutigkeit", { timeout: 20000 }, async () => {
    mockBulk([...relevant, ...filler(50_000)]);
    const first = await resolveCardsFromDefaultBulkData(identifiers);

    mockBulk([...filler(50_000), ...[...relevant].reverse()]);
    const second = await resolveCardsFromDefaultBulkData(identifiers);

    for (const result of [first, second]) {
      expect(result.cardsByIndex.get(0)?.id).toBe("a69");
      expect(result.cardsByIndex.get(2)?.id).toBe("sol");
      expect(result.cardsByIndex.get(3)?.id).toBe("n69");
      expect(result.ambiguousIndexes).toEqual([1]);
      expect(result.notFoundIndexes).toEqual([4]);
    }
  });

  it("löst im Deckmodus Mehrdeutigkeit deterministisch auf", { timeout: 20000 }, async () => {
    mockBulk([...relevant, ...filler(50_000)]);
    const result = await resolveCardsFromDefaultBulkData(identifiers, undefined, "deck");
    expect(result.cardsByIndex.get(1)?.id).toBe("isl2");
    expect(result.ambiguousIndexes).toEqual([]);
  });

  it("verwirft unvollständige Downloads komplett (atomar)", { timeout: 20000 }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      mockBulk([...relevant, ...filler(10)]);
      const pending = resolveCardsFromDefaultBulkData(identifiers);
      const assertion = expect(pending).rejects.toThrow(/nicht vollständig geladen/);
      await vi.runAllTimersAsync();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
