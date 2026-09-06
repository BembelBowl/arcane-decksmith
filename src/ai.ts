import { auth } from "./firebase";
import { loadCollection } from "./db";
import type { CardRecord, DeckRecord } from "./types";

const AI_WORKER_URL = "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";
const MAX_ANALYSIS_LENGTH = 10500;
const EMPTY_RESPONSE_RETRIES = 1;
const RETRY_DELAY_MS = 700;
const SCRYFALL_REQUEST_DELAY_MS = 120;
const PURCHASE_CONTEXT_LIMIT = 2600;
const SCRYFALL_SEARCH_URL = "https://api.scryfall.com/cards/search";

interface ScryfallCandidateCard {
  id: string;
  name: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  color_identity?: string[];
  legalities?: Record<string, string>;
}

interface ScryfallSearchResponse {
  data?: ScryfallCandidateCard[];
}

interface PurchaseCandidate {
  id: string;
  name: string;
  category: string;
  manaValue: number;
  typeLine: string;
  oracleText: string;
}

type CardTokenKind = "commander" | "deck" | "purchase";

interface CardTokenEntry {
  token: string;
  name: string;
  kind: CardTokenKind;
}

interface AiRequestContext {
  analysis: string;
  cardMap: Record<string, string>;
  purchaseCandidates: PurchaseCandidate[];
  deckNames: string[];
}

interface WorkerResponse {
  explanation?: string;
  error?: string;
}

