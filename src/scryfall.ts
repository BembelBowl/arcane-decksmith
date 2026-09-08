import type {
  CardRecord
} from "./types";

const API =
  "https://api.scryfall.com";

const cache =
  new Map<
    string,
    CardRecord
  >();

const searchCache =
  new Map<
    string,
    ScryfallCard[]
  >();

const printingsCache =
  new Map<
    string,
    ScryfallCard[]
  >();

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

  legalities?:
    Record<
      string,
      string
    >;

  rarity?: string;
  set_name?: string;

  prices?:
    Record<
      string,
      string | null
    >;

  scryfall_uri?: string;
  prints_search_uri?: string;
}

interface SearchResponse {
  data: ScryfallCard[];
  has_more: boolean;
  next_page?: string;
  total_cards: number;
}

interface GermanIndexEntry {
  p: string;
  e: string;
  c: string;
}

const sleep = (
  ms: number
) =>
  new Promise(resolve =>
    setTimeout(
      resolve,
      ms
    )
  );

async function getJson<T>(
  url: string
): Promise<T> {
  const wait =
    Math.max(
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

  lastRequest =
    Date.now();

  const res =
    await fetch(
      url,
      {
        headers: {
          Accept:
            "application/json;q=0.9,*/*;q=0.8"
        }
      }
    );

  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? "Scryfall: zu viele Anfragen. Bitte kurz warten."
        : `Scryfall-Fehler ${res.status}.`
    );
  }

  return res.json()
    as Promise<T>;
}

export function imageFor(
  card:
    | ScryfallCard
    | CardRecord
): string | undefined {
  if (
    "image_uris" in card
  ) {
    return (
      card.image_uris
        ?.normal ??
      card.image_uris
        ?.large ??
      card.image_uris
        ?.small
    );
  }

  if (
    "imageUris" in card
  ) {
    return (
      card.imageUris
        ?.normal ??
      card.imageUris
        ?.large ??
      card.imageUris
        ?.small ??
      card.imageUri
    );
  }

  return undefined;
}

export function displayName(
  card: ScryfallCard
): string {
  return (
    card.printed_name
      ?.trim() ||
    card.name
  );
}

export function displayTypeLine(
  card: ScryfallCard
): string {
  return (
    card.printed_type_line
      ?.trim() ||
    card.type_line ||
    card.card_faces
      ?.map(
        face =>
          face
            .printed_type_line
            ?.trim() ||
          face.type_line
      )
      .filter(Boolean)
      .join(" // ") ||
    ""
  );
}

export function displayOracleText(
  card: ScryfallCard
): string {
  return (
    card.printed_text
      ?.trim() ||
    card.oracle_text ||
    card.card_faces
      ?.map(
        face =>
          face
            .printed_text
            ?.trim() ||
          face.oracle_text
      )
      .filter(Boolean)
      .join("\n//\n") ||
    ""
  );
}

export function normalizeCard(
  card: ScryfallCard,
  count = 1,
  foil = false
): CardRecord {
  const face =
    card.card_faces?.[0];

  return {
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
      card.lang ?? "en",

    foil,
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
      face
        ?.color_identity ??
      [],

    typeLine:
      card.type_line ??
      face?.type_line,

    oracleText:
      card.oracle_text ??
      card.card_faces
        ?.map(
          f =>
            f.oracle_text
        )
        .filter(Boolean)
        .join("\n//\n"),

    imageUri:
      imageFor(card),

    imageUris:
      card.image_uris ??
      face?.image_uris,

    legalities:
      card.legalities,

    isBasicLand:
      /^Basic Land\b/i.test(
        card.type_line ??
          ""
      )
  };
}

/*
 * -----------------------------
 * Deutscher Namensindex
 * -----------------------------
 */

let germanIndex:
  GermanIndexEntry[] |
  null = null;

let germanIndexPromise:
  Promise<
    GermanIndexEntry[]
  > |
  null = null;

function normalizeName(
  value: string
): string {
  return value
    .trim()
    .toLocaleLowerCase(
      "de-DE"
    );
}

