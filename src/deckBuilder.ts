import type {
  CardRecord,
  DeckCard,
  DeckRecord,
  Format
} from "./types";

const BASIC_NAMES = new Set([
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
  "Wastes",
  "Ebene",
  "Insel",
  "Sumpf",
  "Gebirge",
  "Wald",
  "Ödnis"
]);

function isLand(c: CardRecord) {
  return /\bLand\b/i.test(
    c.typeLine ?? ""
  );
}

function isCreature(c: CardRecord) {
  return /\bCreature\b/i.test(
    c.typeLine ?? ""
  );
}

function text(c: CardRecord) {
  return `${c.typeLine ?? ""} ${c.oracleText ?? ""}`
    .toLowerCase();
}

function roleOf(c: CardRecord): string {
  const t = text(c);

  if (isLand(c)) {
    return "Land";
  }

  if (
    /add \{?[wubrgc]/.test(t) ||
    /search your library for (a|an) (basic )?land/.test(t) ||
    /mana.*pool/.test(t) ||
    /ramp/.test(t)
  ) {
    return "Ramp";
  }

  if (
    /draw (a|one|two|three|x|cards?)|draws? a card|card draw/.test(t)
  ) {
    return "Card Advantage";
  }

  if (
    /destroy target|exile target|return target.*hand|counter target|deals? .* damage to target|target creature gets -/.test(t)
  ) {
    return "Interaction";
  }

  if (/search your library/.test(t)) {
    return "Tutor";
  }

  if (
    /when .* enters|whenever|at the beginning|combat/.test(t)
  ) {
    return isCreature(c)
      ? "Synergie"
      : "Value";
  }

  if (isCreature(c)) {
    return "Creature";
  }

  return "Value";
}

function commanderLegal(c: CardRecord) {
  const t = text(c);

  return (
    c.legalities?.commander !== "banned" &&
    (
      /\bLegendary\b.*\bCreature\b/i.test(
        c.typeLine ?? ""
      ) ||
      /can be your commander|partner|friends forever|doctor's companion|choose a background/i.test(
        t
      )
    )
  );
}

function standardLegal(c: CardRecord) {
  return c.legalities?.standard === "legal";
}

function identityOk(
  c: CardRecord,
  colors: string[]
) {
  return (
    c.colorIdentity ?? []
  ).every(
    color => colors.includes(color)
  );
}

function copyLimit(
  c: CardRecord,
  format: Format
) {
  const unlimited =
    c.isBasicLand ||
    BASIC_NAMES.has(c.name) ||
    /a deck can have any number/i.test(
      c.oracleText ?? ""
    );

  if (unlimited) {
    return 99;
  }

  return format === "commander"
    ? 1
    : 4;
}

function cardScore(
  c: CardRecord,
  format: Format,
  targetMV?: number
) {
  const role = roleOf(c);

  let score = 0;

  if (role === "Ramp") {
    score += 8;
  }

  if (role === "Card Advantage") {
    score += 7;
  }

  if (role === "Interaction") {
    score += 7;
  }

  if (role === "Tutor") {
    score += 6;
  }

  if (role === "Synergie") {
    score += 6;
  }

  if (isCreature(c)) {
    score += 3;
  }

  if (c.manaValue <= 3) {
    score += 3;
  }

  if (targetMV != null) {
    score += Math.max(
      0,
      4 -
        Math.abs(
          c.manaValue - targetMV
        )
    );
  }

  if (
    format === "standard" &&
    standardLegal(c)
  ) {
    score += 3;
  }

  return score;
}

function makeDeckCard(
  c: CardRecord,
  reason: string,
  available: number,
  count = 1
): DeckCard {
  return {
    id: c.id,
    name: c.name,
    count,
    manaValue: c.manaValue,
    typeLine: c.typeLine,
    role: roleOf(c),
    reason,
    available
  };
}

export interface BuildOptions {
  name: string;
  format: Format;
  colors: string[];
  commander?: CardRecord;
  targetManaValue: number;
  minManaValue?: number;
  maxManaValue?: number;
}

