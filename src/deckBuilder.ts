import type { CardRecord, DeckCard, DeckRecord, Format } from "./types";

const COLORS = ["W", "U", "B", "R", "G"];
const BASIC_NAMES = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes", "Ebene", "Insel", "Sumpf", "Gebirge", "Wald", "Ödnis"]);

function isLand(c: CardRecord) { return /\bLand\b/i.test(c.typeLine ?? ""); }
function isCreature(c: CardRecord) { return /\bCreature\b/i.test(c.typeLine ?? ""); }
function text(c: CardRecord) { return `${c.typeLine ?? ""} ${c.oracleText ?? ""}`.toLowerCase(); }
function roleOf(c: CardRecord): string {
  const t = text(c);
  if (isLand(c)) return "Land";
  if (/add \{?[wubrgc]/.test(t) || /search your library for (a|an) (basic )?land/.test(t) || /mana.*pool/.test(t) || /ramp/.test(t)) return "Ramp";
  if (/draw (a|one|two|three|x|cards?)|draws? a card|card draw/.test(t)) return "Card Advantage";
  if (/destroy target|exile target|return target.*hand|counter target|deals? .* damage to target|target creature gets -/.test(t)) return "Interaction";
  if (/search your library/.test(t)) return "Tutor";
  if (/when .* enters|whenever|at the beginning|combat/.test(t)) return isCreature(c) ? "Synergie" : "Value";
  if (isCreature(c)) return "Creature";
  return "Value";
}

function commanderLegal(c: CardRecord) {
  const t = text(c);
  return c.legalities?.commander !== "banned" &&
    (/\bLegendary\b.*\bCreature\b/i.test(c.typeLine ?? "") || /can be your commander|partner|friends forever|doctor's companion|choose a background/i.test(t));
}
function standardLegal(c: CardRecord) { return c.legalities?.standard === "legal"; }
function identityOk(c: CardRecord, colors: string[]) {
  return (c.colorIdentity ?? []).every((x) => colors.includes(x));
}
function copyLimit(c: CardRecord, format: Format) {
  if (format === "commander") return c.isBasicLand || BASIC_NAMES.has(c.name) || /a deck can have any number/i.test(c.oracleText ?? "") ? 99 : 1;
  return c.isBasicLand || BASIC_NAMES.has(c.name) || /a deck can have any number/i.test(c.oracleText ?? "") ? 99 : 4;
}
function cardScore(c: CardRecord, format: Format, targetMV?: number) {
  const role = roleOf(c);
  let s = 0;
  if (role === "Ramp") s += 8;
  if (role === "Card Advantage") s += 7;
  if (role === "Interaction") s += 7;
  if (role === "Tutor") s += 6;
  if (role === "Synergie") s += 6;
  if (isCreature(c)) s += 3;
  if (c.manaValue <= 3) s += 3;
  if (targetMV != null) s += Math.max(0, 4 - Math.abs(c.manaValue - targetMV));
  if (format === "standard" && c.legalities?.standard === "legal") s += 3;
  return s;
}

function makeDeckCard(c: CardRecord, reason: string, available: number, count = 1): DeckCard {
  return { id: c.id, name: c.name, count, manaValue: c.manaValue, typeLine: c.typeLine, role: roleOf(c), reason, available };
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

export function buildDeck(pool: CardRecord[], o: BuildOptions): DeckRecord {
  const eligible = pool.filter((c) => identityOk(c, o.colors) && (o.format === "commander" ? c.legalities?.commander !== "banned" : standardLegal(c)));
  const commander = o.commander;
  const filtered = commander ? eligible.filter((c) => c.id !== commander.id) : eligible;
  const target = o.format === "commander" ? 99 : 60;
  const selected = new Map<string, DeckCard>();
  const used = new Map<string, number>();
  const add = (c: CardRecord, reason: string, wanted = 1) => {
    const lim = Math.min(copyLimit(c, o.format), c.count);
    const current = used.get(c.id) ?? 0;
    const n = Math.min(wanted, lim - current);
    if (n <= 0) return false;
    selected.set(c.id, makeDeckCard(c, reason, c.count, n));
    used.set(c.id, current + n);
    return true;
  };

  const lands = filtered.filter(isLand).sort((a,b) => (b.isBasicLand ? 1 : 0) - (a.isBasicLand ? 1 : 0) || a.manaValue - b.manaValue);
  const nonlands = filtered.filter((c) => !isLand(c));
  const desiredLands = o.format === "commander" ? 36 : 24;
  const desiredRamp = o.format === "commander" ? 10 : 4;
  const desiredDraw = o.format === "commander" ? 10 : 7;
  const desiredInteraction = o.format === "commander" ? 10 : 8;

  let slots = target;
  for (const c of lands) {
    if (slots <= 0) break;
    const want = c.isBasicLand || BASIC_NAMES.has(c.name) ? Math.min(c.count, Math.max(1, desiredLands - [...selected.values()].filter(x => x.role === "Land").reduce((n,x) => n+x.count,0))) : 1;
    if (want > 0 && add(c, "Mana-Basis: Landquote")) slots -= Math.min(want, c.count);
  }
  const fillRole = (role: string, wanted: number, reason: string) => {
    const list = nonlands.filter(c => roleOf(c) === role).sort((a,b) => cardScore(b,o.format,o.targetManaValue)-cardScore(a,o.format,o.targetManaValue));
    let added = 0;
    for (const c of list) {
      if (added >= wanted || slots <= 0) break;
      if (add(c, reason)) { added++; slots--; }
    }
  };
  fillRole("Ramp", desiredRamp, "Bewertet als Mana-Beschleunigung.");
  fillRole("Card Advantage", desiredDraw, "Bewertet als Kartenvorteil.");
  fillRole("Interaction", desiredInteraction, "Bewertet als Interaktion/Antwort.");
  fillRole("Tutor", o.format === "commander" ? 4 : 2, "Bewertet als Tutor für Konsistenz.");

  const remaining = nonlands.filter(c => !selected.has(c.id))
    .sort((a,b) => cardScore(b,o.format,o.targetManaValue)-cardScore(a,o.format,o.targetManaValue));
  for (const c of remaining) {
    if (slots <= 0) break;
    const min = o.minManaValue ?? 0, max = o.maxManaValue ?? Infinity;
    if (c.manaValue < min || c.manaValue > max) continue;
    if (add(c, "Gesamtbewertung aus Kurve, Rolle, Format und Farbidentität.")) slots--;
  }
  const deckCards = [...selected.values()];
  const landCount = deckCards.filter(x => x.role === "Land").reduce((n,x) => n+x.count,0);
  const nonlandCount = deckCards.reduce((n,x) => n+x.count,0) - landCount;
  const avg = deckCards.reduce((s,x) => s + x.manaValue*x.count,0) / Math.max(1, nonlandCount);
  const score = Math.round(Math.min(100, 55 + Math.min(20, landCount >= desiredLands ? 20 : landCount * 0.5) + Math.min(15, (desiredRamp >= 8 ? 10 : 5)) + Math.min(10, deckCards.filter(x=>["Interaction","Card Advantage"].includes(x.role)).length * 0.5) + Math.max(0, 5 - Math.abs(avg-o.targetManaValue))));
  return {
    id: crypto.randomUUID(),
    name: o.name,
    format: o.format,
    commanderIds: commander ? [commander.id] : [],
    cards: deckCards,
    sideboard: [],
    targetManaValue: o.targetManaValue,
    minManaValue: o.minManaValue,
    maxManaValue: o.maxManaValue,
    colors: o.colors,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    score,
    notes: slots > 0 ? `Es fehlen ${slots} Karten in der vorhandenen Sammlung.` : "Automatisch erstellt aus der vorhandenen Sammlung."
  };
}

export function commanderCandidates(pool: CardRecord[], colors: string[]) {
  return pool.filter(c => identityOk(c, colors) && commanderLegal(c));
}

export function deckStats(deck: DeckRecord) {
  const cards = deck.cards;
  const total = cards.reduce((n,c)=>n+c.count,0);
  const lands = cards.filter(c=>/\bLand\b/i.test(c.typeLine ?? "")).reduce((n,c)=>n+c.count,0);
  const nonland = total - lands;
  const avg = cards.reduce((n,c)=>n+c.manaValue*c.count,0)/Math.max(1,nonland);
  return { total, lands, nonland, averageManaValue: Number(avg.toFixed(2)), roleCounts: cards.reduce<Record<string,number>>((a,c)=>(a[c.role]=(a[c.role]??0)+c.count,a),{}) };
}
