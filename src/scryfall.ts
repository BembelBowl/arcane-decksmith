import type { CardRecord } from "./types";

const API = "https://api.scryfall.com";
const cache = new Map<string, CardRecord>();
const searchCache = new Map<string, ScryfallCard[]>();
const printingsCache = new Map<string, ScryfallCard[]>();
let lastRequest = 0;

export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  lang?: string;
  set: string;
  collector_number: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  image_uris?: { small?: string; normal?: string; large?: string };
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    oracle_text?: string;
    type_line?: string;
    colors?: string[];
    color_identity?: string[];
    image_uris?: { small?: string; normal?: string; large?: string };
  }>;
  legalities?: Record<string, string>;
  rarity?: string;
  set_name?: string;
  prices?: Record<string, string | null>;
  scryfall_uri?: string;
  prints_search_uri?: string;
}

interface SearchResponse {
  data: ScryfallCard[];
  has_more: boolean;
  next_page?: string;
  total_cards: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson<T>(url: string): Promise<T> {
  const wait = Math.max(0, 110 - (Date.now() - lastRequest));
  if (wait) await sleep(wait);
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { Accept: "application/json;q=0.9,*/*;q=0.8" } });
  if (!res.ok) throw new Error(res.status === 429 ? "Scryfall: zu viele Anfragen. Bitte kurz warten." : `Scryfall-Fehler ${res.status}.`);
  return res.json() as Promise<T>;
}

export function imageFor(card: ScryfallCard | CardRecord): string | undefined {
  if ("image_uris" in card) {
    return card.image_uris?.normal ?? card.image_uris?.large ?? card.image_uris?.small;
  }

  if ("imageUris" in card) {
    return card.imageUris?.normal ?? card.imageUris?.large ?? card.imageUris?.small ?? card.imageUri;
  }

  return undefined;
}

export function normalizeCard(card: ScryfallCard, count = 1, foil = false): CardRecord {
  const face = card.card_faces?.[0];
  return {
    id: card.id,
    oracleId: card.oracle_id,
    name: card.name,
    set: card.set,
    collectorNumber: card.collector_number,
    lang: card.lang ?? "en",
    foil,
    count,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    manaCost: card.mana_cost ?? face?.mana_cost,
    manaValue: Number(card.cmc ?? 0),
    colors: card.colors ?? face?.colors ?? [],
    colorIdentity: card.color_identity ?? face?.color_identity ?? [],
    typeLine: card.type_line ?? face?.type_line,
    oracleText: card.oracle_text ?? card.card_faces?.map((f) => f.oracle_text).filter(Boolean).join("\n//\n"),
    imageUri: imageFor(card),
    imageUris: card.image_uris ?? face?.image_uris,
    legalities: card.legalities,
    isBasicLand: /^Basic Land\b/i.test(card.type_line ?? "")
  };
}

export async function searchCards(query: string): Promise<ScryfallCard[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];
  const cached = searchCache.get(key);
  if (cached) return cached;
  const params = new URLSearchParams({ q: key, unique: "cards", order: "name" });
  const result = await getJson<SearchResponse>(`${API}/cards/search?${params.toString()}`);
  searchCache.set(key, result.data);
  result.data.forEach((c) => cache.set(c.id, normalizeCard(c)));
  return result.data;
}

export async function getPrintings(card: ScryfallCard): Promise<ScryfallCard[]> {
  const cacheKey = card.oracle_id ?? card.name.toLowerCase();

  const cached = printingsCache.get(cacheKey);
  if (cached) return cached;

  if (!card.prints_search_uri) {
    return [card];
  }

  const cards: ScryfallCard[] = [];
  let nextUrl: string | undefined = card.prints_search_uri;

  while (nextUrl) {
    const result: SearchResponse = await getJson<SearchResponse>(nextUrl);

    cards.push(...result.data);

    nextUrl =
      result.has_more && result.next_page
        ? result.next_page
        : undefined;
  }

  const sorted = cards.sort((a, b) => {
    const setCompare = (a.set_name ?? a.set).localeCompare(
      b.set_name ?? b.set
    );

    if (setCompare !== 0) return setCompare;

    return a.collector_number.localeCompare(
      b.collector_number,
      undefined,
      { numeric: true }
    );
  });

  printingsCache.set(cacheKey, sorted);

  sorted.forEach(c => cache.set(c.id, normalizeCard(c)));

  return sorted;
}

export async function autocomplete(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  const result = await getJson<{ data: string[] }>(`${API}/cards/autocomplete?q=${encodeURIComponent(query.trim())}`);
  return result.data.slice(0, 8);
}

export async function getCard(id: string): Promise<CardRecord> {
  const hit = cache.get(id);
  if (hit) return hit;
  const card = await getJson<ScryfallCard>(`${API}/cards/${encodeURIComponent(id)}`);
  const normalized = normalizeCard(card);
  cache.set(id, normalized);
  return normalized;
}

export function scryfallUrl(id: string) {
  return `https://scryfall.com/card/${id}`;
}