export function buildDeck(
  pool: CardRecord[],
  o: BuildOptions
): DeckRecord {
  /*
   * Zuerst wird getrennt geprüft:
   *
   * 1. Farbidentität
   * 2. Format-Legalität
   *
   * Dadurch können wir später einen sinnvollen
   * Hinweis ausgeben, warum Karten nicht
   * verwendet wurden.
   */

  const colorEligible = pool.filter(
    card =>
      identityOk(
        card,
        o.colors
      )
  );

  const eligible =
    colorEligible.filter(card =>
      o.format === "commander"
        ? card.legalities?.commander !==
          "banned"
        : standardLegal(card)
    );

  const commander = o.commander;

  const filtered = commander
    ? eligible.filter(
        card =>
          card.id !== commander.id
      )
    : eligible;

  /*
   * Commander:
   * 99 Karten + Commander
   *
   * Standard:
   * 60 Karten
   */
  const target =
    o.format === "commander"
      ? 99
      : 60;

  const selected =
    new Map<string, DeckCard>();

  const used =
    new Map<string, number>();

  let slots = target;

  /*
   * add() gibt jetzt die TATSÄCHLICHE
   * Anzahl hinzugefügter Karten zurück.
   *
   * Vorher kam nur true/false zurück.
   * Dadurch konnte slots falsch berechnet
   * werden, wenn mehrere Exemplare einer
   * Karte hinzugefügt wurden.
   */
  const add = (
    c: CardRecord,
    reason: string,
    wanted = 1
  ): number => {
    const limit = Math.min(
      copyLimit(c, o.format),
      c.count
    );

    const current =
      used.get(c.id) ?? 0;

    const amount = Math.min(
      wanted,
      limit - current,
      slots
    );

    if (amount <= 0) {
      return 0;
    }

    const existing =
      selected.get(c.id);

    if (existing) {
      selected.set(
        c.id,
        {
          ...existing,
          count:
            existing.count + amount
        }
      );
    } else {
      selected.set(
        c.id,
        makeDeckCard(
          c,
          reason,
          c.count,
          amount
        )
      );
    }

    used.set(
      c.id,
      current + amount
    );

    slots -= amount;

    return amount;
  };

  const lands =
    filtered
      .filter(isLand)
      .sort(
        (a, b) =>
          (
            b.isBasicLand
              ? 1
              : 0
          ) -
            (
              a.isBasicLand
                ? 1
                : 0
            ) ||
          a.manaValue -
            b.manaValue
      );

  const nonlands =
    filtered.filter(
      card => !isLand(card)
    );

  const desiredLands =
    o.format === "commander"
      ? 36
      : 24;

  const desiredRamp =
    o.format === "commander"
      ? 10
      : 4;

  const desiredDraw =
    o.format === "commander"
      ? 10
      : 7;

  const desiredInteraction =
    o.format === "commander"
      ? 10
      : 8;

  /*
   * LÄNDER
   */
  let currentLandCount = 0;

  for (const card of lands) {
    if (
      slots <= 0 ||
      currentLandCount >=
        desiredLands
    ) {
      break;
    }

    const missingLands =
      desiredLands -
      currentLandCount;

    const wanted =
      card.isBasicLand ||
      BASIC_NAMES.has(card.name)
        ? Math.min(
            card.count,
            missingLands
          )
        : 1;

    const added =
      add(
        card,
        "Mana-Basis: Landquote",
        wanted
      );

    currentLandCount += added;
  }

  /*
   * ROLLEN
   */
  const fillRole = (
    role: string,
    wanted: number,
    reason: string
  ) => {
    const list =
      nonlands
        .filter(
          card =>
            roleOf(card) === role
        )
        .sort(
          (a, b) =>
            cardScore(
              b,
              o.format,
              o.targetManaValue
            ) -
            cardScore(
              a,
              o.format,
              o.targetManaValue
            )
        );

    let added = 0;

    for (const card of list) {
      if (
        added >= wanted ||
        slots <= 0
      ) {
        break;
      }

      const amount =
        add(
          card,
          reason,
          Math.min(
            wanted - added,
            copyLimit(
              card,
              o.format
            )
          )
        );

      added += amount;
    }
  };

  fillRole(
    "Ramp",
    desiredRamp,
    "Bewertet als Mana-Beschleunigung."
  );

  fillRole(
    "Card Advantage",
    desiredDraw,
    "Bewertet als Kartenvorteil."
  );

  fillRole(
    "Interaction",
    desiredInteraction,
    "Bewertet als Interaktion/Antwort."
  );

  fillRole(
    "Tutor",
    o.format === "commander"
      ? 4
      : 2,
    "Bewertet als Tutor für Konsistenz."
  );

  /*
   * RESTLICHE KARTEN
   */
  const remaining =
    nonlands
      .filter(
        card =>
          !selected.has(card.id)
      )
      .sort(
        (a, b) =>
          cardScore(
            b,
            o.format,
            o.targetManaValue
          ) -
          cardScore(
            a,
            o.format,
            o.targetManaValue
          )
      );

  for (const card of remaining) {
    if (slots <= 0) {
      break;
    }

    const min =
      o.minManaValue ?? 0;

    const max =
      o.maxManaValue ??
      Infinity;

    if (
      card.manaValue < min ||
      card.manaValue > max
    ) {
      continue;
    }

    /*
     * Standard darf bis zu vier Exemplare
     * verwenden, sofern sie tatsächlich
     * in der Sammlung vorhanden sind.
     *
     * Commander bleibt bei einem Exemplar,
     * außer für Basic Lands bzw. Karten mit
     * besonderer Copy-Regel.
     */
    const wanted =
      Math.min(
        copyLimit(
          card,
          o.format
        ),
        card.count,
        slots
      );

    add(
      card,
      "Gesamtbewertung aus Kurve, Rolle, Format und Farbidentität.",
      wanted
    );
  }

  /*
   * Falls nach den Nichtländern noch Plätze
   * frei sind, dürfen vorhandene Länder die
   * restlichen Plätze auffüllen.
   *
   * Das ist besonders wichtig, wenn eine
   * Sammlung noch klein ist.
   */
  if (slots > 0) {
    for (const card of lands) {
      if (slots <= 0) {
        break;
      }

      const remainingCopies =
        Math.min(
          copyLimit(
            card,
            o.format
          ),
          card.count
        ) -
        (
          used.get(card.id) ??
          0
        );

      if (
        remainingCopies <= 0
      ) {
        continue;
      }

      add(
        card,
        "Zusätzliches Land zum Auffüllen der Mana-Basis.",
        remainingCopies
      );
    }
  }

  const deckCards =
    [...selected.values()];

  const landCount =
    deckCards
      .filter(
        card =>
          card.role === "Land"
      )
      .reduce(
        (sum, card) =>
          sum + card.count,
        0
      );

  const totalCount =
    deckCards.reduce(
      (sum, card) =>
        sum + card.count,
      0
    );

  const nonlandCount =
    totalCount -
    landCount;

  /*
   * Länder zählen nicht in den
   * durchschnittlichen Mana Value hinein.
   */
  const nonlandManaTotal =
    deckCards
      .filter(
        card =>
          card.role !== "Land"
      )
      .reduce(
        (sum, card) =>
          sum +
          card.manaValue *
            card.count,
        0
      );

  const averageManaValue =
    nonlandManaTotal /
    Math.max(
      1,
      nonlandCount
    );

  const score =
    Math.round(
      Math.min(
        100,
        55 +
          Math.min(
            20,
            landCount >=
              desiredLands
              ? 20
              : landCount *
                0.5
          ) +
          Math.min(
            15,
            desiredRamp >= 8
              ? 10
              : 5
          ) +
          Math.min(
            10,
            deckCards
              .filter(card =>
                [
                  "Interaction",
                  "Card Advantage"
                ].includes(
                  card.role
                )
              )
              .reduce(
                (
                  sum,
                  card
                ) =>
                  sum +
                  card.count,
                0
              ) *
              0.5
          ) +
          Math.max(
            0,
            5 -
              Math.abs(
                averageManaValue -
                  o.targetManaValue
              )
          )
      )
    );

  /*
   * Verständlicher Hinweis für unvollständige
   * Decks.
   */
  let notes: string;

  if (slots <= 0) {
    notes =
      "Automatisch erstellt aus der vorhandenen Sammlung.";
  } else if (
    o.format === "standard" &&
    eligible.length === 0
  ) {
    notes =
      `Es konnten keine Standard-legalen Karten ` +
      `mit der gewählten Farbidentität gefunden werden. ` +
      `Es fehlen daher noch ${slots} Karten.`;
  } else if (
    o.format === "standard"
  ) {
    notes =
      `Das Deck wurde mit ${totalCount} passenden ` +
      `Standard-legalen Karten aus deiner Sammlung erstellt. ` +
      `Es fehlen noch ${slots} Karten bis zur Mindestgröße von 60.`;
  } else {
    notes =
      `Das Commander-Deck wurde mit ${totalCount} Karten ` +
      `aus deiner Sammlung erstellt. ` +
      `Es fehlen noch ${slots} Karten plus dem gewählten Commander ` +
      `bis zur vollständigen Deckgröße.`;
  }

  return {
    id: crypto.randomUUID(),
    name: o.name,
    format: o.format,
    commanderIds:
      commander
        ? [commander.id]
        : [],
    cards: deckCards,
    sideboard: [],
    targetManaValue:
      o.targetManaValue,
    minManaValue:
      o.minManaValue,
    maxManaValue:
      o.maxManaValue,
    colors: o.colors,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    score,
    notes
  };
}

