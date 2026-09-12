import type {
  CardFinish,
  CardRecord
} from "./types";

const API = "https://api.scryfall.com";

const cache = new Map<string, CardRecord>();
const searchCache = new Map<string, ScryfallCard[]>();
const printingsCache = new Map<string, ScryfallCard[]>();
let setsCache: ScryfallSet[] | null = null;

let lastRequest = 0;

export interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  printed_name?: string;
  lang?: string;
  set: string;
  collector_number: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  printed_type_line?: string;
  printed_text?: string;
  foil?: boolean;
  nonfoil?: boolean;
  finishes?: string[];

  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
  };

  card_faces?: Array<{
    name?: string;
    printed_name?: string;
    mana_cost?: string;
    oracle_text?: string;
    printed_text?: string;
    type_line?: string;
    printed_type_line?: string;
    colors?: string[];
    color_identity?: string[];
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
    };
  }>;

  legalities?: Record<string, string>;
  game_changer?: boolean;
  rarity?: string;
  set_name?: string;
  prices?: Record<string, string | null>;
  scryfall_uri?: string;
  prints_search_uri?: string;
}

export interface ScryfallSet {
  id: string;
  code: string;
  name: string;
  set_type?: string;
  released_at?: string;
  card_count?: number;
  digital?: boolean;
}

interface SetListResponse {
  data: ScryfallSet[];
}

export interface CollectorNumberLookupResult {
  cards: ScryfallCard[];
  notFound: string[];
}

interface SearchResponse {
  data: ScryfallCard[];
  has_more: boolean;
  next_page?: string;
  total_cards: number;
}

interface CollectionResponse {
  data: ScryfallCard[];
  not_found?: Array<{
    set?: string;
    collector_number?: string;
    [key: string]: unknown;
  }>;
}

const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

async function getJson<T>(url: string): Promise<T> {
  const wait = Math.max(0, 110 - (Date.now() - lastRequest));

  if (wait) {
    await sleep(wait);
  }

  lastRequest = Date.now();

  const res = await fetch(url, {
    headers: {
      Accept: "application/json;q=0.9,*/*;q=0.8"
    }
  });

  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? "Scryfall: zu viele Anfragen. Bitte kurz warten."
        : `Scryfall-Fehler ${res.status}.`
    );
  }

  return res.json() as Promise<T>;
}

async function postJson<T>(
  url: string,
  body: unknown
): Promise<T> {
  const wait = Math.max(
    0,
    110 -
      (
        Date.now() -
        lastRequest
      )
  );

  if (wait) {
    await sleep(wait);
  }

  lastRequest = Date.now();

  const res = await fetch(
    url,
    {
      method: "POST",
      headers: {
        Accept:
          "application/json;q=0.9,*/*;q=0.8",
        "Content-Type":
          "application/json"
      },
      body:
        JSON.stringify(body)
    }
  );

  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? "Scryfall: zu viele Anfragen. Bitte kurz warten."
        : `Scryfall-Fehler ${res.status}.`
    );
  }

  return res.json() as Promise<T>;
}

function removeUndefinedDeep<T>(
  value: T
): T {
  if (Array.isArray(value)) {
    return value
      .map(item =>
        removeUndefinedDeep(item)
      )
      .filter(
        item =>
          item !== undefined
      ) as T;
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    const cleaned:
      Record<string, unknown> = {};

    for (
      const [key, entry]
      of Object.entries(
        value as Record<
          string,
          unknown
        >
      )
    ) {
      if (entry === undefined) {
        continue;
      }

      cleaned[key] =
        removeUndefinedDeep(
          entry
        );
    }

    return cleaned as T;
  }

  return value;
}

function parseEuroPrice(
  value: string | null | undefined
): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : undefined;
}

export function availableFinishes(
  card: ScryfallCard
): CardFinish[] {
  const finishes =
    new Set(
      card.finishes ?? []
    );

  const result:
    CardFinish[] = [];

  if (
    finishes.has("nonfoil") ||
    card.nonfoil === true
  ) {
    result.push("nonfoil");
  }

  if (
    finishes.has("foil") ||
    card.foil === true
  ) {
    result.push("foil");
  }

  // Fallback nur dann, wenn Scryfall keine
  // Finish-Information geliefert hat.
  if (result.length === 0) {
    if (
      card.prices?.eur
    ) {
      result.push(
        "nonfoil"
      );
    }

    if (
      card.prices?.eur_foil
    ) {
      result.push(
        "foil"
      );
    }
  }

  return result;
}

export function euroPriceFor(
  card: ScryfallCard,
  finish: CardFinish
): number | undefined {
  return parseEuroPrice(
    finish === "foil"
      ? card.prices?.eur_foil
      : card.prices?.eur
  );
}

