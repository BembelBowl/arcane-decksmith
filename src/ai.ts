import { auth } from "./firebase";
import type { DeckRecord } from "./types";

const AI_WORKER_URL =
  "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";

/*
 * Der Cloudflare Worker akzeptiert aktuell
 * maximal ungefähr 12.000 Zeichen Analyse-Text.
 *
 * Wir bleiben bewusst etwas darunter, damit
 * auch JSON-/Prompt-Overhead kein Problem wird.
 */
const MAX_ANALYSIS_LENGTH = 10500;

/*
 * Bei einer leeren, aber technisch erfolgreichen
 * KI-Antwort versuchen wir die Anfrage genau
 * ein weiteres Mal.
 */
const EMPTY_RESPONSE_RETRIES = 1;

/*
 * Kurze Wartezeit vor dem Retry.
 */
const RETRY_DELAY_MS = 700;

/**
 * Zählt die Gesamtzahl aller Karten im Hauptdeck.
 */
function countCards(deck: DeckRecord): number {
  return deck.cards.reduce(
    (total, card) => total + card.count,
    0
  );
}

/**
 * Erkennt Länder anhand der Typzeile.
 */
function isLand(
  typeLine: string | undefined
): boolean {
  return (typeLine ?? "")
    .toLowerCase()
    .includes("land");
}

/**
 * Berechnet den durchschnittlichen Mana Value
 * aller Nichtland-Karten.
 */
function averageManaValue(
  deck: DeckRecord
): number {
  let totalManaValue = 0;
  let cardCount = 0;

  for (const card of deck.cards) {
    if (isLand(card.typeLine)) {
      continue;
    }

    const manaValue =
      typeof card.manaValue === "number"
        ? card.manaValue
        : 0;

    totalManaValue +=
      manaValue * card.count;

    cardCount += card.count;
  }

  if (cardCount === 0) {
    return 0;
  }

  return totalManaValue / cardCount;
}

/**
 * Erstellt die Mana-Kurve.
 *
 * Index:
 * 0 = MV 0
 * 1 = MV 1
 * ...
 * 7 = MV 7 oder höher
 */
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
      typeof card.manaValue === "number"
        ? Math.floor(card.manaValue)
        : 0;

    const index = Math.min(
      Math.max(manaValue, 0),
      7
    );

    curve[index] += card.count;
  }

  return curve;
}

/**
 * Zählt grundlegende Kartentypen.
 */
function typeCounts(
  deck: DeckRecord
) {
  let lands = 0;
  let creatures = 0;
  let artifacts = 0;
  let enchantments = 0;
  let instants = 0;
  let sorceries = 0;
  let planeswalkers = 0;

  for (const card of deck.cards) {
    const typeLine =
      (card.typeLine ?? "")
        .toLowerCase();

    if (typeLine.includes("land")) {
      lands += card.count;
    }

    if (
      typeLine.includes("creature")
    ) {
      creatures += card.count;
    }

    if (
      typeLine.includes("artifact")
    ) {
      artifacts += card.count;
    }

    if (
      typeLine.includes(
        "enchantment"
      )
    ) {
      enchantments += card.count;
    }

    if (
      typeLine.includes("instant")
    ) {
      instants += card.count;
    }

    if (
      typeLine.includes("sorcery")
    ) {
      sorceries += card.count;
    }

    if (
      typeLine.includes(
        "planeswalker"
      )
    ) {
      planeswalkers += card.count;
    }
  }

  return {
    lands,
    creatures,
    artifacts,
    enchantments,
    instants,
    sorceries,
    planeswalkers
  };
}

/**
 * Zählt die Rollen, die der Deckbuilder
 * den Karten bereits zugewiesen hat.
 */
function roleCounts(
  deck: DeckRecord
): Record<string, number> {
  const roles:
    Record<string, number> = {};

  for (const card of deck.cards) {
    const role =
      card.role?.trim() ||
      "Ohne Rolle";

    roles[role] =
      (roles[role] ?? 0) +
      card.count;
  }

  return roles;
}

/**
 * Erstellt eine lesbare Darstellung
 * der Mana-Kurve.
 */
function manaCurveText(
  deck: DeckRecord
): string {
  const curve = manaCurve(deck);

  return curve
    .map((count, index) => {
      const label =
        index === 7
          ? "7+"
          : String(index);

      return `MV ${label}: ${count}`;
    })
    .join(", ");
}

/**
 * Erstellt eine lesbare Darstellung
 * der Kartenrollen.
 */
function rolesText(
  deck: DeckRecord
): string {
  const roles = roleCounts(deck);

  const entries =
    Object.entries(roles);

  if (entries.length === 0) {
    return "Keine Rollen vorhanden.";
  }

  return entries
    .map(
      ([role, count]) =>
        `${role}: ${count}`
    )
    .join(", ");
}

/**
 * Gibt die Commander-IDs aus.
 *
 * DeckRecord enthält hier nur die IDs.
 */
