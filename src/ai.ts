import { auth } from "./firebase";
import { loadCollection } from "./db";
import {
  cardLegalForDeck,
  deckCopyLimit
} from "./deckBuilder";
import type {
  CardRecord,
  DeckRecord
} from "./types";

const AI_WORKER_URL =
  "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";

const MAX_ANALYSIS_LENGTH = 10500;
const EMPTY_RESPONSE_RETRIES = 1;
const RETRY_DELAY_MS = 700;

function countCards(
  deck: DeckRecord
): number {
  return deck.cards.reduce(
    (total, card) =>
      total + card.count,
    0
  );
}

function isLand(
  typeLine: string | undefined
): boolean {
  return (typeLine ?? "")
    .toLowerCase()
    .includes("land");
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
    : totalManaValue / cardCount;
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

    curve[index] += card.count;
  }

  return curve;
}

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

    if (
      typeLine.includes("land")
    ) {
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

function manaCurveText(
  deck: DeckRecord
): string {
  return manaCurve(deck)
    .map(
      (count, index) =>
        `MV ${
          index === 7
            ? "7+"
            : index
        }: ${count}`
    )
    .join(", ");
}

function rolesText(
  deck: DeckRecord
): string {
  const entries =
    Object.entries(
      roleCounts(deck)
    );

  if (
    entries.length === 0
  ) {
    return "Keine Rollen vorhanden.";
  }

  return entries
    .map(
      ([role, count]) =>
        `${role}: ${count}`
    )
    .join(", ");
}

function normalizeCardName(
  value: string
): string {
  return value
    .trim()
    .toLowerCase();
}

function collectionCardForDeckCard(
  deckCard:
    DeckRecord["cards"][number],
  collection: CardRecord[]
): CardRecord | undefined {
  return (
    collection.find(
      card =>
        card.id === deckCard.id
    ) ??
    collection.find(
      card =>
        normalizeCardName(
          card.name
        ) ===
        normalizeCardName(
          deckCard.name
        )
    )
  );
}

function commanderText(
  deck: DeckRecord,
  collection: CardRecord[]
): string {
  if (
    deck.commanderIds.length === 0
  ) {
    return (
      "Kein Commander im " +
      "Deckdatensatz angegeben."
    );
  }

  return deck.commanderIds
    .map(commanderId => {
      const commander =
        collection.find(
          card =>
            card.id ===
            commanderId
        );

      if (!commander) {
        return commanderId;
      }

      const oracle =
        shorten(
          commander.oracleText ??
            "Kein Oracle-Text gespeichert.",
          180
        );

      return [
        commander.name,
        commander.typeLine ??
          "Unbekannter Kartentyp",
        `Oracle: ${oracle}`
      ].join(" | ");
    })
    .join("\n");
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
    ) + "…"
  );
}

function deckCardLine(
  deckCard:
    DeckRecord["cards"][number],
  collection: CardRecord[],
  oracleLength: number
): string {
  const source =
    collectionCardForDeckCard(
      deckCard,
      collection
    );

  const role =
    deckCard.role?.trim() ||
    "Keine";

  const typeLine =
    shorten(
      source?.typeLine ??
        deckCard.typeLine ??
        "Unbekannt",
      55
    );

  const parts = [
    `${deckCard.count}x ${
      deckCard.name
    }`,
    `MV ${
      deckCard.manaValue ??
      source?.manaValue ??
      0
    }`,
    `Rolle ${role}`,
    typeLine
  ];

  if (
    oracleLength > 0
  ) {
    const oracleText =
      source?.oracleText?.trim();

    if (oracleText) {
      parts.push(
        `Oracle ${
          shorten(
            oracleText,
            oracleLength
          )
        }`
      );
    }
  }

  return parts.join(" | ");
}

function cardListText(
  deck: DeckRecord,
  collection: CardRecord[],
  oracleLength: number
): string {
  if (
    deck.cards.length === 0
  ) {
    return "Keine Karten im Deck.";
  }

  return deck.cards
    .map(card =>
      deckCardLine(
        card,
        collection,
        oracleLength
      )
    )
    .join("\n");
}

