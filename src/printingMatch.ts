/**
 * Gemeinsame, deterministische Regeln für das Zuordnen importierter Zeilen
 * zu konkreten Scryfall-Druckversionen (Bulk- und API-Pfad).
 *
 * Grundsätze:
 * - Set + Collector Number sind autoritativ; ein Name überschreibt sie nie.
 * - Exakter Treffer → übernehmen. Genau ein sicherer Fallback → übernehmen.
 * - Mehrere mögliche Druckversionen → beim Sammlungsimport NICHT raten,
 *   sondern als "ambiguous" markieren. Der Deckimport braucht nur die Karte
 *   und nimmt bewusst eine deterministisch bevorzugte Druckversion.
 */

export interface MatchableCard {
  id: string;
  name: string;
  set: string;
  set_name?: string;
  collector_number: string;
  lang?: string;
  released_at?: string;
}

export type ImportMatchMode = "collection" | "deck";

export type MatchDecision<T extends MatchableCard> =
  | { status: "resolved"; card: T }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "not_found" };

/** Rohschlüssel: nur Kleinschreibung/Trim. */
export function rawCollectorNumber(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalisierte Collector Number: Bindestriche/Sonderzeichen (★, †, …) entfernt,
 * führende Nullen in Zahlenblöcken entfernt, Kleinschreibung.
 * Beispiele: "A-69" ≡ "a69", "069" ≡ "69", "123★" → "123".
 * Weil dadurch verschiedene Druckversionen zusammenfallen können, wird immer
 * zuerst der Rohschlüssel versucht; Mehrfachtreffer bleiben mehrdeutig.
 */
export function normalizeCollectorNumber(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(^|[a-z])0+(?=\d)/g, "$1");
}

/** Varianten für die API-Suche (Scryfall sucht `cn:` exakt). */
export function collectorNumberVariants(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const variants = new Set<string>([raw]);
  const withoutZeros = raw.replace(/(^|[A-Za-z-])0+(?=\d)/g, "$1");
  variants.add(withoutZeros);
  const prefixed = withoutZeros.match(/^([A-Za-z]{1,3})-?(\d+[A-Za-z]?)$/);
  if (prefixed) {
    variants.add(`${prefixed[1]}-${prefixed[2]}`);
    variants.add(`${prefixed[1]}${prefixed[2]}`);
  }
  return [...variants].filter(Boolean);
}

