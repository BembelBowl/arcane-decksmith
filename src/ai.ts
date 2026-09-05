import { auth } from "./firebase";
import type { DeckRecord } from "./types";

const AI_WORKER_URL =
  "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";

/**
 * Zählt alle Karten eines Decks.
 * Die Kartenmenge einer Karte wird dabei berücksichtigt.
 */
function countCards(deck: DeckRecord): number {
  return deck.cards.reduce(
    (total, entry) => total + entry.quantity,
    0
  );
}

/**
 * Berechnet den durchschnittlichen Mana Value aller Nichtland-Karten.
 */
function averageManaValue(deck: DeckRecord): number {
  let totalManaValue = 0;
  let cardCount = 0;

  for (const entry of deck.cards) {
    const card = entry.card;

    if (card.typeLine?.includes("Land")) {
      continue;
    }

    const manaValue =
      typeof card.cmc === "number" ? card.cmc : 0;

    totalManaValue += manaValue * entry.quantity;
    cardCount += entry.quantity;
  }

  if (cardCount === 0) {
    return 0;
  }

  return totalManaValue / cardCount;
}

/**
 * Ermittelt eine einfache Mana-Kurve.
 *
 * 0 = Mana Value 0
 * 1 = Mana Value 1
 * ...
 * 7 = Mana Value 7 oder höher
 */
function manaCurve(deck: DeckRecord): number[] {
  const curve = Array(8).fill(0) as number[];

  for (const entry of deck.cards) {
    const card = entry.card;

    if (card.typeLine?.includes("Land")) {
      continue;
    }

    const manaValue =
      typeof card.cmc === "number"
        ? Math.floor(card.cmc)
        : 0;

    const index = Math.min(
      Math.max(manaValue, 0),
      7
    );

    curve[index] += entry.quantity;
  }

  return curve;
}

/**
 * Zählt wichtige Kartentypen.
 */
