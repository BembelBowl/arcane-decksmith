import { auth } from "./firebase";
import type { DeckRecord } from "./types";

const AI_WORKER_URL =
  "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";

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
function isLand(typeLine: string | undefined): boolean {
  return (typeLine ?? "").toLowerCase().includes("land");
}

/**
 * Berechnet den durchschnittlichen Mana Value
 * aller Nichtland-Karten.
 */
function averageManaValue(deck: DeckRecord): number {
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

    totalManaValue += manaValue * card.count;
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
function manaCurve(deck: DeckRecord): number[] {
  const curve = Array<number>(8).fill(0);

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
function typeCounts(deck: DeckRecord) {
  let lands = 0;
  let creatures = 0;
  let artifacts = 0;
  let enchantments = 0;
  let instants = 0;
  let sorceries = 0;
  let planeswalkers = 0;

  for (const card of deck.cards) {
    const typeLine =
      (card.typeLine ?? "").toLowerCase();

    if (typeLine.includes("land")) {
      lands += card.count;
    }

    if (typeLine.includes("creature")) {
      creatures += card.count;
    }

    if (typeLine.includes("artifact")) {
      artifacts += card.count;
    }

    if (typeLine.includes("enchantment")) {
      enchantments += card.count;
    }

    if (typeLine.includes("instant")) {
      instants += card.count;
    }

    if (typeLine.includes("sorcery")) {
      sorceries += card.count;
    }

    if (typeLine.includes("planeswalker")) {
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
 *
 * Wir verwenden hier absichtlich die vorhandenen
 * Rollen aus deckBuilder.ts und versuchen nicht,
 * Kartentexte erneut zu erraten.
 */
function roleCounts(deck: DeckRecord): Record<string, number> {
  const roles: Record<string, number> = {};

  for (const card of deck.cards) {
    const role =
      card.role?.trim() || "Ohne Rolle";

    roles[role] =
      (roles[role] ?? 0) + card.count;
  }

  return roles;
}

/**
 * Erstellt eine lesbare Darstellung der Mana-Kurve.
 */
function manaCurveText(deck: DeckRecord): string {
  const curve = manaCurve(deck);

  return curve
    .map((count, index) => {
      const label =
        index === 7 ? "7+" : String(index);

      return `MV ${label}: ${count}`;
    })
    .join(", ");
}

/**
 * Erstellt eine lesbare Darstellung
 * der vom Builder vergebenen Kartenrollen.
 */
function rolesText(deck: DeckRecord): string {
  const roles = roleCounts(deck);
  const entries = Object.entries(roles);

  if (entries.length === 0) {
    return "Keine Rollen vorhanden.";
  }

  return entries
    .map(([role, count]) => `${role}: ${count}`)
    .join("\n");
}

/**
 * Gibt die Commander-IDs aus.
 *
 * DeckRecord speichert aktuell nur commanderIds.
 * Deshalb erfinden wir hier keinen Commander-Namen.
 */
function commanderText(deck: DeckRecord): string {
  if (
    !deck.commanderIds ||
    deck.commanderIds.length === 0
  ) {
    return "Kein Commander im Deckdatensatz angegeben.";
  }

  return deck.commanderIds.join(", ");
}

/**
 * Erstellt die Kartenliste, die an die KI
 * weitergegeben wird.
 *
 * Verwendet ausschließlich Felder, die in
 * DeckCard tatsächlich vorhanden sind.
 */
function cardListText(deck: DeckRecord): string {
  if (deck.cards.length === 0) {
    return "Keine Karten im Deck.";
  }

  return deck.cards
    .map((card) => {
      const parts = [
        `${card.count}x ${card.name}`,
        `Typ: ${card.typeLine || "Unbekannt"}`,
        `Mana Value: ${card.manaValue ?? 0}`,
        `Rolle: ${card.role || "Keine"}`
      ];

      if (card.reason) {
        parts.push(`Begründung: ${card.reason}`);
      }

      if (
        typeof card.available === "number"
      ) {
        parts.push(
          `In Sammlung verfügbar: ${card.available}`
        );
      }

      return parts.join(" | ");
    })
    .join("\n");
}

/**
 * Lokale, deterministische Deckanalyse.
 *
 * Diese Funktion benötigt weder Cloudflare
 * noch Groq. Sie dient als Fallback,
 * falls die generative KI nicht erreichbar ist.
 */
export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const total = countCards(deck);
  const types = typeCounts(deck);
  const nonlands = total - types.lands;
  const averageMv = averageManaValue(deck);

  const targetManaValue =
    typeof deck.targetManaValue === "number"
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
    `Verzauberungen: ${types.enchantments}`,
    `Spontanzauber: ${types.instants}`,
    `Hexereien: ${types.sorceries}`,
    `Planeswalker: ${types.planeswalkers}`,
    `Durchschnittlicher Mana Value: ${averageMv.toFixed(2)}`,
    `Ziel-Mana-Value: ${targetManaValue}`,
    "",
    "Mana-Kurve:",
    manaCurveText(deck),
    "",
    "Kartenrollen:",
    rolesText(deck)
  ].join("\n");
}

/**
 * Erstellt die Faktenbasis für Groq.
 *
 * Die KI bekommt Zahlen, Rollen und Kartenliste
 * aus Arcane Decksmith und soll diese erklären,
 * statt selbst Deckdaten zu berechnen.
 */
function createAiAnalysis(deck: DeckRecord): string {
  return [
    "TECHNISCHE DECKDATEN",
    generateDeckExplanation(deck),
    "",
    "COMMANDER-INFORMATION",
    commanderText(deck),
    "",
    "NOTIZEN DES DECKBUILDERS",
    deck.notes || "Keine Notizen vorhanden.",
    "",
    "KARTENLISTE",
    cardListText(deck)
  ].join("\n");
}

/**
 * Ruft die generative Deckanalyse über
 * unseren Cloudflare Worker auf.
 *
 * Ablauf:
 *
 * Arcane Decksmith
 * → Firebase ID-Token
 * → Cloudflare Worker
 * → Groq
 * → deutsche Deckanalyse
 *
 * Der geheime Groq API-Key befindet sich
 * ausschließlich im Cloudflare Worker.
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

  /**
   * getIdToken() liefert den zeitlich begrenzten
   * Firebase-Anmeldenachweis des aktuellen Nutzers.
   *
   * Dieser wird vom Cloudflare Worker geprüft.
   */
  const idToken =
    await user.getIdToken();

  const analysis =
    createAiAnalysis(deck);

  const response =
    await fetch(AI_WORKER_URL, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },

      body: JSON.stringify({
        analysis
      })
    });

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
        `Die KI-Anfrage ist fehlgeschlagen (${response.status}).`
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