export function commanderCandidates(
  pool: CardRecord[],
  colors: string[]
) {
  return pool.filter(
    card =>
      identityOk(
        card,
        colors
      ) &&
      commanderLegal(card)
  );
}

export function deckStats(
  deck: DeckRecord
) {
  const cards =
    deck.cards;

  const total =
    cards.reduce(
      (sum, card) =>
        sum + card.count,
      0
    );

  const lands =
    cards
      .filter(card =>
        /\bLand\b/i.test(
          card.typeLine ?? ""
        )
      )
      .reduce(
        (sum, card) =>
          sum + card.count,
        0
      );

  const nonland =
    total - lands;

  const manaTotal =
    cards
      .filter(card =>
        !/\bLand\b/i.test(
          card.typeLine ?? ""
        )
      )
      .reduce(
        (sum, card) =>
          sum +
          card.manaValue *
            card.count,
        0
      );

  const averageManaValue =
    manaTotal /
    Math.max(
      1,
      nonland
    );

  return {
    total,
    lands,
    nonland,
    averageManaValue:
      Number(
        averageManaValue.toFixed(
          2
        )
      ),
    roleCounts:
      cards.reduce<
        Record<string, number>
      >(
        (result, card) => {
          result[card.role] =
            (
              result[
                card.role
              ] ?? 0
            ) +
            card.count;

          return result;
        },
        {}
      )
  };
}