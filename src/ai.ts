import { auth } from "./firebase";
import { loadCollection } from "./db";
import type {
  CardRecord,
  DeckRecord
} from "./types";

const AI_WORKER_URL =
  "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";

const MAX_ANALYSIS_LENGTH = 10500;
const EMPTY_RESPONSE_RETRIES = 1;
const RETRY_DELAY_MS = 700;

function countMainDeckCards(
  deck: DeckRecord
): number {
  return deck.cards.reduce(
    (total, card) =>
      total + card.count,
    0
  );
}

function commanderCount(
  deck: DeckRecord
): number {
  return deck.format === "commander"
    ? deck.commanderIds.length
    : 0;
}

function isLand(
  typeLine: string | undefined
): boolean {
  return /\bLand\b/i.test(
    typeLine ?? ""
  );
}

function averageManaValue(
  deck: DeckRecord
): number {
  let totalManaValue = 0;
  let cardCount = 0;

  for (const card of deck.cards) {
    if (isLand(card.typeLine)) {
      continue;
    }

    totalManaValue +=
      (card.manaValue ?? 0) *
      card.count;

    cardCount += card.count;
  }

  return cardCount === 0
    ? 0
    : totalManaValue /
        cardCount;
}

function manaCurve(
  deck: DeckRecord
): number[] {
  const curve =
    Array<number>(8).fill(0);

  for (const card of deck.cards) {
    if (isLand(card.typeLine)) {
      continue;
    }

    const manaValue =
      Math.floor(
        card.manaValue ?? 0
      );

    const index =
      Math.min(
        Math.max(
          manaValue,
          0
        ),
        7
      );

    curve[index] +=
      card.count;
  }

  return curve;
}

function manaCurveText(
  deck: DeckRecord
): string {
  const curve =
    manaCurve(deck);

  return curve
    .map(
      (count, index) =>
        index === 7
          ? `MV 7+: ${count}`
          : `MV ${index}: ${count}`
    )
    .join(" | ");
}

function roleCounts(
  deck: DeckRecord
): Record<string, number> {
  const result:
    Record<string, number> = {};

  for (const card of deck.cards) {
    const role =
      card.role || "Unbekannt";

    result[role] =
      (result[role] ?? 0) +
      card.count;
  }

  return result;
}

function rolesText(
  deck: DeckRecord
): string {
  const counts =
    roleCounts(deck);

  const entries =
    Object.entries(counts)
      .sort(
        (a, b) =>
          b[1] - a[1] ||
          a[0].localeCompare(
            b[0]
          )
      );

  return entries.length > 0
    ? entries
        .map(
          ([role, count]) =>
            `${role}: ${count}`
        )
        .join(" | ")
    : "Keine Rollen vorhanden.";
}

function typeCounts(
  deck: DeckRecord
) {
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
    const line =
      card.typeLine ?? "";

    if (/\bLand\b/i.test(line)) {
      result.lands +=
        card.count;
    }

    if (/\bCreature\b/i.test(line)) {
      result.creatures +=
        card.count;
    }

    if (/\bArtifact\b/i.test(line)) {
      result.artifacts +=
        card.count;
    }

    if (/\bEnchantment\b/i.test(line)) {
      result.enchantments +=
        card.count;
    }

    if (/\bInstant\b/i.test(line)) {
      result.instants +=
        card.count;
    }

    if (/\bSorcery\b/i.test(line)) {
      result.sorceries +=
        card.count;
    }

    if (/\bPlaneswalker\b/i.test(line)) {
      result.planeswalkers +=
        card.count;
    }
  }

  return result;
}

export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const mainDeck =
    countMainDeckCards(deck);

  const commanders =
    commanderCount(deck);

  const total =
    mainDeck + commanders;

  const types =
    typeCounts(deck);

  const nonlands =
    mainDeck - types.lands;

  const averageMv =
    averageManaValue(deck);

  const targetManaValue =
    typeof deck.targetManaValue ===
    "number"
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

function shorten(
  value: string,
  maxLength: number
): string {
  const clean =
    value
      .replace(/\s+/g, " ")
      .trim();

  if (
    clean.length <= maxLength
  ) {
    return clean;
  }

  return (
    clean.slice(
      0,
      Math.max(
        0,
        maxLength - 1
      )
    ).trimEnd() + "…"
  );
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
        card.name.toLowerCase() ===
        name.toLowerCase()
    )
  );
}

function commanderText(
  deck: DeckRecord,
  collection: CardRecord[]
): string {
  if (
    deck.format !== "commander"
  ) {
    return "Kein Commander-Format.";
  }

  if (
    deck.commanderIds.length === 0
  ) {
    return "Keine Commander-Daten vorhanden.";
  }

  const lines:
    string[] = [];

  for (
    const commanderId
    of deck.commanderIds
  ) {
    const card =
      collection.find(
        item =>
          item.id === commanderId
      );

    if (!card) {
      lines.push(
        `Commander-ID: ${commanderId} | Weitere Kartendaten nicht verfügbar.`
      );
      continue;
    }

    const parts = [
      card.name,
      card.typeLine ||
        "Typ unbekannt",
      `MV ${card.manaValue}`
    ];

    if (card.oracleText?.trim()) {
      parts.push(
        `Oracle: ${shorten(
          card.oracleText,
          360
        )}`
      );
    }

    lines.push(
      parts.join(" | ")
    );
  }

  return lines.join("\n");
}

