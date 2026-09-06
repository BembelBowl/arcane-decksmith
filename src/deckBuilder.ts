import type {
  CardRecord,
  DeckCard,
  DeckRecord,
  Format
} from "./types";

const COLOR_ORDER = ["W", "U", "B", "R", "G"];

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

export type DeckStrategy =
  | "balanced"
  | "aggressive"
  | "control"
  | "value"
  | "synergy"
  | "creatures"
  | "spells";

export interface DeckTuning {
  strategy?: DeckStrategy;
  lands?: number;
  ramp?: number;
  draw?: number;
  interaction?: number;
  boardwipes?: number;
  protection?: number;
  recursion?: number;
  synergy?: number;
  curve?: number;
  commanderSynergy?: number;
  aggression?: number;
}

export interface LockedDeckCard {
  id: string;
  count: number;
}

export interface DeckProfile {
  strategy: DeckStrategy;
  lands: number;
  ramp: number;
  draw: number;
  interaction: number;
  boardwipes: number;
  protection: number;
  recursion: number;
  tutors: number;
  synergy: number;
  finishers: number;
  targetManaValue: number;
  commanderSynergyWeight: number;
  aggressionWeight: number;
}

type Role =
  | "Land"
  | "Ramp"
  | "Card Advantage"
  | "Interaction"
  | "Boardwipe"
  | "Protection"
  | "Recursion"
  | "Tutor"
  | "Synergie"
  | "Finisher"
  | "Creature"
  | "Value";

interface ScoredCard {
  card: CardRecord;
  role: Role;
  score: number;
}

function clamp(
  value: number,
  min: number,
  max: number
) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAdjustment(value?: number) {
  return clamp(
    Number.isFinite(value) ? Number(value) : 0,
    -2,
    2
  );
}

function isLand(card: CardRecord) {
  return /\bLand\b/i.test(card.typeLine ?? "");
}

function isCreature(card: CardRecord) {
  return /\bCreature\b/i.test(card.typeLine ?? "");
}

function isInstantOrSorcery(card: CardRecord) {
  return /\bInstant\b|\bSorcery\b/i.test(
    card.typeLine ?? ""
  );
}

function stripReminderText(value: string) {
  let result = value;

  for (let pass = 0; pass < 4; pass += 1) {
    const next = result.replace(/\([^()]*\)/g, " ");

    if (next === result) {
      break;
    }

    result = next;
  }

  return result;
}