export function imageFor(
  card: ScryfallCard | CardRecord
): string | undefined {
  if ("collector_number" in card) {
    const directImage =
      card.image_uris?.normal ??
      card.image_uris?.large ??
      card.image_uris?.small;

    if (directImage) {
      return directImage;
    }

    for (
      const face
      of card.card_faces ?? []
    ) {
      const faceImage =
        face.image_uris?.normal ??
        face.image_uris?.large ??
        face.image_uris?.small;

      if (faceImage) {
        return faceImage;
      }
    }

    return undefined;
  }

  return (
    card.imageUris?.normal ??
    card.imageUris?.large ??
    card.imageUris?.small ??
    card.imageUri
  );
}

// Kompatibilität mit der aktuellen App.tsx: bewusst nur englische Daten.
export function displayName(card: ScryfallCard): string {
  return card.name;
}

export function displayTypeLine(card: ScryfallCard): string {
  return (
    card.type_line ??
    card.card_faces
      ?.map(face => face.type_line)
      .filter(Boolean)
      .join(" // ") ??
    ""
  );
}

export function displayOracleText(card: ScryfallCard): string {
  return (
    card.oracle_text ??
    card.card_faces
      ?.map(face => face.oracle_text)
      .filter(Boolean)
      .join("\n//\n") ??
    ""
  );
}

export function normalizeCard(
  card: ScryfallCard,
  count = 1,
  isFoil = false
): CardRecord {
  const face =
    card.card_faces?.[0];

  const finishes =
    availableFinishes(card);

  const priceEur =
    euroPriceFor(
      card,
      "nonfoil"
    );

  const priceEurFoil =
    euroPriceFor(
      card,
      "foil"
    );

  const imageUri =
    imageFor(card);

  const imageUris =
    card.image_uris ??
    face?.image_uris;

  const record:
    CardRecord = {
      id: card.id,
      oracleId:
        card.oracle_id,
      name: card.name,
      set: card.set,
      setName:
        card.set_name,
      collectorNumber:
        card.collector_number,
      lang:
        card.lang ??
        "en",
      foil:
        isFoil,
      finishCounts:
        isFoil
          ? {
              nonfoil: 0,
              foil: count
            }
          : {
              nonfoil: count,
              foil: 0
            },
      availableFinishes:
        finishes,
      ...(priceEur !== undefined
        ? {
            priceEur
          }
        : {}),
      ...(priceEurFoil !== undefined
        ? {
            priceEurFoil
          }
        : {}),
      priceUpdatedAt:
        Date.now(),
      count,
      addedAt:
        Date.now(),
      updatedAt:
        Date.now(),
      manaCost:
        card.mana_cost ??
        face?.mana_cost,
      manaValue:
        Number(
          card.cmc ?? 0
        ),
      colors:
        card.colors ??
        face?.colors ??
        [],
      colorIdentity:
        card.color_identity ??
        face?.color_identity ??
        [],
      typeLine:
        card.type_line ??
        card.card_faces
          ?.map(
            item =>
              item.type_line
          )
          .filter(Boolean)
          .join(" // "),
      oracleText:
        card.oracle_text ??
        card.card_faces
          ?.map(
            item =>
              item.oracle_text
          )
          .filter(Boolean)
          .join("\n//\n"),
      ...(imageUri !== undefined
        ? {
            imageUri
          }
        : {}),
      ...(imageUris !== undefined
        ? {
            imageUris
          }
        : {}),
      legalities:
        card.legalities,
      gameChanger:
        card.game_changer ===
        true,
      isBasicLand:
        /^Basic Land\b/i.test(
          card.type_line ??
          face?.type_line ??
          ""
        )
    };

  return removeUndefinedDeep(
    record
  );
}

// Rein englische Scryfall-Suche.
export async function searchCards(
  query: string
): Promise<ScryfallCard[]> {
  const key = query.trim().toLowerCase();

  if (!key) {
    return [];
  }

  const cached = searchCache.get(key);

  if (cached) {
    return cached;
  }

  const params = new URLSearchParams({
    q: key,
    unique: "cards",
    order: "name"
  });

  const result = await getJson<SearchResponse>(
    `${API}/cards/search?${params.toString()}`
  );

  searchCache.set(key, result.data);

  result.data.forEach(card =>
    cache.set(card.id, normalizeCard(card))
  );

  return result.data;
}