export function normalizeCardName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'")
    .replace(/\s*\/\/\s*/g, " // ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Vollständiger Name plus einzelne Seiten (für DFC/Split-Karten). */
export function cardNameKeys(value: string): string[] {
  const full = normalizeCardName(value);
  if (!full) return [];
  const faces = full.split(" // ").map(face => face.trim()).filter(Boolean);
  return Array.from(new Set([full, ...faces]));
}

/** Normalisierter Set-Wert: Setcode oder Setname. */
export function normalizeSetToken(value: string): string {
  return normalizeCardName(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function nameMatchRank(rowName: string, cardName: string): number {
  const row = normalizeCardName(rowName);
  const card = normalizeCardName(cardName);
  if (!row) return 1;
  if (row === card) return 3;
  const rowFaces = row.split(" // ");
  const cardFaces = card.split(" // ");
  // "A-Mischievous Catgeist" passt nur auf "A-Mischievous Catgeist // …",
  // niemals auf die nicht rebalancierte Fassung.
  if (rowFaces[0] === cardFaces[0]) return 2;
  if (cardFaces.includes(row) || rowFaces.includes(card)) return 1;
  return 0;
}

/** Deterministische Bevorzugung für den Deckimport (Englisch, neuestes Printing, Tie-Breaker). */
export function preferPrinting<T extends MatchableCard>(current: T | undefined, candidate: T): T {
  if (!current) return candidate;

  const currentEnglish = current.lang === "en" ? 1 : 0;
  const candidateEnglish = candidate.lang === "en" ? 1 : 0;
  if (candidateEnglish !== currentEnglish) {
    return candidateEnglish > currentEnglish ? candidate : current;
  }

  const releaseCompare = (candidate.released_at ?? "").localeCompare(current.released_at ?? "");
  if (releaseCompare !== 0) return releaseCompare > 0 ? candidate : current;

  const setCompare = candidate.set.localeCompare(current.set);
  if (setCompare !== 0) return setCompare > 0 ? candidate : current;

  const collectorCompare = candidate.collector_number.localeCompare(
    current.collector_number,
    undefined,
    { numeric: true }
  );
  if (collectorCompare !== 0) return collectorCompare > 0 ? candidate : current;

  return candidate.id.localeCompare(current.id) > 0 ? candidate : current;
}

function uniqueSorted<T extends MatchableCard>(cards: Iterable<T>): T[] {
  const byId = new Map<string, T>();
  for (const card of cards) byId.set(card.id, card);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Engt Kandidaten über den Namen ein (nur wenn das eindeutig etwas bringt). */
export function narrowByName<T extends MatchableCard>(rowName: string, candidates: T[]): T[] {
  if (candidates.length <= 1 || !rowName.trim()) return candidates;
  let best = 0;
  for (const card of candidates) best = Math.max(best, nameMatchRank(rowName, card.name));
  if (best === 0) return candidates;
  return candidates.filter(card => nameMatchRank(rowName, card.name) === best);
}

/** Filtert namensbasierte Kandidaten auf tatsächlich passende Namen. */
export function filterByName<T extends MatchableCard>(rowName: string, candidates: T[]): T[] {
  let best = 0;
  for (const card of candidates) best = Math.max(best, nameMatchRank(rowName, card.name));
  return best === 0 ? [] : candidates.filter(card => nameMatchRank(rowName, card.name) === best);
}

export interface MatchTiers<T extends MatchableCard> {
  /** Set + Collector Number (Rohschlüssel). */
  exactRaw?: Iterable<T>;
  /** Set + normalisierte Collector Number. */
  exactNormalized?: Iterable<T>;
  /** Setübergreifend: Name + normalisierte Collector Number. */
  nameCollector?: Iterable<T>;
  /** Set + Name (ohne Collector Number). */
  setName?: Iterable<T>;
  /** Nur Name. */
  name?: Iterable<T>;
}

/**
 * Entscheidet für eine Importzeile anhand der Kandidaten je Stufe.
 * Die erste Stufe mit Kandidaten entscheidet; spätere Stufen werden nicht
 * gemischt. So bleibt das Ergebnis unabhängig von der Datenreihenfolge.
 */
export function decidePrinting<T extends MatchableCard>(
  rowName: string,
  tiers: MatchTiers<T>,
  mode: ImportMatchMode
): MatchDecision<T> {
  // Set + Collector Number: autoritativ, Name dient nur zum Auflösen von Gleichständen.
  for (const tier of [tiers.exactRaw, tiers.exactNormalized]) {
    const candidates = narrowByName(rowName, uniqueSorted(tier ?? []));
    if (candidates.length === 1) return { status: "resolved", card: candidates[0] };
    if (candidates.length > 1) {
      return mode === "deck"
        ? { status: "resolved", card: candidates.reduce<T | undefined>(preferPrinting, undefined)! }
        : { status: "ambiguous", candidates };
    }
  }

  // Namensbasierte Fallbacks: der Name muss tatsächlich passen.
  for (const tier of [tiers.nameCollector, tiers.setName, tiers.name]) {
    const candidates = filterByName(rowName, uniqueSorted(tier ?? []));
    if (candidates.length === 1) return { status: "resolved", card: candidates[0] };
    if (candidates.length > 1) {
      // Deckimport: Deck braucht nur die Karte, nicht das exakte Printing.
      // Bewusst deterministisch statt nach Datenreihenfolge.
      return mode === "deck"
        ? { status: "resolved", card: candidates.reduce<T | undefined>(preferPrinting, undefined)! }
        : { status: "ambiguous", candidates };
    }
  }

  return { status: "not_found" };
}
