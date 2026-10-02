import type { CardRecord } from "./types";

/** Gemeinsame Such- und Filterlogik für Sammlung und Marketplace. */

export const COLOR_FILTER_OPTIONS: Array<[string, string]> = [
  ["W", "Weiß"],
  ["U", "Blau"],
  ["B", "Schwarz"],
  ["R", "Rot"],
  ["G", "Grün"],
  ["M", "Mehrfarbig"],
  ["C", "Farblos"]
];

export const TYPE_ORDER = [
  "Land",
  "Kreatur",
  "Planeswalker",
  "Spontanzauber",
  "Hexerei",
  "Verzauberung",
  "Artefakt",
  "Schlacht",
  "Sonstiges"
];

export const MANA_VALUE_OPTIONS = ["0", "1", "2", "3", "4", "5", "6", "7+"];

const SINGLE_COLORS = ["W", "U", "B", "R", "G"];

export type CardFilterState = {
  colors: Set<string>;
  types: Set<string>;
  sets: Set<string>;
  mana: Set<string>;
};

export function emptyCardFilters(): CardFilterState {
  return { colors: new Set(), types: new Set(), sets: new Set(), mana: new Set() };
}

export function activeFilterCount(filters: CardFilterState): number {
  return filters.colors.size + filters.types.size + filters.sets.size + filters.mana.size;
}

export function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function primaryTypeGroup(typeLine: string | undefined): string {
  const type = (typeLine ?? "").toLowerCase();

  if (type.includes("land")) return "Land";
  if (type.includes("creature")) return "Kreatur";
  if (type.includes("planeswalker")) return "Planeswalker";
  if (type.includes("instant")) return "Spontanzauber";
  if (type.includes("sorcery")) return "Hexerei";
  if (type.includes("enchantment")) return "Verzauberung";
  if (type.includes("artifact")) return "Artefakt";
  if (type.includes("battle")) return "Schlacht";

  return "Sonstiges";
}

export function cardMatchesColorFilter(card: CardRecord, filters: Set<string>): boolean {
  if (filters.size === 0) return true;

  const colors = card.colors ?? [];

  for (const filter of filters) {
    if (filter === "C" && colors.length === 0) return true;
    if (filter === "M" && colors.length > 1) return true;
    if (SINGLE_COLORS.includes(filter) && colors.includes(filter)) return true;
  }

  return false;
}

export function manaValueBucket(card: CardRecord): string {
  const mv = Math.max(0, Math.floor(Number.isFinite(card.manaValue) ? card.manaValue : 0));
  return mv >= 7 ? "7+" : String(mv);
}

export function cardMatchesQuery(card: CardRecord, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;

  return `${card.name} ${card.set} ${card.setName ?? ""} ${card.typeLine ?? ""} ${card.oracleText ?? ""}`
    .toLowerCase()
    .includes(normalized);
}

export function cardMatchesFilters(card: CardRecord, query: string, filters: CardFilterState): boolean {
  if (!cardMatchesQuery(card, query)) return false;
  if (!cardMatchesColorFilter(card, filters.colors)) return false;
  if (filters.types.size > 0 && !filters.types.has(primaryTypeGroup(card.typeLine))) return false;
  if (filters.sets.size > 0 && !filters.sets.has(card.set.toLowerCase())) return false;
  if (filters.mana.size > 0 && !filters.mana.has(manaValueBucket(card))) return false;
  return true;
}

export function filterCards(
  cards: CardRecord[],
  query: string,
  filters: CardFilterState
): CardRecord[] {
  return cards.filter(card => cardMatchesFilters(card, query, filters));
}
