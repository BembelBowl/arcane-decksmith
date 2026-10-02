import { useMemo } from "react";
import {
  COLOR_FILTER_OPTIONS,
  MANA_VALUE_OPTIONS,
  TYPE_ORDER,
  activeFilterCount,
  emptyCardFilters,
  toggleSetValue,
  type CardFilterState
} from "../cardFilters";
import type { CardRecord } from "../types";

type CardFilterBarProps = {
  /** Karten, aus denen die Set-Auswahl gebildet wird. */
  cards: CardRecord[];
  filters: CardFilterState;
  onChange: (filters: CardFilterState) => void;
  /** Gruppenname der <details>-Elemente (es ist immer nur ein Filter offen). */
  name: string;
  resultLabel?: string;
};

/** Filterleiste im Stil der Sammlung (gleiche CSS-Klassen). */
export default function CardFilterBar({ cards, filters, onChange, name, resultLabel }: CardFilterBarProps) {
  const setOptions = useMemo(() => {
    const bySet = new Map<string, string>();
    for (const card of cards) {
      bySet.set(card.set.toLowerCase(), card.setName ?? card.set.toUpperCase());
    }
    return [...bySet.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], "de", { sensitivity: "base" })
    );
  }, [cards]);

  const count = activeFilterCount(filters);
  const toggle = (key: keyof CardFilterState, value: string) =>
    onChange({ ...filters, [key]: toggleSetValue(filters[key], value) });

  return (
    <div className="collection-filter-bar">
      <details className="collection-filter-group" name={name}>
        <summary>Farbe {filters.colors.size > 0 ? `(${filters.colors.size})` : ""}</summary>
        <div className="collection-filter-options">
          {COLOR_FILTER_OPTIONS.map(([value, label]) => (
            <label key={value}>
              <input
                type="checkbox"
                checked={filters.colors.has(value)}
                onChange={() => toggle("colors", value)}
              />
              {label}
            </label>
          ))}
        </div>
      </details>

      <details className="collection-filter-group" name={name}>
        <summary>Kartentyp {filters.types.size > 0 ? `(${filters.types.size})` : ""}</summary>
        <div className="collection-filter-options">
          {TYPE_ORDER.map(type => (
            <label key={type}>
              <input
                type="checkbox"
                checked={filters.types.has(type)}
                onChange={() => toggle("types", type)}
              />
              {type}
            </label>
          ))}
        </div>
      </details>

      <details className="collection-filter-group collection-set-filter" name={name}>
        <summary>Set {filters.sets.size > 0 ? `(${filters.sets.size})` : ""}</summary>
        <div className="collection-filter-options collection-set-options">
          {setOptions.map(([code, setName]) => (
            <label key={code}>
              <input
                type="checkbox"
                checked={filters.sets.has(code)}
                onChange={() => toggle("sets", code)}
              />
              <span>{setName}</span>
              <small>{code.toUpperCase()}</small>
            </label>
          ))}
        </div>
      </details>

      <details className="collection-filter-group" name={name}>
        <summary>Mana Value {filters.mana.size > 0 ? `(${filters.mana.size})` : ""}</summary>
        <div className="collection-filter-options collection-mv-options">
          {MANA_VALUE_OPTIONS.map(value => (
            <label key={value}>
              <input
                type="checkbox"
                checked={filters.mana.has(value)}
                onChange={() => toggle("mana", value)}
              />
              MV {value}
            </label>
          ))}
        </div>
      </details>

      {count > 0 && (
        <button className="ghost" type="button" onClick={() => onChange(emptyCardFilters())}>
          Filter zurücksetzen ({count})
        </button>
      )}

      {resultLabel && <span className="collection-filter-result muted">{resultLabel}</span>}
    </div>
  );
}