function commanderText(
  deck: DeckRecord
): string {
  if (
    !deck.commanderIds ||
    deck.commanderIds.length === 0
  ) {
    return (
      "Kein Commander im " +
      "Deckdatensatz angegeben."
    );
  }

  return deck.commanderIds.join(", ");
}

/**
 * Kürzt Text nur für die Übertragung
 * an die generative KI.
 *
 * Die eigentlichen Kartendaten im Deck
 * werden dadurch nicht verändert.
 */
function shorten(
  value: string,
  maxLength: number
): string {
  const clean =
    value.replace(/\s+/g, " ").trim();

  if (clean.length <= maxLength) {
    return clean;
  }

  return (
    clean.slice(
      0,
      Math.max(0, maxLength - 1)
    ) + "…"
  );
}

/**
 * Kompakte Kartenliste für normale
 * vollständige Commander-Decks.
 *
 * Statt langer Begründungen senden wir
 * nur die Informationen, die für eine
 * Deckanalyse wirklich wichtig sind:
 *
 * - Anzahl
 * - Kartenname
 * - Mana Value
 * - Rolle
 * - Kartentyp
 */
function compactCardListText(
  deck: DeckRecord
): string {
  if (deck.cards.length === 0) {
    return "Keine Karten im Deck.";
  }

  return deck.cards
    .map(card => {
      const role =
        card.role?.trim() ||
        "Keine";

      const typeLine =
        shorten(
          card.typeLine ||
            "Unbekannt",
          70
        );

      return [
        `${card.count}x ${card.name}`,
        `MV ${card.manaValue ?? 0}`,
        role,
        typeLine
      ].join(" | ");
    })
    .join("\n");
}

/**
 * Noch kompaktere Kartenliste.
 *
 * Diese Variante wird nur verwendet,
 * wenn ein ungewöhnlich großes Deck
 * trotz der normalen Komprimierung
 * noch nahe am Worker-Limit liegt.
 *
 * Alle Karten bleiben enthalten.
 */
function ultraCompactCardListText(
  deck: DeckRecord
): string {
  if (deck.cards.length === 0) {
    return "Keine Karten im Deck.";
  }

  return deck.cards
    .map(card => {
      const role =
        card.role?.trim();

      return role
        ? `${card.count}x ${card.name} | ${role}`
        : `${card.count}x ${card.name}`;
    })
    .join("\n");
}

/**
 * Lokale, deterministische Deckanalyse.
 *
 * Diese Analyse benötigt weder
 * Cloudflare noch Groq und bleibt
 * weiterhin unser Fallback.
 */
export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const total =
    countCards(deck);

  const types =
    typeCounts(deck);

  const nonlands =
    total - types.lands;

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
    "",
    `Karten gesamt: ${total}`,
    `Länder: ${types.lands}`,
    `Nichtländer: ${nonlands}`,
    `Kreaturen: ${types.creatures}`,
    `Artefakte: ${types.artifacts}`,
    `Verzauberungen: ${
      types.enchantments
    }`,
    `Spontanzauber: ${
      types.instants
    }`,
    `Hexereien: ${
      types.sorceries
    }`,
    `Planeswalker: ${
      types.planeswalkers
    }`,
    "Durchschnittlicher Mana Value: " +
      averageMv.toFixed(2),
    `Ziel-Mana-Value: ${
      targetManaValue
    }`,
    "",
    "Mana-Kurve:",
    manaCurveText(deck),
    "",
    "Kartenrollen:",
    rolesText(deck)
  ].join("\n");
}

/**
 * Erstellt die gemeinsame Faktenbasis
 * für die generative Analyse.
 */
function analysisHeader(
  deck: DeckRecord
): string {
  /*
   * Sehr lange freie Decknotizen können
   * die Anfrage unnötig aufblasen.
   *
   * 800 Zeichen reichen als zusätzlicher
   * Kontext für die generative Analyse.
   */
  const notes = deck.notes
    ? shorten(deck.notes, 800)
    : "Keine Notizen vorhanden.";

  return [
    "TECHNISCHE DECKDATEN",
    generateDeckExplanation(deck),
    "",
    "COMMANDER-INFORMATION",
    commanderText(deck),
    "",
    "NOTIZEN DES DECKBUILDERS",
    notes
  ].join("\n");
}

/**
 * Erstellt die Faktenbasis für Groq.
 *
 * Zuerst verwenden wir die normale
 * kompakte Kartenliste.
 *
 * Falls das Ergebnis trotzdem zu groß
 * wäre, verwenden wir automatisch die
 * Ultra-Kompakt-Darstellung.
 */