let lastScryfallRequestAt = 0;

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchScryfallCandidates(
  query: string,
  order: "edhrec" | "cmc"
): Promise<ScryfallCandidateCard[]> {
  const elapsed = Date.now() - lastScryfallRequestAt;
  const delay = Math.max(0, SCRYFALL_REQUEST_DELAY_MS - elapsed);

  if (delay > 0) {
    await wait(delay);
  }

  lastScryfallRequestAt = Date.now();

  const params = new URLSearchParams({
    q: query,
    unique: "cards",
    order
  });

  let response: Response;

  try {
    response = await fetch(`${SCRYFALL_SEARCH_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/json;q=0.9,*/*;q=0.8"
      }
    });
  } catch {
    return [];
  }

  if (response.status === 404 || !response.ok) {
    return [];
  }

  try {
    const data = (await response.json()) as ScryfallSearchResponse;
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

function countMainDeckCards(deck: DeckRecord): number {
  return deck.cards.reduce((total, card) => total + card.count, 0);
}

function commanderCount(deck: DeckRecord): number {
  return deck.format === "commander" ? deck.commanderIds.length : 0;
}

function isLand(typeLine: string | undefined): boolean {
  return /\bLand\b/i.test(typeLine ?? "");
}

function averageManaValue(deck: DeckRecord): number {
  let totalManaValue = 0;
  let cardCount = 0;

  for (const card of deck.cards) {
    if (isLand(card.typeLine)) {
      continue;
    }

    totalManaValue += (card.manaValue ?? 0) * card.count;
    cardCount += card.count;
  }

  return cardCount === 0 ? 0 : totalManaValue / cardCount;
}

function manaCurve(deck: DeckRecord): number[] {
  const curve = Array<number>(8).fill(0);

  for (const card of deck.cards) {
    if (isLand(card.typeLine)) {
      continue;
    }

    const manaValue = Math.floor(card.manaValue ?? 0);
    const index = Math.min(Math.max(manaValue, 0), 7);
    curve[index] += card.count;
  }

  return curve;
}

function manaCurveText(deck: DeckRecord): string {
  return manaCurve(deck)
    .map((count, index) =>
      index === 7
        ? `MV 7+: ${count}`
        : `MV ${index}: ${count}`
    )
    .join(" | ");
}

function roleCounts(deck: DeckRecord): Record<string, number> {
  const result: Record<string, number> = {};

  for (const card of deck.cards) {
    const role = card.role || "Unbekannt";
    result[role] = (result[role] ?? 0) + card.count;
  }

  return result;
}

function rolesText(deck: DeckRecord): string {
  const entries = Object.entries(roleCounts(deck)).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );

  return entries.length > 0
    ? entries
        .map(([role, count]) => `${role}: ${count}`)
        .join(" | ")
    : "Keine Rollen vorhanden.";
}

function typeCounts(deck: DeckRecord) {
  const result = {
    lands: 0,
    creatures: 0,
    artifacts: 0,
    enchantments: 0,
    instants: 0,
    sorceries: 0,
    planeswalkers: 0
  };

  for (const card of deck.cards) {
    const line = card.typeLine ?? "";

    if (/\bLand\b/i.test(line)) {
      result.lands += card.count;
    }

    if (/\bCreature\b/i.test(line)) {
      result.creatures += card.count;
    }

    if (/\bArtifact\b/i.test(line)) {
      result.artifacts += card.count;
    }

    if (/\bEnchantment\b/i.test(line)) {
      result.enchantments += card.count;
    }

    if (/\bInstant\b/i.test(line)) {
      result.instants += card.count;
    }

    if (/\bSorcery\b/i.test(line)) {
      result.sorceries += card.count;
    }

    if (/\bPlaneswalker\b/i.test(line)) {
      result.planeswalkers += card.count;
    }
  }

  return result;
}

export function generateDeckExplanation(deck: DeckRecord): string {
  const mainDeck = countMainDeckCards(deck);
  const commanders = commanderCount(deck);
  const total = mainDeck + commanders;
  const types = typeCounts(deck);
  const nonlands = mainDeck - types.lands;
  const averageMv = averageManaValue(deck);

  const targetManaValue =
    typeof deck.targetManaValue === "number"
      ? deck.targetManaValue.toFixed(1)
      : "Nicht angegeben";

  return [
    `Deck: ${deck.name}`,
    `Format: ${deck.format}`,
    `Karten gesamt inklusive Commander: ${total}`,
    `Hauptdeck: ${mainDeck}`,
    `Commander: ${commanders}`,
    `Länder: ${types.lands}`,
    `Nichtländer: ${nonlands}`,
    `Kreaturen: ${types.creatures}`,
    `Artefakte: ${types.artifacts}`,
    `Verzauberungen: ${types.enchantments}`,
    `Spontanzauber: ${types.instants}`,
    `Hexereien: ${types.sorceries}`,
    `Planeswalker: ${types.planeswalkers}`,
    `Durchschnittlicher Mana Value: ${averageMv.toFixed(2)}`,
    `Ziel-Mana-Value: ${targetManaValue}`,
    `Deck-Score: ${deck.score ?? "Nicht angegeben"}`,
    "",
    "Mana-Kurve:",
    manaCurveText(deck),
    "",
    "Kartenrollen:",
    rolesText(deck)
  ].join("\n");
}

function colorIdentityText(colors: string[]): string {
  const names: Record<string, string> = {
    W: "Weiß",
    U: "Blau",
    B: "Schwarz",
    R: "Rot",
    G: "Grün"
  };

  if (colors.length === 0) {
    return "Farblos";
  }

  return colors
    .map(color => names[color] ?? color)
    .join(", ");
}

function technicalDeckData(deck: DeckRecord): string {
  const mainDeck = countMainDeckCards(deck);
  const commanders = commanderCount(deck);
  const types = typeCounts(deck);

  const targetManaValue =
    typeof deck.targetManaValue === "number"
      ? deck.targetManaValue.toFixed(1)
      : "Nicht angegeben";

  return [
    `Format: ${deck.format}`,
    `Farbidentität des Decks: ${colorIdentityText(deck.colors)}`,
    `Karten gesamt inklusive Commander: ${mainDeck + commanders}`,
    `Hauptdeck: ${mainDeck}`,
    `Commander-Anzahl: ${commanders}`,
    `Länder: ${types.lands}`,
    `Nichtländer: ${mainDeck - types.lands}`,
    `Kreaturen: ${types.creatures}`,
    `Artefakte: ${types.artifacts}`,
    `Verzauberungen: ${types.enchantments}`,
    `Spontanzauber: ${types.instants}`,
    `Hexereien: ${types.sorceries}`,
    `Planeswalker: ${types.planeswalkers}`,
    `Durchschnittlicher Mana Value: ${averageManaValue(deck).toFixed(2)}`,
    `Ziel-Mana-Value: ${targetManaValue}`,
    `Deck-Score: ${deck.score ?? "Nicht angegeben"}`,
    `Mana-Kurve: ${manaCurveText(deck)}`,
    `Kartenrollen: ${rolesText(deck)}`
  ].join("\n");
}

function shorten(
  value: string,
  maxLength: number
): string {
  const clean = value
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  return (
    clean
      .slice(
        0,
        Math.max(
          0,
          maxLength - 1
        )
      )
      .trimEnd() + "…"
  );
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US");
}

function findCollectionCard(
  id: string,
  name: string,
  collection: CardRecord[]
): CardRecord | undefined {
  return (
    collection.find(
      card => card.id === id
    ) ??
    collection.find(
      card =>
        normalizeName(card.name) ===
        normalizeName(name)
    )
  );
}

function tokenFor(
  prefix: "C" | "D" | "P",
  index: number
): string {
  return `[[${prefix}${String(index + 1).padStart(3, "0")}]]`;
}

function commanderTokenEntries(
  deck: DeckRecord,
  collection: CardRecord[]
): CardTokenEntry[] {
  if (deck.format !== "commander") {
    return [];
  }

  return deck.commanderIds.map(
    (commanderId, index) => {
      const card = collection.find(
        item => item.id === commanderId
      );

      return {
        token: tokenFor(
          "C",
          index
        ),
        name:
          card?.name ??
          `Commander ${index + 1}`,
        kind: "commander"
      };
    }
  );
}

function deckTokenEntries(
  deck: DeckRecord
): CardTokenEntry[] {
  return deck.cards.map(
    (card, index) => ({
      token: tokenFor(
        "D",
        index
      ),
      name: card.name,
      kind: "deck"
    })
  );
}

function purchaseTokenEntries(
  candidates: PurchaseCandidate[]
): CardTokenEntry[] {
  return candidates.map(
    (candidate, index) => ({
      token: tokenFor(
        "P",
        index
      ),
      name: candidate.name,
      kind: "purchase"
    })
  );
}

function tokenizeKnownNames(
  value: string,
  entries: CardTokenEntry[]
): string {
  let result = value;

  const sorted = [...entries].sort(
    (a, b) =>
      b.name.length -
      a.name.length
  );

  for (const entry of sorted) {
    const name = entry.name.trim();

    if (!name) {
      continue;
    }

    result = result
      .split(name)
      .join(entry.token);
  }

  return result;
}

function commanderContext(
  deck: DeckRecord,
  collection: CardRecord[],
  commanderEntries: CardTokenEntry[],
  allEntries: CardTokenEntry[]
): string {
  if (deck.format !== "commander") {
    return "Kein Commander-Format.";
  }

  if (deck.commanderIds.length === 0) {
    return "Keine Commander-Daten vorhanden.";
  }

  return deck.commanderIds
    .map(
      (commanderId, index) => {
        const token =
          commanderEntries[index]?.token ??
          tokenFor(
            "C",
            index
          );

        const card = collection.find(
          item =>
            item.id === commanderId
        );

        if (!card) {
          return (
            `${token} | ` +
            "Weitere Kartendaten nicht verfügbar."
          );
        }

        const parts = [
          token,
          `Typ ${card.typeLine || "unbekannt"}`,
          `MV ${card.manaValue}`,
          `Farbidentität ${
            (card.colorIdentity ?? []).join("") ||
            "C"
          }`
        ];

        if (card.oracleText?.trim()) {
          parts.push(
            `Oracle ${shorten(
              tokenizeKnownNames(
                card.oracleText,
                allEntries
              ),
              430
            )}`
          );
        }

        return parts.join(" | ");
      }
    )
    .join("\n");
}

function deckCardTokenLine(
  deckCard: DeckRecord["cards"][number],
  token: string,
  collection: CardRecord[],
  allEntries: CardTokenEntry[],
  oracleLength: number
): string {
  const card = findCollectionCard(
    deckCard.id,
    deckCard.name,
    collection
  );

  const parts = [
    token,
    `Anzahl ${deckCard.count}`,
    `MV ${deckCard.manaValue}`,
    `Rolle ${
      deckCard.role ||
      "Unbekannt"
    }`,
    `Typ ${
      deckCard.typeLine ||
      card?.typeLine ||
      "unbekannt"
    }`
  ];

  const oracle =
    card?.oracleText?.trim();

  if (
    oracle &&
    oracleLength > 0
  ) {
    parts.push(
      `Oracle ${shorten(
        tokenizeKnownNames(
          oracle,
          allEntries
        ),
        oracleLength
      )}`
    );
  }

  if (deckCard.reason?.trim()) {
    parts.push(
      `Builder-Grund ${shorten(
        tokenizeKnownNames(
          deckCard.reason,
          allEntries
        ),
        120
      )}`
    );
  }

  return parts.join(" | ");
}

function fullDeckOverview(
  deck: DeckRecord,
  deckEntries: CardTokenEntry[]
): string {
  const lines = deck.cards.map(
    (card, index) =>
      [
        deckEntries[index].token,
        `x${card.count}`,
        `MV${card.manaValue}`,
        `Rolle:${
          card.role ||
          "Unbekannt"
        }`
      ].join(" | ")
  );

  return [
    "VOLLSTÄNDIGE DECKÜBERSICHT",
    "Jede tatsächliche Hauptdeckkarte ist hier genau einmal als D-Kennung aufgeführt. Diese Liste wird niemals gekürzt.",
    ...lines
  ].join("\n");
}

function detailPriority(
  role: string
): number {
  const priorities:
    Record<string, number> = {
      Synergie: 100,
      "Card Advantage": 95,
      Interaction: 90,
      Ramp: 85,
      Protection: 80,
      Recursion: 75,
      Boardwipe: 70,
      Finisher: 65,
      Tutor: 60,
      Value: 50,
      Creature: 40,
      Land: 0
    };

  return priorities[role] ?? 30;
}

function prioritizedDeckDetails(
  deck: DeckRecord,
  collection: CardRecord[],
  deckEntries: CardTokenEntry[],
  allEntries: CardTokenEntry[],
  maxLength: number
): string {
  const header = [
    "PRIORISIERTE KARTENDETAILS",
    "Nur Karten mit hier vorhandenem Oracle-Text dürfen mit einem konkreten Karteneffekt beschrieben werden.",
    "Nicht aufgeführte D-Kennungen bleiben trotzdem über die vollständige Deckübersicht als Deckkarten bestätigt.",
    ""
  ].join("\n");

  const ordered = deck.cards
    .map(
      (card, index) => ({
        card,
        index,
        priority:
          detailPriority(
            card.role ||
            "Unbekannt"
          )
      })
    )
    .filter(
      item =>
        !isLand(
          item.card.typeLine
        )
    )
    .sort(
      (a, b) =>
        b.priority -
          a.priority ||
        a.card.manaValue -
          b.card.manaValue ||
        a.index -
          b.index
    );

  const oracleLevels = [
    180,
    130,
    90
  ];

  for (
    const oracleLength
    of oracleLevels
  ) {
    const lines: string[] = [];
    let length = header.length;

    for (const item of ordered) {
      const line = deckCardTokenLine(
        item.card,
        deckEntries[item.index].token,
        collection,
        allEntries,
        oracleLength
      );

      if (
        length +
          line.length +
          1 >
        maxLength
      ) {
        break;
      }

      lines.push(line);
      length +=
        line.length +
        1;
    }

    if (lines.length > 0) {
      return [
        header,
        ...lines
      ].join("\n");
    }
  }

  return (
    header +
    "Keine zusätzlichen Kartendetails passen in das sichere Größenlimit."
  );
}

function purchaseRoleTargets(
  deck: DeckRecord
): Array<{
  category: string;
  roleName: string;
  target: number;
  query: string;
}> {
  const commander =
    deck.format ===
    "commander";

  return [
    {
      category: "Ramp",
      roleName: "Ramp",
      target:
        commander
          ? 10
          : 3,
      query:
        '(o:"add one mana" OR o:"search your library for a basic land")'
    },
    {
      category: "Card Draw",
      roleName:
        "Card Advantage",
      target:
        commander
          ? 10
          : 6,
      query:
        '(o:"draw a card" OR o:"draw two cards" OR o:"draw three cards")'
    },
    {
      category:
        "Interaktion",
      roleName:
        "Interaction",
      target:
        commander
          ? 8
          : 7,
      query:
        '(o:"destroy target" OR o:"exile target" OR o:"counter target")'
    },
    {
      category:
        "Boardwipe",
      roleName:
        "Boardwipe",
      target:
        commander
          ? 3
          : 2,
      query:
        '(o:"destroy all" OR o:"exile all")'
    },
    {
      category:
        "Schutz",
      roleName:
        "Protection",
      target:
        commander
          ? 3
          : 2,
      query:
        '(o:"indestructible" OR o:"hexproof" OR o:"phase out")'
    },
    {
      category:
        "Recursion",
      roleName:
        "Recursion",
      target:
        commander
          ? 3
          : 1,
      query:
        'o:"from your graveyard"'
    }
  ];
}

function deckRoleCount(
  deck: DeckRecord,
  role: string
): number {
  return deck.cards
    .filter(
      card =>
        card.role ===
        role
    )
    .reduce(
      (sum, card) =>
        sum +
        card.count,
      0
    );
}

function candidateIdentityAllowed(
  candidate: ScryfallCandidateCard,
  deck: DeckRecord
): boolean {
  if (
    deck.format !==
    "commander"
  ) {
    return true;
  }

  const deckColors =
    new Set(
      deck.colors
    );

  return (
    candidate.color_identity ??
    []
  ).every(
    color =>
      deckColors.has(
        color
      )
  );
}

function candidateLegal(
  candidate: ScryfallCandidateCard,
  deck: DeckRecord
): boolean {
  return deck.format ===
    "commander"
    ? candidate.legalities
        ?.commander ===
        "legal"
    : candidate.legalities
        ?.standard ===
        "legal";
}

async function verifiedPurchaseCandidates(
  deck: DeckRecord,
  collection: CardRecord[]
): Promise<PurchaseCandidate[]> {
  const ownedNames =
    new Set(
      collection.map(
        card =>
          normalizeName(
            card.name
          )
      )
    );

  const deckNames =
    new Set(
      deck.cards.map(
        card =>
          normalizeName(
            card.name
          )
      )
    );

  for (
    const commanderId
    of deck.commanderIds
  ) {
    const commander =
      collection.find(
        card =>
          card.id ===
          commanderId
      );

    if (commander) {
      deckNames.add(
        normalizeName(
          commander.name
        )
      );
    }
  }

  const colors =
    deck.colors.length > 0
      ? deck.colors.join("")
      : "C";

  const formatQuery =
    deck.format ===
    "commander"
      ? "f:commander"
      : "f:standard";

  const identityQuery =
    deck.colors.length > 0
      ? `id<=${colors}`
      : "id=c";

  const roleTargets =
    purchaseRoleTargets(
      deck
    )
      .map(
        item => ({
          ...item,
          deficit:
            Math.max(
              0,
              item.target -
                deckRoleCount(
                  deck,
                  item.roleName
                )
            )
        })
      )
      .sort(
        (a, b) =>
          b.deficit -
            a.deficit ||
          a.category.localeCompare(
            b.category
          )
      );

  const result:
    PurchaseCandidate[] = [];

  const seenNames =
    new Set<string>();

  for (
    const role
    of roleTargets
  ) {
    const query = [
      formatQuery,
      identityQuery,
      "game:paper",
      "-t:land",
      role.query
    ].join(" ");

    const cards =
      await searchScryfallCandidates(
        query,
        deck.format ===
          "commander"
          ? "edhrec"
          : "cmc"
      );

    let addedForRole = 0;

    for (const card of cards) {
      if (
        addedForRole >= 1
      ) {
        break;
      }

      const nameKey =
        normalizeName(
          card.name
        );

      if (
        !nameKey ||
        ownedNames.has(
          nameKey
        ) ||
        deckNames.has(
          nameKey
        ) ||
        seenNames.has(
          nameKey
        ) ||
        !candidateLegal(
          card,
          deck
        ) ||
        !candidateIdentityAllowed(
          card,
          deck
        )
      ) {
        continue;
      }

      const oracleText =
        card.oracle_text
          ?.trim();

      if (!oracleText) {
        continue;
      }

      result.push({
        id: card.id,
        name: card.name,
        category:
          role.category,
        manaValue:
          Number(
            card.cmc ??
            0
          ),
        typeLine:
          card.type_line ??
          "Typ unbekannt",
        oracleText
      });

      seenNames.add(
        nameKey
      );

      addedForRole += 1;
    }
  }

  return result;
}

function purchaseCandidateContext(
  candidates: PurchaseCandidate[],
  purchaseEntries: CardTokenEntry[],
  allEntries: CardTokenEntry[],
  maxLength: number
): string {
  const header = [
    "SCRYFALL-VERIFIZIERTE OPTIONALE ANSCHAFFUNGSKANDIDATEN",
    "P-Kennungen sind keine Deckkarten.",
    "Sie wurden vorab über Scryfall auf Existenz, Formatlegalität, Farbidentität bei Commander und Nichtbesitz geprüft.",
    "Nur P-Kennungen aus diesem Abschnitt dürfen unter 'Optionale Anschaffungen' empfohlen werden.",
    ""
  ].join("\n");

  if (
    candidates.length === 0
  ) {
    return (
      header +
      "Keine verifizierten Anschaffungskandidaten verfügbar."
    );
  }

  const lines: string[] = [];
  let length =
    header.length;

  for (
    let index = 0;
    index <
      candidates.length;
    index += 1
  ) {
    const candidate =
      candidates[index];

    const token =
      purchaseEntries[index]
        .token;

    const line = [
      token,
      `Kategorie ${candidate.category}`,
      `MV ${candidate.manaValue}`,
      `Typ ${candidate.typeLine}`,
      `Oracle ${shorten(
        tokenizeKnownNames(
          candidate.oracleText,
          allEntries
        ),
        230
      )}`
    ].join(" | ");

    if (
      length +
        line.length +
        1 >
      maxLength
    ) {
      break;
    }

    lines.push(line);

    length +=
      line.length +
      1;
  }

  return [
    header,
    ...lines
  ].join("\n");
}

function analysisRules(): string {
  return [
    "DATENREGELN FÜR DIE ANALYSE",
    "C-Kennungen = Commander, D-Kennungen = tatsächliche Deckkarten, P-Kennungen = ausschließlich verifizierte optionale Anschaffungskandidaten.",
    "Die vollständige D-Kennungsliste ist autoritativ für die Deckzugehörigkeit und wird nicht gekürzt.",
    "Konkrete Karteneffekte dürfen nur aus ausdrücklich geliefertem Oracle-Text abgeleitet werden.",
    "Kartennamen sind absichtlich nicht Teil der Modelldaten; konkrete Karten dürfen nur über Kennungen referenziert werden.",
    "P-Kennungen gehören niemals zum fertigen Deck und dürfen nur unter 'Optionale Anschaffungen' verwendet werden.",
    "Die eigentlichen Ausgabe- und Validierungsregeln werden zusätzlich serverseitig erzwungen."
  ].join("\n");
}

function authoritativeTokenList(
  commanderEntries: CardTokenEntry[],
  deckEntries: CardTokenEntry[],
  purchaseEntries: CardTokenEntry[]
): string {
  return [
    "AUTORITATIVE KENNUNGSLISTEN",
    `Commander: ${
      commanderEntries.length >
      0
        ? commanderEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,
    `Deckkarten: ${
      deckEntries.length >
      0
        ? deckEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,
    `Anschaffungskandidaten: ${
      purchaseEntries.length >
      0
        ? purchaseEntries
            .map(
              entry =>
                entry.token
            )
            .join(", ")
        : "keine"
    }`,
    "Diese Listen sind vollständig und dürfen nicht durch Modellwissen ergänzt werden."
  ].join("\n");
}

function cardMapFromEntries(
  entries: CardTokenEntry[]
): Record<string, string> {
  return Object.fromEntries(
    entries.map(
      entry => [
        entry.token,
        entry.name
      ]
    )
  );
}

function uniqueDeckNames(
  entries: CardTokenEntry[]
): string[] {
  return Array.from(
    new Set(
      entries
        .filter(
          entry =>
            entry.kind !==
            "purchase"
        )
        .map(
          entry =>
            entry.name.trim()
        )
        .filter(Boolean)
    )
  );
}

async function createAiRequestContext(
  deck: DeckRecord,
  collection: CardRecord[]
): Promise<AiRequestContext> {
  const purchaseCandidates =
    await verifiedPurchaseCandidates(
      deck,
      collection
    );

  const commanderEntries =
    commanderTokenEntries(
      deck,
      collection
    );

  const deckEntries =
    deckTokenEntries(
      deck
    );

  const purchaseEntries =
    purchaseTokenEntries(
      purchaseCandidates
    );

  const allEntries = [
    ...commanderEntries,
    ...deckEntries,
    ...purchaseEntries
  ];

  const purchaseContext =
    purchaseCandidateContext(
      purchaseCandidates,
      purchaseEntries,
      allEntries,
      PURCHASE_CONTEXT_LIMIT
    );

  const fixedSections = [
    analysisRules(),
    "",
    authoritativeTokenList(
      commanderEntries,
      deckEntries,
      purchaseEntries
    ),
    "",
    "TECHNISCHE DECKDATEN",
    technicalDeckData(
      deck
    ),
    "",
    "COMMANDER-INFORMATION",
    commanderContext(
      deck,
      collection,
      commanderEntries,
      allEntries
    ),
    "",
    purchaseContext,
    ""
  ].join("\n");

  const overview =
    fullDeckOverview(
      deck,
      deckEntries
    );

  const detailBudget =
    MAX_ANALYSIS_LENGTH -
    fixedSections.length -
    overview.length -
    2;

  if (
    detailBudget < 500
  ) {
    throw new Error(
      "Die KI-Deckdaten sind zu groß, um sie zuverlässig und vollständig zu analysieren."
    );
  }

  const details =
    prioritizedDeckDetails(
      deck,
      collection,
      deckEntries,
      allEntries,
      detailBudget
    );

  const analysis = [
    fixedSections,
    overview,
    "",
    details
  ].join("\n");

  if (
    analysis.length >
    MAX_ANALYSIS_LENGTH
  ) {
    throw new Error(
      "Die KI-Deckdaten überschreiten das sichere Größenlimit."
    );
  }

  return {
    analysis,
    cardMap:
      cardMapFromEntries(
        allEntries
      ),
    purchaseCandidates,
    deckNames:
      uniqueDeckNames(
        allEntries
      )
  };
}

async function readWorkerResponse(
  response: Response
): Promise<WorkerResponse> {
  try {
    return (
      await response.json()
    ) as WorkerResponse;
  } catch {
    throw new Error(
      "Der KI-Dienst hat eine ungültige Antwort geliefert."
    );
  }
}

function workerError(
  response: Response,
  data: WorkerResponse
): Error {
  if (
    response.status === 429
  ) {
    return new Error(
      data.error ||
        "Das KI-Limit wurde gerade erreicht. Bitte versuche es später erneut."
    );
  }

  if (
    response.status === 401 ||
    response.status === 403
  ) {
    return new Error(
      data.error ||
        "Die Anmeldung für den KI-Dienst konnte nicht bestätigt werden."
    );
  }

  if (
    response.status >= 500
  ) {
    return new Error(
      data.error ||
        "Der KI-Dienst ist momentan nicht verfügbar."
    );
  }

  return new Error(
    data.error ||
      `Die KI-Anfrage ist fehlgeschlagen (${response.status}).`
  );
}

async function requestAiExplanation(
  idToken: string,
  context: AiRequestContext
): Promise<string | null> {
  let response: Response;

  try {
    response = await fetch(
      AI_WORKER_URL,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            `Bearer ${idToken}`
        },
        body:
          JSON.stringify({
            analysis:
              context.analysis,
            cardMap:
              context.cardMap
          })
      }
    );
  } catch {
    throw new Error(
      "Der KI-Dienst konnte nicht erreicht werden. " +
        "Bitte prüfe deine Internetverbindung und versuche es erneut."
    );
  }

  const data =
    await readWorkerResponse(
      response
    );

  if (!response.ok) {
    throw workerError(
      response,
      data
    );
  }

  if (
    typeof data.explanation !==
      "string" ||
    !data.explanation.trim()
  ) {
    return null;
  }

  return data.explanation.trim();
}

function optionalPurchaseSection(
  explanation: string
): {
  before: string;
  section: string;
} {
  const heading =
    "### Optionale Anschaffungen";

  const start =
    explanation.indexOf(
      heading
    );

  if (start < 0) {
    return {
      before:
        explanation,
      section: ""
    };
  }

  const afterStart =
    start +
    heading.length;

  const nextHeading =
    explanation.indexOf(
      "\n### ",
      afterStart
    );

  const end =
    nextHeading < 0
      ? explanation.length
      : nextHeading;

  return {
    before:
      explanation.slice(
        0,
        start
      ),
    section:
      explanation.slice(
        start,
        end
      )
  };
}

function containsName(
  text: string,
  name: string
): boolean {
  const normalizedText =
    text.toLocaleLowerCase(
      "en-US"
    );

  const normalizedName =
    normalizeName(
      name
    );

  return (
    normalizedName.length >
      0 &&
    normalizedText.includes(
      normalizedName
    )
  );
}

function stripMarkdownEmphasis(
  value: string
): string {
  return value
    .replace(
      /^[*_`\s]+/,
      ""
    )
    .replace(
      /[*_`\s]+$/,
      ""
    )
    .replace(
      /\\([\\`*_{}\[\]<>])/g,
      "$1"
    )
    .trim();
}