async function loadGermanIndex():
  Promise<
    GermanIndexEntry[]
  > {
  if (germanIndex) {
    return germanIndex;
  }

  if (
    germanIndexPromise
  ) {
    return germanIndexPromise;
  }

  germanIndexPromise =
    (async () => {
      try {
        const url =
          new URL(
            "./de-card-index.json",
            window.location.href
          );

        const response =
          await fetch(
            url.toString()
          );

        if (
          !response.ok
        ) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        const data =
          await response.json()
            as GermanIndexEntry[];

        germanIndex =
          Array.isArray(data)
            ? data
            : [];

        return germanIndex;
      } catch {
        germanIndex = [];

        return [];
      }
    })();

  return germanIndexPromise;
}

async function englishExactCard(
  query: string
): Promise<
  ScryfallCard |
  null
> {
  const params =
    new URLSearchParams({
      exact: query
    });

  try {
    const card =
      await getJson<ScryfallCard>(
        `${API}/cards/named?${params.toString()}`
      );

    if (
      card.lang &&
      card.lang !== "en"
    ) {
      return null;
    }

    return card;
  } catch {
    return null;
  }
}

async function germanExactCard(
  query: string
): Promise<
  ScryfallCard |
  null
> {
  const index =
    await loadGermanIndex();

  const key =
    normalizeName(query);

  const match =
    index.find(
      entry =>
        normalizeName(
          entry.p
        ) === key
    );

  if (!match) {
    return null;
  }

  try {
    /*
     * Der Index enthält die Cardmarket-ID
     * des Drucks. Damit ermitteln wir
     * zunächst Set + Collector Number.
     */
    const reference =
      await getJson<ScryfallCard>(
        `${API}/cards/cardmarket/${encodeURIComponent(
          match.c
        )}`
      );

    /*
     * Anschließend laden wir ausdrücklich
     * die deutsche Ausgabe desselben Drucks.
     */
    const german =
      await getJson<ScryfallCard>(
        `${API}/cards/${encodeURIComponent(
          reference.set
        )}/${encodeURIComponent(
          reference.collector_number
        )}/de`
      );

    if (
      german.lang !== "de"
    ) {
      return null;
    }

    if (
      normalizeName(
        german.printed_name ??
          german.name
      ) !== key
    ) {
      return null;
    }

    return german;
  } catch {
    return null;
  }
}

/*
 * -----------------------------
 * Suche
 * -----------------------------
 */

export async function searchCards(
  query: string
): Promise<
  ScryfallCard[]
> {
  const original =
    query.trim();

  if (!original) {
    return [];
  }

  const key =
    normalizeName(
      original
    );

  const cacheKey =
    `exact-de-en:${key}`;

  const cached =
    searchCache.get(
      cacheKey
    );

  if (cached) {
    return cached;
  }

  /*
   * Erst prüfen wir den exakten
   * englischen Oracle-Namen.
   *
   * Stone Docent
   * -> englische Karte
   */
  const english =
    await englishExactCard(
      original
    );

  if (english) {
    const result = [
      english
    ];

    searchCache.set(
      cacheKey,
      result
    );

    return result;
  }

  /*
   * Nur falls kein englischer
   * Kartenname exakt passt,
   * prüfen wir den deutschen
   * printed_name-Index.
   *
   * Steinerner Dozent
   * -> deutsche Karte
   */
  const german =
    await germanExactCard(
      original
    );

  const result =
    german
      ? [german]
      : [];

  searchCache.set(
    cacheKey,
    result
  );

  return result;
}

/*
 * -----------------------------
 * Autocomplete DE + EN
 * -----------------------------
 */