function deckCardLine(
  deckCard: DeckRecord["cards"][number],
  collection: CardRecord[],
  oracleLength: number
): string {
  const card =
    findCollectionCard(
      deckCard.id,
      deckCard.name,
      collection
    );

  const parts = [
    `${deckCard.count}x ${deckCard.name}`,
    `MV ${deckCard.manaValue}`,
    `Rolle ${deckCard.role || "Unbekannt"}`,
    `Typ ${deckCard.typeLine || card?.typeLine || "unbekannt"}`
  ];

  const oracle =
    card?.oracleText?.trim();

  if (
    oracle &&
    oracleLength > 0
  ) {
    parts.push(
      `Oracle ${shorten(
        oracle,
        oracleLength
      )}`
    );
  }

  if (deckCard.reason?.trim()) {
    parts.push(
      `Builder-Grund ${shorten(
        deckCard.reason,
        120
      )}`
    );
  }

  return parts.join(" | ");
}

function compactCardList(
  deck: DeckRecord,
  collection: CardRecord[],
  maxLength: number
): string {
  const header = [
    "KARTENLISTE DES FERTIGEN DECKS",
    "Diese Karten sind das Ergebnis des Deck Builders.",
    "Die Analyse soll das fertige Deck erklären und bewerten, nicht Karten aus der Sammlung austauschen.",
    ""
  ].join("\n");

  const oracleLevels = [
    170,
    110,
    70,
    0
  ];

  for (
    const oracleLength
    of oracleLevels
  ) {
    const lines =
      deck.cards.map(
        card =>
          deckCardLine(
            card,
            collection,
            oracleLength
          )
      );

    const text = [
      header,
      ...lines
    ].join("\n");

    if (
      text.length <= maxLength
    ) {
      return text;
    }
  }

  const lines:
    string[] = [];

  let length =
    header.length;

  for (const card of deck.cards) {
    const line =
      deckCardLine(
        card,
        collection,
        0
      );

    if (
      length +
        line.length +
        1 >
      maxLength
    ) {
      lines.push(
        "[Kartenliste wegen Größenlimit gekürzt.]"
      );
      break;
    }

    lines.push(line);
    length +=
      line.length + 1;
  }

  return [
    header,
    ...lines
  ].join("\n");
}

function analysisRules(): string {
  return [
    "ANALYSEAUFTRAG",
    "1. Analysiere ausschließlich das bereits fertig gebaute Deck.",
    "2. Erkläre Strategie, Mana-Kurve, Rollen, erkennbare Synergien, Stärken, Schwächen und Spielweise.",
    "3. Nutze Oracle-Texte, Kartentypen, Rollen und Builder-Gründe als Faktenbasis.",
    "4. Erfinde keine Karteneffekte, Rollen, Synergien oder Werte.",
    "5. Schwächen dürfen klar benannt werden, aber NICHT als Austauschvorschläge aus der Sammlung formuliert werden.",
    "6. Empfehle KEINE Karte aus der Sammlung als Ersatz für eine Deckkarte.",
    "7. Nenne KEINE Kaufempfehlungen oder Karten außerhalb des Decks. Diese Funktion wird separat ergänzt.",
    "8. Verwende keine Überschrift 'Verbesserungsvorschläge' und keine Überschrift 'Optionale Anschaffungen'.",
    "9. Beschreibe stattdessen, wie sich erkannte Schwächen beim Spielen auswirken können.",
    "10. Formuliere konkrete Spielhinweise nur, wenn sie aus den gelieferten Kartendaten nachvollziehbar sind."
  ].join("\n");
}

function createAiAnalysis(
  deck: DeckRecord,
  collection: CardRecord[]
): string {
  const fixedSections = [
    analysisRules(),
    "",
    "TECHNISCHE DECKDATEN",
    generateDeckExplanation(deck),
    "",
    "COMMANDER-INFORMATION",
    commanderText(
      deck,
      collection
    ),
    "",
    "NOTIZEN DES DECKBUILDERS",
    deck.notes ||
      "Keine Notizen vorhanden.",
    ""
  ].join("\n");

  const remainingLength =
    Math.max(
      1000,
      MAX_ANALYSIS_LENGTH -
        fixedSections.length -
        1
    );

  const cardList =
    compactCardList(
      deck,
      collection,
      remainingLength
    );

  const analysis = [
    fixedSections,
    cardList
  ].join("\n");

  return analysis.slice(
    0,
    MAX_ANALYSIS_LENGTH
  );
}

function wait(
  ms: number
): Promise<void> {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

type WorkerResponse = {
  explanation?: string;
  error?: string;
};

async function readWorkerResponse(
  response: Response
): Promise<WorkerResponse> {
  try {
    return await response.json()
      as WorkerResponse;
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
  if (response.status === 429) {
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
  analysis: string
): Promise<string | null> {
  let response: Response;

  try {
    response =
      await fetch(
        AI_WORKER_URL,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
            Authorization:
              `Bearer ${idToken}`
          },
          body: JSON.stringify({
            analysis
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

  const analysis =
    createAiAnalysis(
      deck,
      collection
    );

  for (
    let attempt = 0;
    attempt <=
      EMPTY_RESPONSE_RETRIES;
    attempt += 1
  ) {
    const explanation =
      await requestAiExplanation(
        idToken,
        analysis
      );

    if (explanation) {
      return explanation;
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

  throw new Error(
    "Die generative KI hat auch nach einem automatischen zweiten Versuch keine Deckanalyse zurückgegeben."
  );
}