function createAiAnalysis(
  deck: DeckRecord
): string {
  const header =
    analysisHeader(deck);

  const normalAnalysis = [
    header,
    "",
    "KARTENLISTE",
    compactCardListText(deck)
  ].join("\n");

  if (
    normalAnalysis.length <=
    MAX_ANALYSIS_LENGTH
  ) {
    return normalAnalysis;
  }

  const compactAnalysis = [
    header,
    "",
    "KARTENLISTE",
    ultraCompactCardListText(deck)
  ].join("\n");

  if (
    compactAnalysis.length <=
    MAX_ANALYSIS_LENGTH
  ) {
    return compactAnalysis;
  }

  /*
   * Dieser Fall sollte bei normalen
   * 60-/100-Karten-Decks praktisch
   * nicht auftreten.
   *
   * Wir behalten trotzdem einen Schutz,
   * damit nie versehentlich eine riesige
   * Anfrage an den Worker geschickt wird.
   */
  throw new Error(
    "Die Deckdaten sind selbst in " +
    "kompakter Form zu groß für eine " +
    "einzelne KI-Analyse."
  );
}

/**
 * Kurze Wartefunktion für einen
 * automatischen Retry.
 *
 * Promise bedeutet:
 * Der Browser wartet asynchron,
 * ohne die Oberfläche zu blockieren.
 */
function wait(
  milliseconds: number
): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(
      resolve,
      milliseconds
    );
  });
}

interface AiWorkerResponse {
  explanation?: string;
  error?: string;
}

/**
 * Liest die JSON-Antwort des Workers.
 */
async function readWorkerResponse(
  response: Response
): Promise<AiWorkerResponse> {
  try {
    return (
      await response.json()
    ) as AiWorkerResponse;
  } catch {
    throw new Error(
      "Der KI-Dienst hat eine " +
      "ungültige Antwort geliefert."
    );
  }
}

/**
 * Wandelt HTTP-Fehler in
 * verständliche Meldungen um.
 */
function workerError(
  response: Response,
  data: AiWorkerResponse
): Error {
  /*
   * HTTP 429 =
   * zu viele Anfragen.
   *
   * Hier machen wir absichtlich keinen
   * sofortigen Retry.
   */
  if (response.status === 429) {
    return new Error(
      "Das KI-Limit wurde erreicht. " +
      "Pro angemeldetem Benutzer sind " +
      "höchstens 10 Analysen pro Minute " +
      "möglich. Bitte warte kurz und " +
      "versuche es danach erneut."
    );
  }

  if (response.status === 401) {
    return new Error(
      data.error ||
      "Die Anmeldung für den KI-Dienst " +
      "konnte nicht bestätigt werden. " +
      "Bitte melde dich erneut an."
    );
  }

  if (response.status === 403) {
    return new Error(
      data.error ||
      "Der KI-Dienst hat diese Anfrage " +
      "nicht erlaubt."
    );
  }

  if (response.status >= 500) {
    return new Error(
      data.error ||
      "Der KI-Dienst ist momentan " +
      "nicht verfügbar. Bitte versuche " +
      "es später erneut."
    );
  }

  return new Error(
    data.error ||
    `Die KI-Anfrage ist fehlgeschlagen (${response.status}).`
  );
}

/**
 * Führt genau eine Anfrage an den
 * Cloudflare Worker aus.
 *
 * Der geheime Groq API-Key bleibt
 * ausschließlich im Worker.
 */
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
      "Der KI-Dienst konnte nicht " +
      "erreicht werden. Bitte prüfe " +
      "deine Internetverbindung und " +
      "versuche es erneut."
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

  /*
   * Eine leere Erklärung ist kein
   * HTTP-Fehler.
   *
   * null signalisiert, dass ein
   * automatischer Retry sinnvoll ist.
   */
  if (
    typeof data.explanation !==
      "string" ||
    !data.explanation.trim()
  ) {
    return null;
  }

  return data.explanation.trim();
}

/**
 * Ruft die generative Deckanalyse über
 * unseren Cloudflare Worker auf.
 *
 * Ablauf:
 *
 * Arcane Decksmith
 * → kompakte vollständige Deckdaten
 * → Firebase ID-Token
 * → Cloudflare Worker
 * → Groq
 * → deutsche Deckanalyse
 *
 * Bei leerer Groq-Antwort wird genau
 * ein zweiter Versuch ausgeführt.
 *
 * Danach übernimmt weiterhin der
 * lokale deterministische Fallback
 * in App.tsx.
 */
export async function generateAiDeckExplanation(
  deck: DeckRecord
): Promise<string> {
  const user =
    auth?.currentUser;

  if (!user) {
    throw new Error(
      "Du musst angemeldet sein, " +
      "um die KI-Analyse zu verwenden."
    );
  }

  /*
   * getIdToken() liefert den
   * zeitlich begrenzten
   * Firebase-Anmeldenachweis.
   */
  const idToken =
    await user.getIdToken();

  /*
   * createAiAnalysis() komprimiert
   * die vollständigen Deckdaten jetzt
   * automatisch so weit, dass normale
   * Commander-Decks unter dem
   * Worker-Limit bleiben.
   */
  const analysis =
    createAiAnalysis(deck);

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
    "Die generative KI hat auch " +
    "nach einem automatischen " +
    "zweiten Versuch keine " +
    "Deckanalyse zurückgegeben."
  );
}