export async function autocomplete(
  query: string
): Promise<string[]> {
  const original =
    query.trim();

  if (!original) {
    return [];
  }

  const key =
    normalizeName(
      original
    );

  /*
   * Englische Vorschläge bleiben
   * bei Scryfall und damit schnell.
   */
  const englishPromise =
    getJson<{
      data: string[];
    }>(
      `${API}/cards/autocomplete?q=${encodeURIComponent(
        original
      )}`
    )
      .then(
        result =>
          result.data
      )
      .catch(
        () => []
      );

  /*
   * Deutsche Vorschläge kommen
   * aus dem lokalen Build-Index.
   */
  const germanPromise =
    loadGermanIndex()
      .then(index => {
        const names =
          new Set<string>();

        for (
          const entry
          of index
        ) {
          if (
            normalizeName(
              entry.p
            ).startsWith(
              key
            )
          ) {
            names.add(
              entry.p
            );
          }

          if (
            names.size >=
            8
          ) {
            break;
          }
        }

        return Array.from(
          names
        );
      })
      .catch(
        () => []
      );

  const [
    english,
    german
  ] =
    await Promise.all([
      englishPromise,
      germanPromise
    ]);

  const combined =
    [
      ...german,
      ...english
    ];

  const unique =
    Array.from(
      new Map(
        combined.map(
          name => [
            normalizeName(
              name
            ),
            name
          ]
        )
      ).values()
    );

  return unique.slice(
    0,
    8
  );
}

/*
 * -----------------------------
 * Druckvarianten
 * -----------------------------
 */

export async function getPrintings(
  card: ScryfallCard
): Promise<
  ScryfallCard[]
> {
  const cacheKey =
    card.oracle_id ??
    card.name
      .toLowerCase();

  const cached =
    printingsCache.get(
      cacheKey
    );

  if (cached) {
    return cached;
  }

  if (
    !card.prints_search_uri
  ) {
    return [card];
  }

  const cards:
    ScryfallCard[] = [];

  let nextUrl:
    string |
    undefined =
      card.prints_search_uri;

  while (nextUrl) {
    const result:
      SearchResponse =
        await getJson<SearchResponse>(
          nextUrl
        );

    /*
     * Nur Deutsch und Englisch
     * in der Variantenauswahl.
     */
    cards.push(
      ...result.data.filter(
        candidate =>
          candidate.lang ===
            "en" ||
          candidate.lang ===
            "de"
      )
    );

    nextUrl =
      result.has_more &&
      result.next_page
        ? result.next_page
        : undefined;
  }

  const sorted =
    cards.sort(
      (a, b) => {
        const setCompare =
          (
            a.set_name ??
            a.set
          ).localeCompare(
            b.set_name ??
              b.set
          );

        if (
          setCompare !== 0
        ) {
          return setCompare;
        }

        const numberCompare =
          a.collector_number
            .localeCompare(
              b.collector_number,
              undefined,
              {
                numeric: true
              }
            );

        if (
          numberCompare !==
          0
        ) {
          return numberCompare;
        }

        if (
          a.lang ===
          b.lang
        ) {
          return 0;
        }

        return a.lang ===
          "de"
          ? -1
          : 1;
      }
    );

  printingsCache.set(
    cacheKey,
    sorted
  );

  sorted.forEach(
    c =>
      cache.set(
        c.id,
        normalizeCard(c)
      )
  );

  return sorted;
}

/*
 * -----------------------------
 * Sammlung kanonisch Englisch
 * -----------------------------
 */

export async function canonicalEnglishCard(
  card: ScryfallCard
): Promise<ScryfallCard> {
  if (
    !card.lang ||
    card.lang === "en"
  ) {
    return card;
  }

  try {
    return await getJson<ScryfallCard>(
      `${API}/cards/${encodeURIComponent(
        card.set
      )}/${encodeURIComponent(
        card.collector_number
      )}/en`
    );
  } catch {
    return card;
  }
}

/*
 * -----------------------------
 * Einzelkarte laden
 * -----------------------------
 */

export async function getCard(
  id: string
): Promise<CardRecord> {
  const hit =
    cache.get(id);

  if (hit) {
    return hit;
  }

  const card =
    await getJson<ScryfallCard>(
      `${API}/cards/${encodeURIComponent(
        id
      )}`
    );

  const normalized =
    normalizeCard(card);

  cache.set(
    id,
    normalized
  );

  return normalized;
}

export function scryfallUrl(
  id: string
) {
  return `https://scryfall.com/card/${id}`;
}