export async function getSets(): Promise<ScryfallSet[]> {
  if (setsCache) {
    return setsCache;
  }

  const result =
    await getJson<SetListResponse>(
      `${API}/sets`
    );

  setsCache =
    result.data
      .filter(
        set =>
          set.digital !== true &&
          (set.card_count ?? 0) > 0
      )
      .sort(
        (a, b) => {
          const releasedCompare =
            (b.released_at ?? "")
              .localeCompare(
                a.released_at ?? ""
              );

          return releasedCompare !== 0
            ? releasedCompare
            : a.name.localeCompare(
                b.name
              );
        }
      );

  return setsCache;
}

export async function getCardsBySetAndCollectorNumbers(
  setCode: string,
  collectorNumbers: string[]
): Promise<CollectorNumberLookupResult> {
  const cleanSet =
    setCode.trim().toLowerCase();

  const uniqueNumbers =
    Array.from(
      new Set(
        collectorNumbers
          .map(number =>
            number.trim()
          )
          .filter(Boolean)
      )
    );

  if (
    !cleanSet ||
    uniqueNumbers.length === 0
  ) {
    return {
      cards: [],
      notFound: []
    };
  }

  const cards:
    ScryfallCard[] = [];

  const notFound:
    string[] = [];

  for (
    let index = 0;
    index < uniqueNumbers.length;
    index += 75
  ) {
    const batch =
      uniqueNumbers.slice(
        index,
        index + 75
      );

    const response =
      await postJson<CollectionResponse>(
        `${API}/cards/collection`,
        {
          identifiers:
            batch.map(
              collectorNumber => ({
                set:
                  cleanSet,
                collector_number:
                  collectorNumber
              })
            )
        }
      );

    cards.push(
      ...response.data
    );

    for (
      const missing
      of response.not_found ?? []
    ) {
      if (
        typeof missing.collector_number ===
        "string"
      ) {
        notFound.push(
          missing.collector_number
        );
      }
    }
  }

  cards.forEach(card =>
    cache.set(
      card.id,
      normalizeCard(card)
    )
  );

  return {
    cards,
    notFound
  };
}

export async function getPrintings(
  card: ScryfallCard
): Promise<ScryfallCard[]> {
  const cacheKey = card.oracle_id ?? card.name.toLowerCase();
  const cached = printingsCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  if (!card.prints_search_uri) {
    return [card];
  }

  const cards: ScryfallCard[] = [];
  let nextUrl: string | undefined = card.prints_search_uri;

  while (nextUrl) {
    const result: SearchResponse =
      await getJson<SearchResponse>(
        nextUrl
      );

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

    if (setCompare !== 0) {
      return setCompare;
    }

    return a.collector_number.localeCompare(
      b.collector_number,
      undefined,
      { numeric: true }
    );
  });

  printingsCache.set(cacheKey, sorted);

  sorted.forEach(card =>
    cache.set(card.id, normalizeCard(card))
  );

  return sorted;
}

// Originales englisches Scryfall-Autocomplete.
export async function autocomplete(
  query: string
): Promise<string[]> {
  if (!query.trim()) {
    return [];
  }

  const result = await getJson<{ data: string[] }>(
    `${API}/cards/autocomplete?q=${encodeURIComponent(query.trim())}`
  );

  return result.data.slice(0, 8);
}

// Bleibt nur als Kompatibilitäts-Export für die aktuelle App.tsx bestehen.
export async function canonicalEnglishCard(
  card: ScryfallCard
): Promise<ScryfallCard> {
  return card;
}

export async function getCards(
  ids: string[]
): Promise<CardRecord[]> {
  const uniqueIds =
    Array.from(
      new Set(
        ids.filter(Boolean)
      )
    );

  if (uniqueIds.length === 0) {
    return [];
  }

  const result:
    CardRecord[] = [];

  for (
    let index = 0;
    index < uniqueIds.length;
    index += 75
  ) {
    const batch =
      uniqueIds.slice(
        index,
        index + 75
      );

    const response =
      await postJson<CollectionResponse>(
        `${API}/cards/collection`,
        {
          identifiers:
            batch.map(
              id => ({
                id
              })
            )
        }
      );

    for (
      const card
      of response.data
    ) {
      const normalized =
        normalizeCard(card);

      cache.set(
        card.id,
        normalized
      );

      result.push(
        normalized
      );
    }
  }

  return result;
}

export async function getCard(
  id: string
): Promise<CardRecord> {
  const hit = cache.get(id);

  if (hit) {
    return hit;
  }

  const card = await getJson<ScryfallCard>(
    `${API}/cards/${encodeURIComponent(id)}`
  );

  const normalized = normalizeCard(card);
  cache.set(id, normalized);

  return normalized;
}

export function scryfallUrl(id: string) {
  return `https://scryfall.com/card/${id}`;
}