function cardText(card: CardRecord) {
  return `${card.typeLine ?? ""} ${stripReminderText(card.oracleText ?? "")}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function roleOf(card: CardRecord): Role {
  const text = cardText(card);

  if (isLand(card)) {
    return "Land";
  }

  if (
    /destroy all|exile all|all creatures get -|each creature gets -|deals? .* damage to each creature|each player sacrifices? .* creature|each opponent sacrifices? .* creature/.test(
      text
    )
  ) {
    return "Boardwipe";
  }

  if (
    /hexproof|indestructible|protection from|prevent all damage|can't be destroyed|(?:permanents?|creatures?) you control (?:phase|phases) out|target .* you control phases out|any number of target .* you control phase out/.test(
      text
    )
  ) {
    return "Protection";
  }

  if (
    /return .* from your graveyard|return target .* graveyard|from your graveyard to (your hand|the battlefield)|reanimate|you may cast .* from your graveyard/.test(
      text
    )
  ) {
    return "Recursion";
  }

  if (
    /destroy target|exile target|return target.*hand|counter target|deals? .* damage to target|target creature gets -/.test(
      text
    )
  ) {
    return "Interaction";
  }

  if (
    /add \{?[wubrgc]/.test(text) ||
    /add (?:one|two|three|four|x) mana/.test(text) ||
    /search your library for[^.]{0,220}(?:land|forest|plains|island|swamp|mountain) cards?[^.]{0,220}(?:put|puts)[^.]{0,160}onto the battlefield/.test(
      text
    ) ||
    /put (?:a|an|one|up to one|those|that) [^.]{0,120}(?:land|forest|plains|island|swamp|mountain) cards?[^.]{0,100}onto the battlefield/.test(
      text
    ) ||
    /mana.*pool/.test(text)
  ) {
    return "Ramp";
  }

  if (
    /draw (a|one|two|three|four|x|cards?)|draws? a card|card draw|look at the top .* put .* into your hand/.test(
      text
    )
  ) {
    return "Card Advantage";
  }

  if (/search your library/.test(text)) {
    return "Tutor";
  }

  if (
    /double .* power|double .* damage|extra combat|you win the game|loses? the game|damage .* equal to .* power|gets? \+\d+\/\+\d+ for each/.test(
      text
    )
  ) {
    return "Finisher";
  }

  if (
    /when .* enters|whenever|at the beginning|combat|create .* token|sacrifice|counter on|counters on|equipped|enchanted|artifact|enchantment/.test(
      text
    )
  ) {
    return isCreature(card)
      ? "Synergie"
      : "Value";
  }

  if (isCreature(card)) {
    return "Creature";
  }

  return "Value";
}

function standardLegal(card: CardRecord) {
  return card.legalities?.standard === "legal";
}

function commanderFormatLegal(card: CardRecord) {
  return card.legalities?.commander === "legal";
}

function isLegendaryCreature(card: CardRecord) {
  return (
    /\bLegendary\b/i.test(card.typeLine ?? "") &&
    /\bCreature\b/i.test(card.typeLine ?? "")
  );
}

function isBackground(card: CardRecord) {
  return (
    /\bLegendary\b/i.test(card.typeLine ?? "") &&
    /\bBackground\b/i.test(card.typeLine ?? "")
  );
}

function canBePrimaryCommander(card: CardRecord) {
  if (!commanderFormatLegal(card)) {
    return false;
  }

  return (
    isLegendaryCreature(card) ||
    /can be your commander/i.test(card.oracleText ?? "")
  );
}

function hasGenericPartner(card: CardRecord) {
  const oracle = card.oracleText ?? "";

  return (
    /(^|\n)partner(\s|$|\()/i.test(oracle) &&
    !/partner with/i.test(oracle)
  );
}

function hasFriendsForever(card: CardRecord) {
  return /friends forever/i.test(card.oracleText ?? "");
}

function hasDoctorsCompanion(card: CardRecord) {
  return /doctor'?s companion/i.test(card.oracleText ?? "");
}

function isDoctor(card: CardRecord) {
  return /\bDoctor\b/i.test(card.typeLine ?? "");
}

function choosesBackground(card: CardRecord) {
  return /choose a background/i.test(card.oracleText ?? "");
}

function partnerWithName(card: CardRecord) {
  const match = (card.oracleText ?? "").match(
    /partner with ([^(\n.]+)/i
  );

  return match?.[1]?.trim().toLowerCase();
}

function identityOk(
  card: CardRecord,
  colors: string[]
) {
  return (card.colorIdentity ?? []).every(
    color => colors.includes(color)
  );
}

export function commanderColorIdentity(
  commanders: CardRecord[]
) {
  const colors = new Set<string>();

  for (const commander of commanders) {
    for (const color of commander.colorIdentity ?? []) {
      colors.add(color);
    }
  }

  return [
    ...COLOR_ORDER.filter(color => colors.has(color)),
    ...[...colors]
      .filter(color => !COLOR_ORDER.includes(color))
      .sort()
  ];
}

export function commanderPairAllowed(
  first: CardRecord,
  second: CardRecord
) {
  if (
    first.id === second.id ||
    !commanderFormatLegal(first) ||
    !commanderFormatLegal(second)
  ) {
    return false;
  }

  const firstPartnerWith = partnerWithName(first);
  const secondPartnerWith = partnerWithName(second);

  if (
    firstPartnerWith === second.name.toLowerCase() ||
    secondPartnerWith === first.name.toLowerCase()
  ) {
    return true;
  }

  if (
    hasGenericPartner(first) &&
    hasGenericPartner(second)
  ) {
    return true;
  }

  if (
    hasFriendsForever(first) &&
    hasFriendsForever(second)
  ) {
    return true;
  }

  if (
    (hasDoctorsCompanion(first) && isDoctor(second)) ||
    (hasDoctorsCompanion(second) && isDoctor(first))
  ) {
    return true;
  }

  if (
    (choosesBackground(first) && isBackground(second)) ||
    (choosesBackground(second) && isBackground(first))
  ) {
    return true;
  }

  return false;
}

export function commanderCandidates(
  pool: CardRecord[],
  colors?: string[]
) {
  return pool.filter(card =>
    canBePrimaryCommander(card) &&
    (
      colors === undefined ||
      identityOk(card, colors)
    )
  );
}

export function commanderPairCandidates(
  pool: CardRecord[],
  primary: CardRecord
) {
  return pool.filter(card =>
    commanderPairAllowed(primary, card)
  );
}

export function deckCopyLimit(
  card: CardRecord,
  format: Format
) {
  const unlimited =
    card.isBasicLand ||
    BASIC_NAMES.has(card.name) ||
    /a deck can have any number/i.test(
      card.oracleText ?? ""
    );

  if (unlimited) {
    return Number.POSITIVE_INFINITY;
  }

  return format === "commander"
    ? 1
    : 4;
}

export function cardLegalForDeck(
  card: CardRecord,
  format: Format,
  colors: string[] = []
) {
  if (format === "standard") {
    return standardLegal(card);
  }

  return (
    commanderFormatLegal(card) &&
    identityOk(card, colors)
  );
}

function themeTags(card: CardRecord) {
  const text = cardText(card);
  const tags = new Set<string>();

  const rules: Array<[string, RegExp]> = [
    ["tokens", /create .* token|tokens? you control/],
    ["counters", /\+1\/\+1 counter|counter on|counters on|proliferate/],
    ["artifacts", /artifact|equipment|treasure/],
    ["enchantments", /enchantment|aura|enchanted/],
    ["graveyard", /graveyard|dies|died|discard/],
    ["sacrifice", /sacrifice/],
    ["lifegain", /gain .* life|lifelink|life total/],
    ["spells", /instant|sorcery|cast .* spell|noncreature spell/],
    ["creatures", /creature|creatures you control/],
    ["combat", /combat|attacks|attacking|deals combat damage/],
    ["equipment", /equipment|equipped|equip /],
    ["lands", /landfall|land enters|lands you control/],
    ["tribal", /choose a creature type|creatures? of the chosen type|creature type/]
  ];

  for (const [tag, pattern] of rules) {
    if (pattern.test(text)) {
      tags.add(tag);
    }
  }

  return tags;
}

function commanderSynergyScore(
  card: CardRecord,
  commanders: CardRecord[]
) {
  if (commanders.length === 0) {
    return 0;
  }

  const cardTags = themeTags(card);
  let overlap = 0;

  for (const commander of commanders) {
    const commanderTags = themeTags(commander);

    for (const tag of cardTags) {
      if (commanderTags.has(tag)) {
        overlap += 1;
      }
    }
  }

  return Math.min(6, overlap * 1.5);
}

function curveScore(
  card: CardRecord,
  targetManaValue: number,
  curveAdjustment: number
) {
  if (isLand(card)) {
    return 0;
  }

  const adjustedTarget = clamp(
    targetManaValue + curveAdjustment * 0.35,
    1.5,
    6
  );

  const distance = Math.abs(
    card.manaValue - adjustedTarget
  );

  return Math.max(0, 6 - distance * 2);
}

function strategyScore(
  card: CardRecord,
  strategy: DeckStrategy,
  role: Role,
  aggressionWeight: number
) {
  const text = cardText(card);
  let score = 0;

  if (strategy === "aggressive") {
    if (isCreature(card)) score += 3;
    if (card.manaValue <= 3) score += 3;

    if (
      /haste|attacks|combat damage|double strike|trample/.test(
        text
      )
    ) {
      score += 3;
    }
  }

  if (strategy === "control") {
    if (
      role === "Interaction" ||
      role === "Boardwipe" ||
      role === "Card Advantage" ||
      role === "Protection"
    ) {
      score += 4;
    }
  }

  if (strategy === "value") {
    if (
      role === "Card Advantage" ||
      role === "Recursion" ||
      role === "Tutor" ||
      role === "Value"
    ) {
      score += 4;
    }

    if (
      /when .* enters|whenever|at the beginning/.test(
        text
      )
    ) {
      score += 2;
    }
  }

  if (strategy === "synergy") {
    if (role === "Synergie") {
      score += 5;
    }

    if (
      /whenever|create .* token|counter on|sacrifice|equipped|enchanted/.test(
        text
      )
    ) {
      score += 2;
    }
  }

  if (strategy === "creatures") {
    if (isCreature(card)) {
      score += 5;
    }
  }

  if (strategy === "spells") {
    if (isInstantOrSorcery(card)) {
      score += 5;
    }

    if (
      role === "Interaction" ||
      role === "Card Advantage"
    ) {
      score += 2;
    }
  }

  if (aggressionWeight > 0) {
    if (isCreature(card)) {
      score += aggressionWeight;
    }

    if (card.manaValue <= 3) {
      score += aggressionWeight;
    }
  }

  if (aggressionWeight < 0) {
    if (
      role === "Interaction" ||
      role === "Protection" ||
      role === "Card Advantage"
    ) {
      score += Math.abs(
        aggressionWeight
      );
    }
  }

  return score;
}

function baseRoleScore(role: Role) {
  switch (role) {
    case "Ramp":
      return 9;

    case "Card Advantage":
      return 8;

    case "Interaction":
      return 8;

    case "Boardwipe":
      return 7;

    case "Protection":
      return 6;

    case "Recursion":
      return 6;

    case "Tutor":
      return 6;

    case "Synergie":
      return 6;

    case "Finisher":
      return 5;

    case "Creature":
      return 3;

    case "Value":
      return 3;

    default:
      return 0;
  }
}

function cardScore(
  card: CardRecord,
  format: Format,
  profile: DeckProfile,
  commanders: CardRecord[]
) {
  const role = roleOf(card);

  let score = baseRoleScore(role);

  score += curveScore(
    card,
    profile.targetManaValue,
    0
  );

  score += strategyScore(
    card,
    profile.strategy,
    role,
    profile.aggressionWeight
  );

  score +=
    commanderSynergyScore(
      card,
      commanders
    ) *
    profile.commanderSynergyWeight;

  if (
    format === "standard" &&
    standardLegal(card)
  ) {
    score += 2;
  }

  if (
    card.manaValue <= 2 &&
    role !== "Finisher"
  ) {
    score += 1;
  }

  return score;
}

function landScore(
  card: CardRecord,
  colors: string[]
) {
  const text = cardText(card);
  let score = 0;

  if (
    !card.isBasicLand &&
    !BASIC_NAMES.has(card.name)
  ) {
    score += 5;
  }

  for (const color of colors) {
    if (
      new RegExp(
        `\\{${color.toLowerCase()}\\}`,
        "i"
      ).test(text)
    ) {
      score += 2;
    }
  }

  if (
    /enters the battlefield tapped|enters tapped/.test(
      text
    )
  ) {
    score -= 2;
  }

  if (
    /add one mana of any color|any color/.test(
      text
    )
  ) {
    score += 4;
  }

  if (
    /scry|draw a card|cycling|channel/.test(
      text
    )
  ) {
    score += 1;
  }

  return score;
}

function roleStep(format: Format) {
  return format === "commander"
    ? 2
    : 1;
}

export function deckProfileFor(
  format: Format,
  targetManaValue: number,
  tuning: DeckTuning = {}
): DeckProfile {
  const strategy =
    tuning.strategy ??
    "balanced";

  const step =
    roleStep(format);

  const curveAdjustment =
    normalizeAdjustment(
      tuning.curve
    );

  const adjustedTargetManaValue =
    clamp(
      targetManaValue +
        curveAdjustment * 0.35,
      1.5,
      6
    );

  const commander =
    format === "commander";

  let lands =
    commander ? 36 : 24;

  if (
    adjustedTargetManaValue <= 2.4
  ) {
    lands -= commander ? 2 : 1;
  }

  if (
    adjustedTargetManaValue >= 3.8
  ) {
    lands += commander ? 2 : 1;
  }

  if (
    strategy === "aggressive"
  ) {
    lands -= 1;
  }

  if (
    strategy === "control"
  ) {
    lands += commander ? 1 : 0;
  }

  lands +=
    normalizeAdjustment(
      tuning.lands
    ) * step;

  const base =
    commander
      ? {
          ramp: 10,
          draw: 10,
          interaction: 8,
          boardwipes: 3,
          protection: 3,
          recursion: 3,
          tutors: 2,
          synergy: 12,
          finishers: 4
        }
      : {
          ramp: 3,
          draw: 6,
          interaction: 7,
          boardwipes: 2,
          protection: 2,
          recursion: 1,
          tutors: 1,
          synergy: 6,
          finishers: 3
        };

  if (
    strategy === "aggressive"
  ) {
    base.interaction -= 1;
    base.synergy +=
      commander ? 3 : 2;
    base.finishers +=
      commander ? 2 : 1;
  }

  if (
    strategy === "control"
  ) {
    base.draw +=
      commander ? 2 : 1;
    base.interaction +=
      commander ? 3 : 2;
    base.boardwipes += 1;
    base.protection += 1;
    base.synergy -=
      commander ? 2 : 1;
  }

  if (
    strategy === "value"
  ) {
    base.draw +=
      commander ? 2 : 1;
    base.recursion +=
      commander ? 2 : 1;
    base.synergy += 1;
  }

  if (
    strategy === "synergy"
  ) {
    base.synergy +=
      commander ? 5 : 3;

    base.tutors +=
      commander ? 1 : 0;
  }

  if (
    strategy === "creatures"
  ) {
    base.synergy +=
      commander ? 3 : 2;

    base.finishers += 1;
  }

  if (
    strategy === "spells"
  ) {
    base.draw +=
      commander ? 2 : 1;

    base.interaction +=
      commander ? 2 : 1;

    base.synergy +=
      commander ? 2 : 1;
  }

  const adjust = (
    value: number,
    userValue?: number
  ) =>
    Math.max(
      0,
      value +
        normalizeAdjustment(
          userValue
        ) *
          step
    );

  return {
    strategy,

    lands: clamp(
      lands,
      commander ? 30 : 20,
      commander ? 42 : 28
    ),

    ramp: adjust(
      base.ramp,
      tuning.ramp
    ),

    draw: adjust(
      base.draw,
      tuning.draw
    ),

    interaction: adjust(
      base.interaction,
      tuning.interaction
    ),

    boardwipes: adjust(
      base.boardwipes,
      tuning.boardwipes
    ),

    protection: adjust(
      base.protection,
      tuning.protection
    ),

    recursion: adjust(
      base.recursion,
      tuning.recursion
    ),

    tutors: base.tutors,

    synergy: adjust(
      base.synergy,
      tuning.synergy
    ),

    finishers:
      base.finishers,

    targetManaValue:
      adjustedTargetManaValue,

    commanderSynergyWeight:
      commander
        ? 1 +
          normalizeAdjustment(
            tuning.commanderSynergy
          ) *
            0.35
        : 0,

    aggressionWeight:
      normalizeAdjustment(
        tuning.aggression
      )
  };
}

function makeDeckCard(
  card: CardRecord,
  reason: string,
  available: number,
  count = 1
): DeckCard {
  return {
    id: card.id,
    name: card.name,
    count,
    manaValue: card.manaValue,
    typeLine: card.typeLine,
    role: roleOf(card),
    reason,
    available
  };
}

export interface BuildOptions {
  name: string;
  format: Format;
  colors: string[];

  commander?: CardRecord;
  commanders?: CardRecord[];

  targetManaValue: number;
  minManaValue?: number;
  maxManaValue?: number;

  tuning?: DeckTuning;
  lockedCards?: LockedDeckCard[];
  excludedCardIds?: string[];
}

export function buildDeck(
  pool: CardRecord[],
  options: BuildOptions
): DeckRecord {
  const commanders =
    options.format === "commander"
      ? (
          options.commanders?.length
            ? options.commanders
            : options.commander
              ? [options.commander]
              : []
        ).slice(0, 2)
      : [];

  const colors =
    options.format === "commander" &&
    commanders.length > 0
      ? commanderColorIdentity(
          commanders
        )
      : options.colors;

  const profile =
    deckProfileFor(
      options.format,
      options.targetManaValue,
      options.tuning
    );

  const colorEligible =
    pool.filter(card =>
      identityOk(
        card,
        colors
      )
    );

  const eligible =
    colorEligible.filter(card =>
      options.format === "commander"
        ? commanderFormatLegal(
            card
          )
        : standardLegal(card)
    );

  const commanderIds =
    new Set(
      commanders.map(
        card => card.id
      )
    );

  const excludedIds =
    new Set(
      options.excludedCardIds ??
        []
    );

  const filtered =
    eligible.filter(card =>
      !commanderIds.has(
        card.id
      ) &&
      !excludedIds.has(
        card.id
      )
    );

  const commanderSlots =
    options.format === "commander"
      ? Math.max(
          1,
          commanders.length
        )
      : 0;

  const target =
    options.format === "commander"
      ? 100 - commanderSlots
      : 60;

  const selected =
    new Map<
      string,
      DeckCard
    >();

  const usedById =
    new Map<
      string,
      number
    >();

  const usedByName =
    new Map<
      string,
      number
    >();

  let slots = target;

  const add = (
    card: CardRecord,
    reason: string,
    wanted = 1
  ): number => {
    const nameKey =
      card.name.toLowerCase();

    const ruleLimit =
      deckCopyLimit(
        card,
        options.format
      );

    const currentByName =
      usedByName.get(
        nameKey
      ) ?? 0;

    const currentById =
      usedById.get(
        card.id
      ) ?? 0;

    const amount =
      Math.min(
        wanted,
        ruleLimit -
          currentByName,
        card.count -
          currentById,
        slots
      );

    if (amount <= 0) {
      return 0;
    }

    const existing =
      selected.get(
        card.id
      );

    if (existing) {
      selected.set(
        card.id,
        {
          ...existing,
          count:
            existing.count +
            amount
        }
      );
    } else {
      selected.set(
        card.id,
        makeDeckCard(
          card,
          reason,
          card.count,
          amount
        )
      );
    }

    usedById.set(
      card.id,
      currentById +
        amount
    );

    usedByName.set(
      nameKey,
      currentByName +
        amount
    );

    slots -= amount;

    return amount;
  };

  const minManaValue =
    options.minManaValue ??
    0;

  const maxManaValue =
    options.maxManaValue ??
    Infinity;

  const inManaRange = (
    card: CardRecord
  ) =>
    card.manaValue >=
      minManaValue &&
    card.manaValue <=
      maxManaValue;

  const lands =
    filtered
      .filter(isLand)
      .sort(
        (a, b) =>
          landScore(
            b,
            colors
          ) -
            landScore(
              a,
              colors
            ) ||
          Number(
            a.isBasicLand
          ) -
            Number(
              b.isBasicLand
            ) ||
          a.name.localeCompare(
            b.name
          )
      );

  const nonlands =
    filtered.filter(
      card =>
        !isLand(card) &&
        inManaRange(card)
    );

  const byId =
    new Map(
      filtered.map(
        card => [
          card.id,
          card
        ]
      )
    );

  for (
    const locked
    of options.lockedCards ??
      []
  ) {
    const card =
      byId.get(
        locked.id
      );

    if (
      !card ||
      slots <= 0
    ) {
      continue;
    }

    add(
      card,
      "Vom Benutzer fixiert und bei der Optimierung beibehalten.",
      Math.max(
        1,
        locked.count
      )
    );
  }

  const countRole = (
    role: Role
  ) =>
    [
      ...selected.values()
    ]
      .filter(
        card =>
          card.role === role
      )
      .reduce(
        (sum, card) =>
          sum +
          card.count,
        0
      );

  const countLands = () =>
    [
      ...selected.values()
    ]
      .filter(
        card =>
          card.role === "Land"
      )
      .reduce(
        (sum, card) =>
          sum +
          card.count,
        0
      );

  let currentLandCount =
    countLands();

  for (const card of lands) {
    if (
      slots <= 0 ||
      currentLandCount >=
        profile.lands
    ) {
      break;
    }

    const missingLands =
      profile.lands -
      currentLandCount;

    const wanted =
      card.isBasicLand ||
      BASIC_NAMES.has(
        card.name
      )
        ? Math.min(
            card.count,
            missingLands
          )
        : 1;

    currentLandCount +=
      add(
        card,
        landScore(
          card,
          colors
        ) >= 5
          ? "Mana-Basis: bevorzugt wegen Farbfixing oder zusätzlichem Landnutzen."
          : "Mana-Basis: für die Ziel-Landquote ausgewählt.",
        wanted
      );
  }

  const scoredNonlands:
    ScoredCard[] =
      nonlands.map(
        card => ({
          card,

          role:
            roleOf(card),

          score:
            cardScore(
              card,
              options.format,
              profile,
              commanders
            )
        })
      );

  const roleTargets:
    Array<{
      role: Role;
      target: number;
      reason: string;
    }> = [
      {
        role: "Ramp",
        target:
          profile.ramp,
        reason:
          "Ausgewählt, um den Zielwert für Mana-Beschleunigung zu erreichen."
      },
      {
        role:
          "Card Advantage",
        target:
          profile.draw,
        reason:
          "Ausgewählt, um den Zielwert für Kartennachschub und Kartenvorteil zu erreichen."
      },
      {
        role:
          "Interaction",
        target:
          profile.interaction,
        reason:
          "Ausgewählt, um genügend direkte Interaktion und Antworten bereitzustellen."
      },
      {
        role:
          "Boardwipe",
        target:
          profile.boardwipes,
        reason:
          "Ausgewählt, um den Zielwert für breite Antworten auf das Spielfeld zu erreichen."
      },
      {
        role:
          "Protection",
        target:
          profile.protection,
        reason:
          "Ausgewählt, um wichtige Karten und die eigene Strategie besser zu schützen."
      },
      {
        role:
          "Recursion",
        target:
          profile.recursion,
        reason:
          "Ausgewählt, um Ressourcen aus dem Friedhof erneut nutzbar zu machen."
      },
      {
        role:
          "Tutor",
        target:
          profile.tutors,
        reason:
          "Ausgewählt, um die Konsistenz des Decks zu erhöhen."
      },
      {
        role:
          "Synergie",
        target:
          profile.synergy,
        reason:
          "Ausgewählt, weil die Karte zur gewünschten Deckstrategie bzw. zu erkannten Commander-Themen passt."
      },
      {
        role:
          "Finisher",
        target:
          profile.finishers,
        reason:
          "Ausgewählt als möglicher Abschluss für die Deckstrategie."
      }
    ];

  const fillRole = (
    role: Role,
    targetCount: number,
    reason: string
  ) => {
    const current =
      countRole(role);

    let missing =
      Math.max(
        0,
        targetCount -
          current
      );

    if (
      missing <= 0 ||
      slots <= 0
    ) {
      return;
    }

    const candidates =
      scoredNonlands
        .filter(
          item =>
            item.role ===
            role
        )
        .sort(
          (a, b) =>
            b.score -
              a.score ||
            a.card
              .manaValue -
              b.card
                .manaValue ||
            a.card.name.localeCompare(
              b.card.name
            )
        );

    for (
      const item
      of candidates
    ) {
      if (
        missing <= 0 ||
        slots <= 0
      ) {
        break;
      }

      const before =
        slots;

      const added =
        add(
          item.card,
          reason,
          Math.min(
            missing,
            item.card.count,
            deckCopyLimit(
              item.card,
              options.format
            )
          )
        );

      if (added > 0) {
        missing -= added;
      }

      if (
        slots ===
          before &&
        added === 0
      ) {
        continue;
      }
    }
  };

  for (
    const roleTarget
    of roleTargets
  ) {
    fillRole(
      roleTarget.role,
      roleTarget.target,
      roleTarget.reason
    );
  }

  const remaining =
    [
      ...scoredNonlands
    ].sort(
      (a, b) =>
        b.score -
          a.score ||
        a.card
          .manaValue -
          b.card
            .manaValue ||
        a.card.name.localeCompare(
          b.card.name
        )
    );

  for (
    const item
    of remaining
  ) {
    if (slots <= 0) {
      break;
    }

    const synergy =
      commanderSynergyScore(
        item.card,
        commanders
      );

    const reason =
      synergy > 0
        ? "Gesamtoptimierung: gute Bewertung aus Rolle, Mana-Kurve und erkennbarer Commander-/Strategie-Synergie."
        : "Gesamtoptimierung: gute Bewertung aus Rolle, Mana-Kurve und gewählter Deckstrategie.";

    add(
      item.card,
      reason,
      Math.min(
        deckCopyLimit(
          item.card,
          options.format
        ),
        item.card.count,
        slots
      )
    );
  }

  if (slots > 0) {
    for (
      const card
      of lands
    ) {
      if (slots <= 0) {
        break;
      }

      const remainingCopies =
        Math.min(
          deckCopyLimit(
            card,
            options.format
          ),
          card.count
        ) -
        (
          usedById.get(
            card.id
          ) ?? 0
        );

      if (
        remainingCopies <=
        0
      ) {
        continue;
      }

      add(
        card,
        "Zusätzliches Land zum Auffüllen eines aus der Sammlung sonst nicht vollständig baubaren Decks.",
        remainingCopies
      );
    }
  }

  const deckCards = [
    ...selected.values()
  ];

  const mainDeckCount =
    deckCards.reduce(
      (sum, card) =>
        sum +
        card.count,
      0
    );

  const landCount =
    deckCards
      .filter(
        card =>
          card.role ===
          "Land"
      )
      .reduce(
        (sum, card) =>
          sum +
          card.count,
        0
      );

  const nonlandCount =
    mainDeckCount -
    landCount;

  const nonlandManaTotal =
    deckCards
      .filter(
        card =>
          card.role !==
          "Land"
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

  const roleCount = (
    role: string
  ) =>
    deckCards
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

  const targetPairs:
    Array<
      [
        number,
        number
      ]
    > = [
      [
        roleCount("Ramp"),
        profile.ramp
      ],
      [
        roleCount(
          "Card Advantage"
        ),
        profile.draw
      ],
      [
        roleCount(
          "Interaction"
        ),
        profile.interaction
      ],
      [
        roleCount(
          "Boardwipe"
        ),
        profile.boardwipes
      ],
      [
        roleCount(
          "Protection"
        ),
        profile.protection
      ],
      [
        roleCount(
          "Recursion"
        ),
        profile.recursion
      ],
      [
        roleCount(
          "Synergie"
        ),
        profile.synergy
      ]
    ];

  const roleCoverage =
    targetPairs.reduce(
      (
        sum,
        [
          actual,
          wanted
        ]
      ) => {
        if (
          wanted <= 0
        ) {
          return (
            sum + 1
          );
        }

        return (
          sum +
          Math.min(
            1,
            actual /
              wanted
          )
        );
      },
      0
    ) /
    Math.max(
      1,
      targetPairs.length
    );

  const landCoverage =
    Math.min(
      1,
      landCount /
        Math.max(
          1,
          profile.lands
        )
    );

  const curveCoverage =
    clamp(
      1 -
        Math.abs(
          averageManaValue -
            profile.targetManaValue
        ) /
          3,
      0,
      1
    );

  const completeness =
    mainDeckCount /
    Math.max(
      1,
      target
    );

  const score =
    Math.round(
      clamp(
        completeness *
          35 +
          landCoverage *
            20 +
          roleCoverage *
            30 +
          curveCoverage *
            15,
        0,
        100
      )
    );

  let notes: string;

  if (slots <= 0) {
    notes =
      options.format ===
      "commander"
        ? `Commander-Deck vollständig aus der vorhandenen Sammlung optimiert (${mainDeckCount} Karten im Hauptdeck plus ${commanders.length || 1} Commander). Strategie: ${profile.strategy}. Ziel-Länder: ${profile.lands}, Ziel-MV: ${profile.targetManaValue.toFixed(1)}.`
        : `Standard-Deck vollständig aus der vorhandenen Sammlung optimiert. Strategie: ${profile.strategy}. Ziel-Länder: ${profile.lands}, Ziel-MV: ${profile.targetManaValue.toFixed(1)}.`;
  } else if (
    options.format ===
      "standard" &&
    eligible.length === 0
  ) {
    notes =
      `Es konnten keine Standard-legalen Karten mit der gewählten Farbauswahl gefunden werden. ` +
      `Es fehlen daher noch ${slots} Karten.`;
  } else if (
    options.format ===
    "standard"
  ) {
    notes =
      `Das Deck wurde mit ${mainDeckCount} passenden Standard-legalen Karten aus deiner Sammlung optimiert. ` +
      `Es fehlen noch ${slots} Karten bis zur Mindestgröße von 60.`;
  } else {
    const commanderCount =
      commanders.length ||
      1;

    notes =
      `Das Commander-Deck wurde mit ${mainDeckCount} Karten im Hauptdeck optimiert. ` +
      `Es fehlen noch ${slots} Karten bis zu ${100 - commanderCount} Hauptdeck-Karten ` +
      `plus ${commanderCount} Commander.`;
  }

  return {
    id:
      crypto.randomUUID(),

    name:
      options.name,

    format:
      options.format,

    commanderIds:
      commanders.map(
        card =>
          card.id
      ),

    cards:
      deckCards,

    sideboard: [],

    targetManaValue:
      profile.targetManaValue,

    minManaValue:
      options.minManaValue,

    maxManaValue:
      options.maxManaValue,

    colors,

    createdAt:
      Date.now(),

    updatedAt:
      Date.now(),

    score,

    notes
  };
}

export function deckStats(
  deck: DeckRecord
) {
  const cards =
    deck.cards;

  const mainDeckCount =
    cards.reduce(
      (sum, card) =>
        sum +
        card.count,
      0
    );

  const commanderCount =
    deck.format ===
    "commander"
      ? deck
          .commanderIds
          .length
      : 0;

  const total =
    mainDeckCount +
    commanderCount;

  const lands =
    cards
      .filter(card =>
        /\bLand\b/i.test(
          card.typeLine ??
            ""
        )
      )
      .reduce(
        (sum, card) =>
          sum +
          card.count,
        0
      );

  const nonland =
    mainDeckCount -
    lands;

  const manaTotal =
    cards
      .filter(
        card =>
          !/\bLand\b/i.test(
            card.typeLine ??
              ""
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
        Record<
          string,
          number
        >
      >(
        (
          result,
          card
        ) => {
          result[
            card.role
          ] =
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