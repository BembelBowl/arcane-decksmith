import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadPreconDeck,
  loadPreconDeckList,
  preconCollectionCards,
  resolvePreconDeck,
  type PreconDeck,
  type PreconDeckSummary,
  type PreconResolution
} from "../precons";
import type { CardRecord } from "../types";
import { useDialogA11y } from "./useDialogA11y";
import "../importDialog.css";

type PreconImportDialogProps = {
  collection: CardRecord[];
  onClose: () => void;
  onAddCards: (cards: CardRecord[]) => Promise<void>;
};

const MAX_LIST_RESULTS = 60;

function sectionLabel(section: string): string {
  if (section === "commander") return "Commander";
  if (section === "sideboard") return "Zusatzkarten";
  return "Deck";
}

export default function PreconImportDialog({
  collection,
  onClose,
  onAddCards
}: PreconImportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [decks, setDecks] = useState<PreconDeckSummary[]>([]);
  const [listBusy, setListBusy] = useState(true);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("Commander Deck");
  const [deck, setDeck] = useState<PreconDeck | null>(null);
  const [resolution, setResolution] = useState<PreconResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ processed: 0, total: 0 });
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");

  useDialogA11y(dialogRef, () => {
    if (!busy) onClose();
  });

  useEffect(() => {
    let cancelled = false;
    loadPreconDeckList()
      .then(list => {
        if (!cancelled) setDecks(list);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Precon-Liste konnte nicht geladen werden.");
      })
      .finally(() => {
        if (!cancelled) setListBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const types = useMemo(
    () => Array.from(new Set(decks.map(item => item.type))).sort((a, b) => a.localeCompare(b, "de")),
    [decks]
  );

  const filteredDecks = useMemo(() => {
    const search = query.trim().toLowerCase();
    return decks.filter(item =>
      (!type || item.type === type) &&
      (!search ||
        item.name.toLowerCase().includes(search) ||
        item.code.toLowerCase() === search ||
        item.releaseDate.startsWith(search))
    );
  }, [decks, query, type]);

  const visibleDecks = filteredDecks.slice(0, MAX_LIST_RESULTS);

  const collectionCards = useMemo(
    () => resolution ? preconCollectionCards(resolution.resolved) : [],
    [resolution]
  );

  const totalCopies = deck?.rows.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const resolvedCopies = resolution?.resolved.reduce((sum, item) => sum + item.row.count, 0) ?? 0;
  const unresolvedCopies = resolution?.unresolved.reduce((sum, row) => sum + row.count, 0) ?? 0;

  const ownedIds = useMemo(() => new Set(collection.map(card => card.id)), [collection]);
  const alreadyOwned = collectionCards.filter(card => ownedIds.has(card.id)).length;

  const groupedRows = useMemo(() => {
    if (!resolution) return [];
    const sections = ["commander", "main", "sideboard"] as const;
    return sections
      .map(section => ({
        section,
        rows: resolution.resolved
          .filter(item => item.row.section === section)
          .sort((a, b) => a.card.name.localeCompare(b.card.name, "de"))
      }))
      .filter(group => group.rows.length > 0);
  }, [resolution]);

  const selectDeck = async (summary: PreconDeckSummary) => {
    setBusy(true);
    setError("");
    setDeck(null);
    setResolution(null);
    setConfirmed(false);
    setProgress({ processed: 0, total: 0 });

    try {
      const loaded = await loadPreconDeck(summary);
      setDeck(loaded);
      setProgress({ processed: 0, total: loaded.rows.length });
      const resolved = await resolvePreconDeck(loaded, (processed, total) =>
        setProgress({ processed, total })
      );
      setResolution(resolved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deck konnte nicht geladen werden.");
    } finally {
      setBusy(false);
    }
  };

  const backToList = () => {
    setDeck(null);
    setResolution(null);
    setConfirmed(false);
    setError("");
  };

  const apply = async () => {
    if (!resolution || !confirmed || busy || collectionCards.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await onAddCards(collectionCards);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Karten konnten nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="external-import-backdrop">
      <div
        ref={dialogRef}
        className="external-import-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="precon-import-title"
      >
        <div className="external-import-head">
          <div>
            <h2 id="precon-import-title">Precon-Deck zur Sammlung hinzufügen</h2>
            <p className="muted">
              Wähle ein vorkonstruiertes Deck. Alle Karten werden mit ihrer exakten Druckversion (Set, Nummer, Foil) aus MTGJSON übernommen und vor dem Speichern angezeigt.
            </p>
          </div>
          <button className="secondary" type="button" onClick={onClose} disabled={busy} aria-label="Dialog schließen">×</button>
        </div>

        {!deck && (
          <div className="external-import-source">
            <div className="external-import-deck-fields">
              <label>
                <span>Suche</span>
                <input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder="Name, Setcode oder Jahr"
                  autoFocus
                />
              </label>
              <label>
                <span>Produkttyp</span>
                <select value={type} onChange={event => setType(event.target.value)}>
                  <option value="">Alle Typen</option>
                  {types.map(item => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            </div>

            {listBusy ? (
              <div className="external-import-loading" role="status">
                <div className="external-import-loading-spinner" aria-hidden="true" />
                <div className="external-import-loading-copy"><strong>Precon-Liste wird geladen…</strong></div>
              </div>
            ) : (
              <>
                <div className="external-import-summary-list precon-list" role="list">
                  {visibleDecks.map(item => (
                    <button
                      type="button"
                      role="listitem"
                      className="external-import-summary-row precon-list-row"
                      key={item.fileName}
                      onClick={() => void selectDeck(item)}
                      disabled={busy}
                    >
                      <span>
                        <strong>{item.name}</strong>
                        <small className="muted"> · {item.type}</small>
                      </span>
                      <strong>{item.code} · {item.releaseDate.slice(0, 4)}</strong>
                    </button>
                  ))}
                  {visibleDecks.length === 0 && decks.length > 0 && (
                    <div className="external-import-summary-note">Keine passenden Decks gefunden.</div>
                  )}
                </div>
                {filteredDecks.length > MAX_LIST_RESULTS && (
                  <p className="muted external-import-help">
                    {filteredDecks.length - MAX_LIST_RESULTS} weitere Treffer – bitte die Suche verfeinern.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {busy && deck === null && !listBusy && (
          <div className="external-import-loading" role="status" aria-live="polite">
            <div className="external-import-loading-spinner" aria-hidden="true" />
            <div className="external-import-loading-copy"><strong>Deckliste wird geladen…</strong></div>
          </div>
        )}

        {busy && deck && !resolution && (
          <div className="external-import-loading" role="status" aria-live="polite">
            <div className="external-import-loading-spinner" aria-hidden="true" />
            <div className="external-import-loading-copy">
              <strong>Druckversionen werden bei Scryfall geprüft…</strong>
              <span>{progress.processed}/{progress.total} Einträge</span>
              <div className="external-import-loading-bar" aria-hidden="true">
                <span style={{ width: progress.total > 0 ? `${Math.round((progress.processed / progress.total) * 100)}%` : "8%" }} />
              </div>
            </div>
          </div>
        )}

        {deck && resolution && (
          <>
            <div className="external-import-summary">
              <div><span>Deck</span><strong>{deck.name}</strong></div>
              <div><span>Gesamt</span><strong>{totalCopies} Karten</strong></div>
              <div><span>Erkannt</span><strong>{resolvedCopies} Karten</strong></div>
              <div><span>Bereits in Sammlung</span><strong>{alreadyOwned} Druckversion(en)</strong></div>
            </div>

            <div className="external-import-preview-head">
              <div>
                <h3>{deck.code} · {deck.type} · {deck.releaseDate}</h3>
                <p className="muted">
                  Die Anzahlen werden auf deinen Bestand addiert. Bereits vorhandene Druckversionen erhalten die zusätzlichen Exemplare.
                </p>
              </div>
              <button className="secondary" type="button" onClick={backToList} disabled={busy}>Anderes Deck</button>
            </div>

            <div className="external-import-large-review">
              {groupedRows.map(group => (
                <section className="external-import-summary-list-section" key={group.section}>
                  <div className="external-import-summary-list-head">
                    <h4>{sectionLabel(group.section)}</h4>
                    <span>{group.rows.reduce((sum, item) => sum + item.row.count, 0)} Karten</span>
                  </div>
                  <div className="external-import-summary-list" role="list">
                    {group.rows.map(({ row, card }) => (
                      <div className="external-import-summary-row" role="listitem" key={`${group.section}-${card.id}-${row.foil ? "f" : "n"}`}>
                        <span>
                          {card.name}
                          <small className="muted"> · {card.set.toUpperCase()} #{card.collector_number}{row.foil ? " · Foil" : ""}{ownedIds.has(card.id) ? " · bereits vorhanden" : ""}</small>
                        </span>
                        <strong>{row.count}×</strong>
                      </div>
                    ))}
                  </div>
                </section>
              ))}

              {resolution.unresolved.length > 0 && (
                <section className="external-import-summary-list-section external-import-summary-list-section-warning">
                  <div className="external-import-summary-list-head">
                    <h4>Nicht eindeutig erkannt</h4>
                    <span>{unresolvedCopies} Karten</span>
                  </div>
                  <p className="external-import-summary-note">
                    Für diese Karten liefert Scryfall keine passende Druckversion. Sie werden nicht übernommen und können manuell über die Suche ergänzt werden.
                  </p>
                  <div className="external-import-summary-list" role="list">
                    {resolution.unresolved.map((row, index) => (
                      <div className="external-import-summary-row external-import-summary-row-warning" role="listitem" key={`missing-${index}`}>
                        <span>{row.name}{row.setCode ? ` · ${row.setCode.toUpperCase()} #${row.collectorNumber ?? "?"}` : ""}</span>
                        <strong>{row.count}×</strong>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <label className="external-import-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={event => setConfirmed(event.target.checked)}
              />
              <span>
                {unresolvedCopies > 0
                  ? `Ich möchte die ${resolvedCopies} erkannten Karten übernehmen (${unresolvedCopies} fehlen).`
                  : `Ich möchte alle ${resolvedCopies} Karten des Decks zur Sammlung hinzufügen.`}
              </span>
            </label>
          </>
        )}

        {error && <div className="external-import-error" role="alert">{error}</div>}

        <div className="external-import-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>Abbrechen</button>
          {resolution && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy || !confirmed || collectionCards.length === 0}
            >
              {busy ? "Speichere…" : `${resolvedCopies} Karte(n) hinzufügen`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