function validateRenderedExplanation(
  explanation: string,
  context: AiRequestContext
): string | null {
  if (
    /\[\[(?:C|D|P)\d{3}\]\]/.test(
      explanation
    )
  ) {
    return (
      "Die KI-Antwort enthält nicht aufgelöste Kartenkennungen."
    );
  }

  const {
    before,
    section
  } =
    optionalPurchaseSection(
      explanation
    );

  for (
    const candidate
    of context.purchaseCandidates
  ) {
    if (
      containsName(
        before,
        candidate.name
      )
    ) {
      return (
        "Eine optionale Anschaffung wurde außerhalb des Anschaffungsabschnitts als Deckkarte verwendet: " +
        candidate.name
      );
    }
  }

  const candidateNames =
    new Map(
      context
        .purchaseCandidates
        .map(
          candidate => [
            normalizeName(
              candidate.name
            ),
            candidate.name
          ]
        )
    );

  const purchaseHeadingPattern =
    /^\s*(?:[-+]\s*)?\*\*(.+?)\s+—\s+Nicht in deiner Sammlung\*\*\s*$/gm;

  const recommendedNames:
    string[] = [];

  const markedPurchaseLines =
    section
      .split("\n")
      .filter(
        line =>
          /Nicht in deiner Sammlung/i.test(
            line
          )
      );

  for (
    const line
    of markedPurchaseLines
  ) {
    const lineMatch =
      line.match(
        /^\s*(?:[-+]\s*)?\*\*(.+?)\s+—\s+Nicht in deiner Sammlung\*\*\s*$/
      );

    if (!lineMatch) {
      return (
        "Eine Anschaffungsempfehlung hat nicht das vorgeschriebene verifizierbare Format."
      );
    }
  }

  for (
    const match
    of section.matchAll(
      purchaseHeadingPattern
    )
  ) {
    const renderedName =
      stripMarkdownEmphasis(
        match[1]
      );

    if (
      !candidateNames.has(
        normalizeName(
          renderedName
        )
      )
    ) {
      return (
        "Die KI hat eine nicht verifizierte Anschaffung genannt: " +
        renderedName
      );
    }

    recommendedNames.push(
      renderedName
    );
  }

  if (
    recommendedNames.length >
    3
  ) {
    return (
      "Die KI hat mehr als drei optionale Anschaffungen empfohlen."
    );
  }

  const uniqueRecommendations =
    new Set(
      recommendedNames.map(
        normalizeName
      )
    );

  if (
    uniqueRecommendations.size !==
    recommendedNames.length
  ) {
    return (
      "Die KI hat dieselbe optionale Anschaffung mehrfach empfohlen."
    );
  }

  const replacementPattern =
    /Möglicher Ersatz für:\s*([^\n]+)/gi;

  const allowedDeckNames =
    new Set(
      context.deckNames.map(
        normalizeName
      )
    );

  for (
    const match
    of section.matchAll(
      replacementPattern
    )
  ) {
    const value =
      stripMarkdownEmphasis(
        match[1]
      )
        .replace(
          /[.!]+$/,
          ""
        )
        .trim();

    if (
      !value ||
      /^keine\b/i.test(
        value
      )
    ) {
      continue;
    }

    if (
      !allowedDeckNames.has(
        normalizeName(
          value
        )
      )
    ) {
      return (
        "Die KI hat als möglichen Ersatz eine Karte genannt, die nicht im fertigen Deck steht: " +
        value
      );
    }
  }

  return null;
}