function typeCounts(deck: DeckRecord) {
  let lands = 0;
  let creatures = 0;
  let artifacts = 0;
  let enchantments = 0;
  let instants = 0;
  let sorceries = 0;
  let planeswalkers = 0;

  for (const entry of deck.cards) {
    const typeLine = entry.card.typeLine ?? "";
    const quantity = entry.quantity;

    if (typeLine.includes("Land")) {
      lands += quantity;
    }

    if (typeLine.includes("Creature")) {
      creatures += quantity;
    }

    if (typeLine.includes("Artifact")) {
      artifacts += quantity;
    }

    if (typeLine.includes("Enchantment")) {
      enchantments += quantity;
    }

    if (typeLine.includes("Instant")) {
      instants += quantity;
    }

    if (typeLine.includes("Sorcery")) {
      sorceries += quantity;
    }

    if (typeLine.includes("Planeswalker")) {
      planeswalkers += quantity;
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
 * Erkennt einfache strategische Rollen anhand des Oracle-Texts.
 *
 * Das ist bewusst eine Heuristik:
 * Sie liefert der Gen-AI Fakten und Anhaltspunkte,
 * ohne die KI selbst Zahlen erraten zu lassen.
 */
function roleCounts(deck: DeckRecord) {
  let ramp = 0;
  let draw = 0;
  let interaction = 0;
  let boardWipes = 0;
  let graveyard = 0;

  for (const entry of deck.cards) {
    const text =
      entry.card.oracleText?.toLowerCase() ?? "";

    const quantity = entry.quantity;

    if (
      text.includes("add {") ||
      text.includes("search your library for a basic land") ||
      text.includes("search your library for a land card")
    ) {
      ramp += quantity;
    }

    if (
      text.includes("draw a card") ||
      text.includes("draw two cards") ||
      text.includes("draw three cards")
    ) {
      draw += quantity;
    }

    if (
      text.includes("destroy target") ||
      text.includes("exile target") ||
      text.includes("counter target")
    ) {
      interaction += quantity;
    }

    if (
      text.includes("destroy all") ||
      text.includes("exile all")
    ) {
      boardWipes += quantity;
    }

    if (
      text.includes("graveyard") ||
      text.includes("from your graveyard")
    ) {
      graveyard += quantity;
    }
  }

  return {
    ramp,
    draw,
    interaction,
    boardWipes,
    graveyard
  };
}

/**
 * Erstellt eine kompakte Kartenliste für die KI.
 *
 * Oracle-Texte werden absichtlich mitgeschickt,
 * damit die KI echte Karteneffekte und Synergien
 * erklären kann, statt Karten zu erfinden.
 */
function createCardList(deck: DeckRecord): string {
  return deck.cards
    .map(entry => {
      const card = entry.card;

      const oracleText =
        card.oracleText
          ?.replace(/\s+/g, " ")
          .trim() || "Kein Oracle-Text vorhanden";

      return [
        `${entry.quantity}x ${card.name}`,
        `Typ: ${card.typeLine ?? "Unbekannt"}`,
        `Mana Value: ${card.cmc ?? 0}`,
        `Text: ${oracleText}`
      ].join(" | ");
    })
    .join("\n");
}

/**
 * Lokale, deterministische Deckanalyse.
 *
 * Diese Funktion benötigt keine externe KI.
 * Sie dient gleichzeitig als:
 *
 * 1. Faktenbasis für Groq
 * 2. Fallback, falls Groq oder Cloudflare ausfällt
 */
export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const total = countCards(deck);
  const types = typeCounts(deck);
  const roles = roleCounts(deck);
  const curve = manaCurve(deck);
  const avgMana = averageManaValue(deck);

  const nonlands = total - types.lands;

  const curveText = curve
    .map((count, index) => {
      const label =
        index === 7 ? "7+" : String(index);

      return `MV ${label}: ${count}`;
    })
    .join(", ");

  const commanderText =
    deck.commander?.name
      ? deck.commander.name
      : "Kein Commander angegeben";

  return [
    `Deck: ${deck.name}`,
    `Format: ${deck.format}`,
    `Commander: ${commanderText}`,
    "",
    `Karten gesamt: ${total}`,
    `Länder: ${types.lands}`,
    `Nichtländer: ${nonlands}`,
    `Kreaturen: ${types.creatures}`,
    `Artefakte: ${types.artifacts}`,
    `Verzauberungen: ${types.enchantments}`,
    `Spontanzauber: ${types.instants}`,
    `Hexereien: ${types.sorceries}`,
    `Planeswalker: ${types.planeswalkers}`,
    `Durchschnittlicher Mana Value: ${avgMana.toFixed(2)}`,
    `Ziel-Mana-Value: ${deck.targetManaValue}`,
    "",
    "Mana-Kurve:",
    curveText,
    "",
    "Erkannte Kartenrollen:",
    `Ramp: ${roles.ramp}`,
    `Kartennachschub: ${roles.draw}`,
    `Interaktion: ${roles.interaction}`,
    `Boardwipes: ${roles.boardWipes}`,
    `Friedhofsbezug: ${roles.graveyard}`
  ].join("\n");
}

/**
 * Erstellt die ausführliche Faktenbasis,
 * die an unseren Cloudflare Worker gesendet wird.
 */
function createAiAnalysis(deck: DeckRecord): string {
  const statistics =
    generateDeckExplanation(deck);

  const cards =
    createCardList(deck);

  return [
    statistics,
    "",
    "Karten im Deck:",
    cards
  ].join("\n");
}

/**
 * Ruft die echte generative KI über unseren
 * Cloudflare Worker auf.
 *
 * Der Groq API-Key befindet sich NICHT hier.
 * Er bleibt als Secret im Cloudflare Worker.
 */
export async function generateAiDeckExplanation(
  deck: DeckRecord
): Promise<string> {
  const user = auth?.currentUser;

  if (!user) {
    throw new Error(
      "Du musst angemeldet sein, um die KI-Analyse zu verwenden."
    );
  }

  /*
   * Firebase erstellt hier automatisch ein ID-Token
   * für den aktuell eingeloggten Benutzer.
   */
  const idToken =
    await user.getIdToken();

  /*
   * Die lokale Analyse liefert der KI die Fakten.
   * Dadurch muss Groq beispielsweise Kartenanzahl,
   * Mana-Kurve oder Kartentexte nicht erraten.
   */
  const analysis =
    createAiAnalysis(deck);

  const response = await fetch(
    AI_WORKER_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        /*
         * Der Worker überprüft dieses Firebase-Token.
         * Nur angemeldete Arcane-Decksmith-Nutzer
         * sollen die KI verwenden können.
         */
        Authorization:
          `Bearer ${idToken}`
      },

      body: JSON.stringify({
        analysis
      })
    }
  );

  let data: {
    explanation?: string;
    error?: string;
  };

  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Der KI-Dienst hat eine ungültige Antwort geliefert."
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ??
        `KI-Anfrage fehlgeschlagen (${response.status}).`
    );
  }

  if (
    typeof data.explanation !== "string" ||
    !data.explanation.trim()
  ) {
    throw new Error(
      "Die KI hat keine Erklärung zurückgegeben."
    );
  }

  return data.explanation.trim();
}