export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const mainDeckTotal =
    countCards(deck);

  const commanderCount =
    deck.format === "commander"
      ? deck.commanderIds.length
      : 0;

  const total =
    mainDeckTotal +
    commanderCount;

  const types =
    typeCounts(deck);

  const nonlands =
    mainDeckTotal -
    types.lands;

  const averageMv =
    averageManaValue(deck);

  const targetManaValue =
    typeof deck.targetManaValue ===
    "number"
      ? deck.targetManaValue
          .toFixed(1)
      : "Nicht angegeben";

  return [
    `Deck: ${deck.name}`,
    `Format: ${deck.format}`,
    "",
    `Karten gesamt: ${total}`,
    `Länder im Hauptdeck: ${
      types.lands
    }`,
    `Nichtländer im Hauptdeck: ${
      nonlands
    }`,
    `Kreaturen: ${
      types.creatures
    }`,
    `Artefakte: ${
      types.artifacts
    }`,
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

function analysisHeader(
  deck: DeckRecord,
  collection: CardRecord[]
): string {
  const notes =
    deck.notes
      ? shorten(
          deck.notes,
          800
        )
      : "Keine Notizen vorhanden.";

  return [
    "TECHNISCHE DECKDATEN",
    generateDeckExplanation(
      deck
    ),
    "",
    "COMMANDER-INFORMATION",
    commanderText(
      deck,
      collection
    ),
    "",
    "NOTIZEN DES DECKBUILDERS",
    notes
  ].join("\n");
}

function usedCopiesById(
  deck: DeckRecord
): Map<string, number> {
  const used =
    new Map<string, number>();

  for (
    const card of [
      ...deck.cards,
      ...deck.sideboard
    ]
  ) {
    used.set(
      card.id,
      (
        used.get(
          card.id
        ) ?? 0
      ) +
        card.count
    );
  }

  for (
    const commanderId
    of deck.commanderIds
  ) {
    used.set(
      commanderId,
      (
        used.get(
          commanderId
        ) ?? 0
      ) + 1
    );
  }

  return used;
}

function usedCopiesByName(
  deck: DeckRecord,
  collection: CardRecord[]
): Map<string, number> {
  const used =
    new Map<string, number>();

  const nameById =
    new Map(
      collection.map(
        card => [
          card.id,
          card.name
        ]
      )
    );

  for (
    const card of [
      ...deck.cards,
      ...deck.sideboard
    ]
  ) {
    const key =
      card.name.toLowerCase();

    used.set(
      key,
      (
        used.get(
          key
        ) ?? 0
      ) +
        card.count
    );
  }

  for (
    const commanderId
    of deck.commanderIds
  ) {
    const name =
      nameById.get(
        commanderId
      );

    if (!name) {
      continue;
    }

    const key =
      name.toLowerCase();

    used.set(
      key,
      (
        used.get(
          key
        ) ?? 0
      ) + 1
    );
  }

  return used;
}

function availableCollectionCards(
  deck: DeckRecord,
  collection: CardRecord[]
): Array<{
  card: CardRecord;
  available: number;
}> {
  const usedById =
    usedCopiesById(deck);

  const usedByName =
    usedCopiesByName(
      deck,
      collection
    );

  return collection
    .filter(card =>
      cardLegalForDeck(
        card,
        deck.format,
        deck.colors
      )
    )
    .map(card => {
      const physicallyFree =
        Math.max(
          0,
          card.count -
            (
              usedById.get(
                card.id
              ) ?? 0
            )
        );

      const ruleLimit =
        deckCopyLimit(
          card,
          deck.format
        );

      const alreadyUsedByName =
        usedByName.get(
          card.name.toLowerCase()
        ) ?? 0;

      const ruleFree =
        Number.isFinite(
          ruleLimit
        )
          ? Math.max(
              0,
              ruleLimit -
                alreadyUsedByName
            )
          : physicallyFree;

      return {
        card,
        available:
          Math.min(
            physicallyFree,
            ruleFree
          )
      };
    })
    .filter(
      item =>
        item.available > 0
    )
    .sort(
      (a, b) =>
        a.card.manaValue -
          b.card.manaValue ||
        a.card.name.localeCompare(
          b.card.name,
          "en",
          {
            sensitivity:
              "base"
          }
        )
    );
}

function collectionLine(
  card: CardRecord,
  available: number
): string {
  const parts = [
    `${available}x frei: ${
      card.name
    }`,
    `MV ${
      card.manaValue ?? 0
    }`,
    shorten(
      card.typeLine ??
        "Unbekannt",
      55
    )
  ];

  const oracleText =
    card.oracleText?.trim();

  if (oracleText) {
    parts.push(
      `Oracle ${
        shorten(
          oracleText,
          140
        )
      }`
    );
  }

  return parts.join(" | ");
}

function collectionContext(
  deck: DeckRecord,
  collection: CardRecord[],
  maxLength: number
): string {
  const available =
    availableCollectionCards(
      deck,
      collection
    );

  const header = [
    "VERFÜGBARE LEGALE KARTEN AUS DER SAMMLUNG",
    "Nur Karten in dieser Liste dürfen als sofort ausführbarer Austausch empfohlen werden.",
    "Die angegebene Anzahl ist die noch freie physische Anzahl nach Abzug von Hauptdeck, Sideboard und Commander sowie unter Beachtung des Copy-Limits.",
    "Wenn eine Karte nicht in dieser Liste steht, darf NICHT behauptet werden, dass sie im Besitz ist.",
    ""
  ].join("\n");

  if (
    available.length === 0
  ) {
    return (
      header +
      "Keine weitere passende Karte verfügbar."
    );
  }

  const lines:
    string[] = [];

  let length =
    header.length;

  let complete = true;

  for (
    const item of available
  ) {
    const line =
      collectionLine(
        item.card,
        item.available
      );

    if (
      length +
        line.length +
        1 >
      maxLength
    ) {
      complete = false;
      break;
    }

    lines.push(line);

    length +=
      line.length + 1;
  }

  const status =
    complete
      ? "SAMMLUNGSLISTE VOLLSTÄNDIG: JA"
      : [
          "SAMMLUNGSLISTE VOLLSTÄNDIG: NEIN",
          "Wegen des sicheren Größenlimits wird nur ein Teil der verfügbaren Sammlung übertragen.",
          "Aus dem Fehlen einer Karte in dieser gekürzten Liste darf NICHT geschlossen werden, dass sie nicht im Besitz ist."
        ].join("\n");

  return [
    header,
    status,
    "",
    ...lines
  ].join("\n");
}

function inferredCardRole(
  card: CardRecord
): string {
  const typeLine =
    (card.typeLine ?? "").toLowerCase();

  const oracle =
    (card.oracleText ?? "").toLowerCase();

  const text =
    `${typeLine} ${oracle}`;

  if (typeLine.includes("land")) {
    return "Land";
  }

  if (
    /add \{?[wubrgc]/.test(text) ||
    /search your library for (a|an) (basic )?land/.test(text) ||
    /mana.*pool/.test(text)
  ) {
    return "Ramp";
  }

  if (
    /draw (a|one|two|three|x|cards?)|draws? a card/.test(text)
  ) {
    return "Card Advantage";
  }

  if (
    /destroy target|exile target|return target.*hand|counter target|deals? .* damage to target|target creature gets -/.test(text)
  ) {
    return "Interaction";
  }

  if (/search your library/.test(text)) {
    return "Tutor";
  }

  if (
    /when .* enters|whenever|at the beginning|combat/.test(text)
  ) {
    return typeLine.includes("creature")
      ? "Synergie"
      : "Value";
  }

  if (typeLine.includes("creature")) {
    return "Creature";
  }

  return "Value";
}

function roleForDeckCard(
  deckCard:
    DeckRecord["cards"][number],
  source: CardRecord | undefined
): string {
  const explicitRole =
    deckCard.role?.trim();

  if (explicitRole) {
    return explicitRole;
  }

  if (source) {
    return inferredCardRole(source);
  }

  return "Value";
}

function broadCardType(
  typeLine: string | undefined
): string {
  const value =
    (typeLine ?? "").toLowerCase();

  if (value.includes("land")) {
    return "Land";
  }

  if (value.includes("creature")) {
    return "Creature";
  }

  if (value.includes("artifact")) {
    return "Artifact";
  }

  if (value.includes("enchantment")) {
    return "Enchantment";
  }

  if (value.includes("instant")) {
    return "Instant";
  }

  if (value.includes("sorcery")) {
    return "Sorcery";
  }

  if (value.includes("planeswalker")) {
    return "Planeswalker";
  }

  return "Other";
}

function functionalRole(
  role: string
): boolean {
  return [
    "Ramp",
    "Card Advantage",
    "Interaction",
    "Tutor"
  ].includes(role);
}

interface ReplacementMatch {
  card: CardRecord;
  available: number;
  role: string;
  score: number;
}

function replacementMatchesForDeckCard(
  deck: DeckRecord,
  deckCard:
    DeckRecord["cards"][number],
  collection: CardRecord[]
): ReplacementMatch[] {
  const source =
    collectionCardForDeckCard(
      deckCard,
      collection
    );

  const sourceRole =
    roleForDeckCard(
      deckCard,
      source
    );

  const sourceType =
    broadCardType(
      source?.typeLine ??
        deckCard.typeLine
    );

  const available =
    availableCollectionCards(
      deck,
      collection
    );

  return available
    .filter(item =>
      normalizeCardName(
        item.card.name
      ) !==
      normalizeCardName(
        deckCard.name
      )
    )
    .map(item => {
      const targetRole =
        inferredCardRole(
          item.card
        );

      const targetType =
        broadCardType(
          item.card.typeLine
        );

      let score = 0;

      /*
       * Länder werden nur durch Länder ersetzt.
       * Nichtländer werden nur durch Nichtländer ersetzt.
       * Dadurch vermeiden wir unbegründete Tausche wie
       * Card Draw -> Land, ohne die Manabasis künstlich
       * anhand des Mana Values zu verändern.
       */
      if (
        (sourceType === "Land") !==
        (targetType === "Land")
      ) {
        return {
          card: item.card,
          available: item.available,
          role: targetRole,
          score: -100
        };
      }

      if (sourceRole === targetRole) {
        score += 12;
      }

      if (
        !functionalRole(sourceRole) &&
        functionalRole(targetRole)
      ) {
        score += 7;
      }

      if (
        sourceType === targetType
      ) {
        score += 3;
      }

      if (
        sourceRole === "Synergie" &&
        targetRole === "Value"
      ) {
        score += 2;
      }

      if (
        sourceRole === "Value" &&
        targetRole === "Synergie"
      ) {
        score += 3;
      }

      const sourceMv =
        deckCard.manaValue ??
        source?.manaValue ??
        0;

      const targetMv =
        item.card.manaValue ?? 0;

      if (
        targetMv < sourceMv &&
        score >= 3
      ) {
        score += 1;
      }

      return {
        card: item.card,
        available: item.available,
        role: targetRole,
        score
      };
    })
    .filter(match =>
      match.score >= 6
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.card.manaValue -
          b.card.manaValue ||
        a.card.name.localeCompare(
          b.card.name,
          "en",
          {
            sensitivity: "base"
          }
        )
    )
    .slice(0, 3);
}

function replacementMatchLine(
  match: ReplacementMatch
): string {
  const oracleText =
    match.card.oracleText?.trim();

  const parts = [
    `${match.available}x frei: ${
      match.card.name
    }`,
    `Rolle ${match.role}`,
    `MV ${match.card.manaValue ?? 0}`,
    shorten(
      match.card.typeLine ??
        "Unbekannt",
      55
    )
  ];

  if (oracleText) {
    parts.push(
      `Oracle ${
        shorten(
          oracleText,
          180
        )
      }`
    );
  }

  return parts.join(" | ");
}

function replacementCandidateBlock(
  deck: DeckRecord,
  deckCard:
    DeckRecord["cards"][number],
  collection: CardRecord[]
): string | null {
  const source =
    collectionCardForDeckCard(
      deckCard,
      collection
    );

  const matches =
    replacementMatchesForDeckCard(
      deck,
      deckCard,
      collection
    );

  if (matches.length === 0) {
    return null;
  }

  const sourceRole =
    roleForDeckCard(
      deckCard,
      source
    );

  const sourceParts = [
    `DECKKARTE: ${deckCard.name}`,
    `Rolle ${sourceRole}`,
    `MV ${
      deckCard.manaValue ??
      source?.manaValue ??
      0
    }`,
    shorten(
      source?.typeLine ??
        deckCard.typeLine ??
        "Unbekannt",
      60
    )
  ];

  const sourceOracle =
    source?.oracleText?.trim();

  if (sourceOracle) {
    sourceParts.push(
      `Oracle ${
        shorten(
          sourceOracle,
          220
        )
      }`
    );
  }

  return [
    sourceParts.join(" | "),
    "ERLAUBTE FUNKTIONAL PLAUSIBLE ERSATZKARTEN FÜR DIESE DECKKARTE:",
    ...matches.map(
      match =>
        `- ${replacementMatchLine(match)}`
    )
  ].join("\n");
}

function replacementCandidateContext(
  deck: DeckRecord,
  collection: CardRecord[],
  maxLength: number
): string {
  const header = [
    "MÖGLICHE AUSTAUSCHKANDIDATEN AUS DEM DECK",
    "Die folgenden Austauschpaare wurden bereits lokal anhand von Besitz, Legalität, Copy-Limits, Kartentyp und Kartenfunktion vorgefiltert.",
    "Für eine konkrete Austausch-Empfehlung darf ausschließlich eine unter der jeweiligen DECKKARTE als ERLAUBTE FUNKTIONAL PLAUSIBLE ERSATZKARTE aufgeführte Karte verwendet werden.",
    "Kombiniere eine Deckkarte NICHT mit einer anderen Karte aus der allgemeinen Sammlungsliste, wenn diese nicht ausdrücklich unter dieser Deckkarte als erlaubte Ersatzkarte aufgeführt ist.",
    "Die lokale Vorfilterung ist bewusst konservativ: Länder werden nur gegen Länder und Nichtländer nur gegen Nichtländer verglichen.",
    "Groq soll aus diesen vorgefilterten Paaren die überzeugendsten 1 bis 3 auswählen und die Begründung ausschließlich aus den gelieferten Daten ableiten.",
    ""
  ].join("\n");

  if (maxLength <= header.length) {
    return header;
  }

  const candidateBlocks =
    deck.cards
      .filter(card =>
        !deck.commanderIds.includes(
          card.id
        )
      )
      .map(card => ({
        card,
        block:
          replacementCandidateBlock(
            deck,
            card,
            collection
          )
      }))
      .filter(
        item =>
          item.block !== null
      )
      .sort((a, b) => {
        const aRole =
          a.card.role?.trim() || "";
        const bRole =
          b.card.role?.trim() || "";

        const roleCompare =
          aRole.localeCompare(
            bRole,
            "en",
            {
              sensitivity: "base"
            }
          );

        if (roleCompare !== 0) {
          return roleCompare;
        }

        return (
          (b.card.manaValue ?? 0) -
            (a.card.manaValue ?? 0) ||
          a.card.name.localeCompare(
            b.card.name,
            "en",
            {
              sensitivity: "base"
            }
          )
        );
      });

  const blocks: string[] = [];
  let length = header.length;
  let complete = true;

  for (const item of candidateBlocks) {
    const block = item.block as string;

    if (
      length +
        block.length +
        2 >
      maxLength
    ) {
      complete = false;
      break;
    }

    blocks.push(block);
    length += block.length + 2;
  }

  if (blocks.length === 0) {
    return [
      header,
      "Keine lokal vorgefilterten plausiblen Austauschpaare verfügbar."
    ].join("\n");
  }

  const status =
    complete
      ? "AUSTAUSCHKANDIDATENLISTE VOLLSTÄNDIG: JA"
      : "AUSTAUSCHKANDIDATENLISTE VOLLSTÄNDIG: NEIN";

  return [
    header,
    status,
    "",
    ...blocks
  ].join("\n\n");
}

function recommendationRules(): string {
  return [
    "EMPFEHLUNGSREGELN",
    "1. Konkrete sofortige Austausche dürfen nur mit Karten aus der Sektion VERFÜGBARE LEGALE KARTEN AUS DER SAMMLUNG vorgeschlagen werden.",
    "2. Formuliere bei solchen Vorschlägen klar: 'Aus deiner Sammlung'.",
    "3. Behaupte niemals, dass eine nicht aufgelistete Karte im Besitz ist.",
    "4. Wenn die Sammlungsliste unvollständig ist, sage bei nicht aufgelisteten Karten nicht 'nicht im Besitz', sondern nur, dass ihr Besitz anhand der übertragenen Daten nicht bestätigt werden kann.",
    "5. Karten außerhalb der Sammlungsliste dürfen in dieser Ausbaustufe NICHT als konkrete Kauf- oder Austauschkarte empfohlen werden.",
    "6. Erfinde keine Karten und keine Karteneigenschaften.",
    "7. Nutze Oracle-Text und Rolle als wichtigste Grundlage für die Funktion einer Karte. Erfinde keine Funktion, die daraus nicht hervorgeht.",
    "8. Für einen konkreten Austausch darf nur ein Paar verwendet werden, das in der Sektion MÖGLICHE AUSTAUSCHKANDIDATEN AUS DEM DECK bereits gemeinsam aufgeführt ist.",
    "9. Die Ersatzkarte muss unter genau dieser DECKKARTE als ERLAUBTE FUNKTIONAL PLAUSIBLE ERSATZKARTE aufgeführt sein. Andere Kombinationen sind nicht erlaubt, auch wenn die Karte in der allgemeinen Sammlungsliste vorkommt.",
    "10. Begründe den Austausch anhand der übermittelten Rolle, des Kartentyps, des Mana Values und vor allem des Oracle-Texts beider Karten. Erfinde keine zusätzliche Funktion.",
    "11. Ein niedrigerer Mana Value allein ist kein ausreichender Austauschgrund.",
    "12. Gib 'Keine passende Ersatzkarte aus deiner Sammlung verfügbar.' nur aus, wenn du aus den lokal vorgefilterten Paaren kein plausibles Austauschpaar begründen kannst."
  ].join("\n");
}

function createAiAnalysis(
  deck: DeckRecord,
  collection: CardRecord[]
): string {
  const header =
    analysisHeader(
      deck,
      collection
    );

  const rules =
    recommendationRules();

  const detailedDeck = [
    header,
    "",
    "KARTENLISTE DES DECKS",
    cardListText(
      deck,
      collection,
      90
    )
  ].join("\n");

  const compactDeck = [
    header,
    "",
    "KARTENLISTE DES DECKS",
    cardListText(
      deck,
      collection,
      40
    )
  ].join("\n");

  const minimalDeck = [
    header,
    "",
    "KARTENLISTE DES DECKS",
    cardListText(
      deck,
      collection,
      0
    )
  ].join("\n");

  const collectionReserve = 2400;
  const replacementReserve = 2200;

  const base =
    detailedDeck.length +
      rules.length +
      collectionReserve +
      replacementReserve <=
    MAX_ANALYSIS_LENGTH
      ? detailedDeck
      : compactDeck.length +
          rules.length +
          collectionReserve +
          replacementReserve <=
        MAX_ANALYSIS_LENGTH
        ? compactDeck
        : minimalDeck;

  const fixedLength =
    base.length +
    rules.length +
    6;

  const remaining =
    Math.max(
      0,
      MAX_ANALYSIS_LENGTH -
        fixedLength
    );

  const collectionBudget =
    Math.min(
      collectionReserve,
      Math.floor(
        remaining * 0.55
      )
    );

  const collectionText =
    collectionContext(
      deck,
      collection,
      collectionBudget
    );

  const remainingForCandidates =
    Math.max(
      0,
      MAX_ANALYSIS_LENGTH -
        base.length -
        rules.length -
        collectionText.length -
        6
    );

  const replacementText =
    replacementCandidateContext(
      deck,
      collection,
      remainingForCandidates
    );

  const analysis = [
    base,
    "",
    collectionText,
    "",
    replacementText,
    "",
    rules
  ].join("\n");

  if (
    analysis.length >
    MAX_ANALYSIS_LENGTH
  ) {
    throw new Error(
      "Die Deck- und Sammlungsdaten sind selbst in kompakter Form zu groß für eine einzelne KI-Analyse."
    );
  }

  return analysis;
}

function wait(
  milliseconds: number
): Promise<void> {
  return new Promise(
    resolve => {
      window.setTimeout(
        resolve,
        milliseconds
      );
    }
  );
}

interface AiWorkerResponse {
  explanation?: string;
  error?: string;
}

async function readWorkerResponse(
  response: Response
): Promise<AiWorkerResponse> {
  try {
    return (
      await response.json()
    ) as AiWorkerResponse;
  } catch {
    throw new Error(
      "Der KI-Dienst hat eine ungültige Antwort geliefert."
    );
  }
}

function workerError(
  response: Response,
  data: AiWorkerResponse
): Error {
  if (
    response.status === 429
  ) {
    return new Error(
      "Das KI-Limit wurde erreicht. " +
      "Pro angemeldetem Benutzer sind " +
      "höchstens 10 Analysen pro Minute " +
      "möglich. Bitte warte kurz und " +
      "versuche es danach erneut."
    );
  }

  if (
    response.status === 401
  ) {
    return new Error(
      data.error ||
      "Die Anmeldung für den KI-Dienst " +
      "konnte nicht bestätigt werden. " +
      "Bitte melde dich erneut an."
    );
  }

  if (
    response.status === 403
  ) {
    return new Error(
      data.error ||
      "Der KI-Dienst hat diese Anfrage nicht erlaubt."
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

          body:
            JSON.stringify({
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