export async function generateAiDeckExplanation(
  deck: DeckRecord
): Promise<string> {
  const user =
    auth?.currentUser;

  if (!user) {
    throw new Error(
      "Du musst angemeldet sein, um die KI-Analyse zu verwenden."
    );
  }

  const [
    idToken,
    collection
  ] =
    await Promise.all([
      user.getIdToken(),
      loadCollection(
        user.uid
      )
    ]);

  const context =
    await createAiRequestContext(
      deck,
      collection
    );

  let lastValidationError:
    string | null =
    null;

  for (
    let attempt = 0;
    attempt <=
      EMPTY_RESPONSE_RETRIES;
    attempt += 1
  ) {
    const explanation =
      await requestAiExplanation(
        idToken,
        context
      );

    if (explanation) {
      const validationError =
        validateRenderedExplanation(
          explanation,
          context
        );

      if (!validationError) {
        return explanation;
      }

      lastValidationError =
        validationError;
    }

    if (
      attempt <
      EMPTY_RESPONSE_RETRIES
    ) {
      await wait(
        RETRY_DELAY_MS
      );
    }
  }

  if (lastValidationError) {
    throw new Error(
      "Die generative KI hat auch nach einem automatischen Korrekturversuch keine konsistente Deckanalyse geliefert. " +
        lastValidationError
    );
  }

  throw new Error(
    "Die generative KI hat auch nach einem automatischen zweiten Versuch keine Deckanalyse zurückgegeben."
  );
}
