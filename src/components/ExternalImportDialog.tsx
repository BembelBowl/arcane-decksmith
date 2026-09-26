import { useMemo, useState, type ChangeEvent } from "react";
import {
  getCardByFuzzyName,
  getCardsBySetAndCollectorNumbers,
  getPrintings,
  imageFor,
  normalizeCard,
  type ScryfallCard
} from "../scryfall";
import { roleOf } from "../deckBuilder";
import {
  parseExternalImport,
  type ExternalImportCardRow,
  type ExternalImportResult
} from "../importExport";
import { importExternalDeckUrl } from "../externalImportUrl";
import type {
  CardFinishCounts,
  CardRecord,
  DeckCard,
  DeckRecord,
  Format
} from "../types";
import "../importDialog.css";

type ImportMethod = "url" | "file" | "text";

type ResolvedRow = {
  index: number;
  row: ExternalImportCardRow;
  card: ScryfallCard;
};

type UnresolvedRow = {
  index: number;
  row: ExternalImportCardRow;
};

type ResolveResult = {
  resolved: ResolvedRow[];
  unresolved: UnresolvedRow[];
};

type ImportSummaryRow = {
  name: string;
  count: number;
};

const DETAILED_PREVIEW_MAX_COPIES = 100;

function summarizeRows(
  rows: Array<{ row: ExternalImportCardRow; card?: ScryfallCard }>
): ImportSummaryRow[] {
  const byName = new Map<string, ImportSummaryRow>();

  for (const item of rows) {
    const name = (item.card?.name || item.row.name || "Unbekannte Karte").trim();
    const key = name.toLocaleLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.count += item.row.count;
    } else {
      byName.set(key, { name, count: item.row.count });
    }
  }

  return [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "de", { sensitivity: "base" })
  );
}

type ExternalImportDialogProps = {
  mode: "collection" | "deck";
  pool: CardRecord[];
  onClose: () => void;
  onImportCollection?: (cards: CardRecord[]) => Promise<void>;
  onImportDeck?: (deck: DeckRecord) => Promise<void>;
};

function importKey(set: string, collectorNumber: string): string {
  return `${set.trim().toLowerCase()}::${collectorNumber.trim().toLowerCase()}`;
}

function normalizeImportedCardName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[’']/g, "'")
    .replace(/\s*\/\/\s*/g, " // ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function cardNameLookupCandidates(value: string): string[] {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  // Doppelseitige Karten werden in Exporten üblicherweise als
  // "Vorderseite // Rückseite" geschrieben. Scryfalls fuzzy endpoint kann
  // bei rebalanced A-Karten auf die nicht-rebalanced Variante springen,
  // wenn der zusammengesetzte Name als Ganzes übergeben wird. Deshalb wird
  // die Vorderseite zuerst separat versucht. Set + Collector Number bleiben
  // weiterhin die autoritative Identifikation.
  const faces = clean
    .split(/\s*\/\/\s*/)
    .map(face => face.trim())
    .filter(Boolean);

  return Array.from(new Set([faces[0], clean, ...faces.slice(1)].filter(Boolean)));
}

function namesEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeImportedCardName(left);
  const normalizedRight = normalizeImportedCardName(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftFaces = normalizedLeft.split(" // ");
  const rightFaces = normalizedRight.split(" // ");
  return leftFaces.length > 0 && rightFaces.length > 0 && leftFaces[0] === rightFaces[0];
}

async function resolveImportRows(
  rows: ExternalImportCardRow[],
  onProgress?: (processed: number, total: number, label: string) => void
): Promise<ResolveResult> {
  const exactMap = new Map<string, ScryfallCard>();
  const bySet = new Map<string, string[]>();

  for (const row of rows) {
    if (!row.edition || !row.collectorNumber) continue;
    const set = row.edition.trim().toLowerCase();
    const numbers = bySet.get(set) ?? [];
    numbers.push(row.collectorNumber.trim());
    bySet.set(set, numbers);
  }

  const uniqueBySet = Array.from(bySet, ([set, numbers]) => [
    set,
    Array.from(new Set(numbers))
  ] as const);
  const exactTotal = uniqueBySet.reduce((sum, [, numbers]) => sum + numbers.length, 0);
  let exactProcessed = 0;

  onProgress?.(0, exactTotal || rows.length, exactTotal > 0
    ? "Druckversionen werden geprüft…"
    : "Kartennamen werden geprüft…");

  // Set + Collector Number sind der schnelle und eindeutige Importpfad.
  // Die Scryfall-Hilfsfunktion bündelt große Mengen in GET-Suchbatches,
  // dedupliziert identische Druckversionen und meldet Batch-Fortschritt.
  for (const [set, numbers] of uniqueBySet) {
    const baseProcessed = exactProcessed;
    const result = await getCardsBySetAndCollectorNumbers(
      set,
      numbers,
      (setProcessed) => {
        onProgress?.(
          Math.min(exactTotal, baseProcessed + setProcessed),
          exactTotal,
          "Druckversionen werden geprüft…"
        );
      }
    );

    for (const card of result.cards) {
      exactMap.set(importKey(card.set, card.collector_number), card);
    }

    exactProcessed += numbers.length;
    onProgress?.(exactProcessed, exactTotal, "Druckversionen werden geprüft…");
  }

  const resolvedByIndex = new Map<number, ResolvedRow>();
  const fallbackIndexes: number[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const exact = row.edition && row.collectorNumber
      ? exactMap.get(importKey(row.edition, row.collectorNumber)) ?? null
      : null;

    if (exact) {
      resolvedByIndex.set(index, { index, row, card: exact });
    } else {
      fallbackIndexes.push(index);
    }
  }

  const unresolved: UnresolvedRow[] = [];

  if (fallbackIndexes.length > 0) {
    onProgress?.(0, fallbackIndexes.length, "Nicht eindeutige Karten werden per Name geprüft…");
  }

  for (let fallbackPosition = 0; fallbackPosition < fallbackIndexes.length; fallbackPosition += 1) {
    const index = fallbackIndexes[fallbackPosition];
    const row = rows[index];
    let card: ScryfallCard | null = null;

    // DFC-/MDFC-sicherer Namens-Fallback. Besonders bei rebalanced
    // Arena-Karten wie "A-Mischievous Catgeist // A-Catlike Curiosity"
    // wird zuerst die Vorderseite probiert. Ein vorhandenes Set/Collector-Paar
    // bleibt dabei immer autoritativ.
    for (const lookupName of cardNameLookupCandidates(row.name)) {
      const fuzzy = await getCardByFuzzyName(lookupName);
      if (!fuzzy) continue;

      if (row.edition) {
        const printings = await getPrintings(fuzzy);
        const edition = row.edition.trim().toLowerCase();
        const collectorNumber = row.collectorNumber?.trim().toLowerCase();
        const matchingPrinting = printings.find(candidate =>
          candidate.set.toLowerCase() === edition &&
          (!collectorNumber ||
            candidate.collector_number.trim().toLowerCase() === collectorNumber)
        );

        if (matchingPrinting) {
          card = matchingPrinting;
          break;
        }

        continue;
      }

      card = fuzzy;
      break;
    }

    if (!card || ((!row.edition || !row.collectorNumber) && !namesEqual(card.name, row.name))) {
      unresolved.push({ index, row });
    } else {
      resolvedByIndex.set(index, { index, row, card });
    }

    onProgress?.(
      fallbackPosition + 1,
      fallbackIndexes.length,
      "Nicht eindeutige Karten werden per Name geprüft…"
    );
  }

  return {
    resolved: Array.from(resolvedByIndex.values()).sort((a, b) => a.index - b.index),
    unresolved: unresolved.sort((a, b) => a.index - b.index)
  };
}

function mergeFinishCounts(
  current: CardFinishCounts | undefined,
  count: number,
  foil: boolean
): CardFinishCounts {
  return {
    nonfoil: Math.max(0, current?.nonfoil ?? 0) + (foil ? 0 : count),
    foil: Math.max(0, current?.foil ?? 0) + (foil ? count : 0)
  };
}

function collectionCardsFromResolved(rows: ResolvedRow[]): CardRecord[] {
  const byId = new Map<string, CardRecord>();

  for (const { row, card } of rows) {
    const existing = byId.get(card.id);

    if (!existing) {
      byId.set(card.id, normalizeCard(card, row.count, row.foil));
      continue;
    }

    const finishCounts = mergeFinishCounts(existing.finishCounts, row.count, row.foil);
    byId.set(card.id, {
      ...existing,
      count: existing.count + row.count,
      foil: finishCounts.foil > 0 && finishCounts.nonfoil === 0,
      finishCounts,
      updatedAt: Date.now()
    });
  }

  return [...byId.values()];
}

function deckFromResolved(
  rows: ResolvedRow[],
  pool: CardRecord[],
  name: string,
  format: Format,
  provider: string,
  commanderOverrideId?: string
): DeckRecord {
  const sourceCards = collectionCardsFromResolved(rows);
  const sourceById = new Map(sourceCards.map(card => [card.id, card]));
  const deckCardsByKey = new Map<string, DeckCard>();
  const commanderIds: string[] = [];
  const sideboardKeys = new Set<string>();

  for (const { row, card } of rows) {
    const source = sourceById.get(card.id) ?? normalizeCard(card, row.count, row.foil);
    const key = card.id;
    const current = deckCardsByKey.get(key);
    const finishCounts = mergeFinishCounts(current?.finishCounts, row.count, row.foil);

    deckCardsByKey.set(key, {
      id: card.id,
      name: card.name,
      count: (current?.count ?? 0) + row.count,
      manaValue: source.manaValue,
      typeLine: source.typeLine,
      role: roleOf(source),
      reason: `Importiert aus ${provider}`,
      available: pool.find(item => item.id === card.id)?.count ?? 0,
      set: card.set,
      setName: card.set_name,
      collectorNumber: card.collector_number,
      foil: finishCounts.foil > 0 && finishCounts.nonfoil === 0,
      finishCounts
    });

    if (row.section === "commander") {
      if (!commanderIds.includes(card.id)) commanderIds.push(card.id);
    } else if (row.section === "sideboard") {
      sideboardKeys.add(key);
    }
  }

  const allDeckCards = [...deckCardsByKey.values()];
  const commanders = format === "commander"
    ? (commanderIds.length > 0
        ? commanderIds.slice(0, 2)
        : commanderOverrideId
          ? [commanderOverrideId]
          : [])
    : [];
  const commanderSet = new Set(commanders);
  const sideboard = allDeckCards.filter(card => sideboardKeys.has(card.id) && !commanderSet.has(card.id));
  const cards = allDeckCards.filter(card => !sideboardKeys.has(card.id) && !commanderSet.has(card.id));

  const colorSource = commanders.length > 0
    ? sourceCards.filter(card => commanders.includes(card.id))
    : sourceCards;
  const colors = Array.from(new Set(colorSource.flatMap(card => card.colorIdentity ?? [])));
  const now = Date.now();

  return {
    id: crypto.randomUUID(),
    name: name.trim() || "Importiertes Deck",
    format,
    commanderIds: commanders,
    cards,
    sideboard,
    colors,
    createdAt: now,
    updatedAt: now,
    notes: `Importiert aus ${provider}.`,
    sourceCards,
    importSource: provider
  };
}

function fileBaseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim() || "Importiertes Deck";
}

function sectionLabel(section: ExternalImportCardRow["section"]): string {
  if (section === "commander") return "Commander";
  if (section === "sideboard") return "Sideboard";
  return "Mainboard";
}

function inferredFormat(result: ExternalImportResult): Format {
  if (result.format) return result.format;
  if (result.rows.some(row => row.section === "commander")) return "commander";
  const mainCopies = result.rows
    .filter(row => row.section !== "sideboard")
    .reduce((sum, row) => sum + row.count, 0);
  return mainCopies >= 90 && mainCopies <= 110 ? "commander" : "standard";
}

export default function ExternalImportDialog({
  mode,
  pool,
  onClose,
  onImportCollection,
  onImportDeck
}: ExternalImportDialogProps) {
  const [method, setMethod] = useState<ImportMethod>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [parsed, setParsed] = useState<ExternalImportResult | null>(null);
  const [deckName, setDeckName] = useState("Importiertes Deck");
  const [format, setFormat] = useState<Format>("commander");
  const [commanderOverrideId, setCommanderOverrideId] = useState("");
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resolveProgress, setResolveProgress] = useState({ processed: 0, total: 0, label: "Import wird vorbereitet…" });
  const [previewLimit, setPreviewLimit] = useState(90);
  const [error, setError] = useState("");

  const totalCopies = useMemo(
    () => parsed?.rows.reduce((sum, row) => sum + row.count, 0) ?? 0,
    [parsed]
  );

  const selectedResolved = useMemo(
    () => resolveResult?.resolved.filter(item => selectedRows.has(item.index)) ?? [],
    [resolveResult, selectedRows]
  );

  const selectedCopies = useMemo(
    () => selectedResolved.reduce((sum, item) => sum + item.row.count, 0),
    [selectedResolved]
  );

  const isLargeImport = totalCopies > DETAILED_PREVIEW_MAX_COPIES;

  const resolvedCopies = useMemo(
    () => resolveResult?.resolved.reduce((sum, item) => sum + item.row.count, 0) ?? 0,
    [resolveResult]
  );

  const unresolvedCopies = useMemo(
    () => resolveResult?.unresolved.reduce((sum, item) => sum + item.row.count, 0) ?? 0,
    [resolveResult]
  );

  const resolvedSummaryRows = useMemo(
    () => summarizeRows(resolveResult?.resolved ?? []),
    [resolveResult]
  );

  const unresolvedSummaryRows = useMemo(
    () => summarizeRows(resolveResult?.unresolved ?? []),
    [resolveResult]
  );

  const previewItems = useMemo(() => {
    if (!resolveResult) return [];
    return [
      ...resolveResult.resolved.map(item => ({ kind: "resolved" as const, ...item })),
      ...resolveResult.unresolved.map(item => ({ kind: "unresolved" as const, ...item }))
    ].sort((a, b) => a.index - b.index);
  }, [resolveResult]);

  const visiblePreviewItems = useMemo(
    () => previewItems.slice(0, previewLimit),
    [previewItems, previewLimit]
  );

  const commanderCandidates = useMemo(() => {
    const seen = new Set<string>();
    return selectedResolved
      .filter(({ row, card }) => {
        if (row.section === "sideboard" || seen.has(card.id)) return false;
        const commanderLike =
          /\bLegendary\b.*\bCreature\b/i.test(card.type_line ?? "") ||
          /can be your commander/i.test(card.oracle_text ?? "");
        if (commanderLike) seen.add(card.id);
        return commanderLike;
      })
      .map(({ card }) => card);
  }, [selectedResolved]);

  const hasExplicitCommander = useMemo(
    () => selectedResolved.some(item => item.row.section === "commander"),
    [selectedResolved]
  );

  const resetPreview = () => {
    setParsed(null);
    setResolveResult(null);
    setSelectedRows(new Set());
    setConfirmed(false);
    setCommanderOverrideId("");
    setError("");
    setResolveProgress({ processed: 0, total: 0, label: "Import wird vorbereitet…" });
    setPreviewLimit(90);
  };

  const changeMethod = (next: ImportMethod) => {
    setMethod(next);
    resetPreview();
  };

  const resolveParsed = async (
    next: ExternalImportResult,
    label: string,
    suggestedDeckName?: string
  ) => {
    setBusy(true);
    setError("");
    setResolveProgress({ processed: 0, total: next.rows.length, label: "Import wird vorbereitet…" });
    setParsed(next);
    setSourceLabel(label);
    setFormat(inferredFormat(next));
    if (suggestedDeckName) setDeckName(suggestedDeckName);

    try {
      // Einen Paint-Zyklus freigeben, damit Spinner und Fortschrittsanzeige
      // sichtbar werden, bevor die Netzwerkarbeit startet.
      await new Promise<void>(resolve => {
        window.requestAnimationFrame(() => resolve());
      });

      const resolved = await resolveImportRows(next.rows, (processed, total, progressLabel) => {
        setResolveProgress({ processed, total, label: progressLabel });
      });
      setResolveResult(resolved);
      setPreviewLimit(90);
      setSelectedRows(new Set(resolved.resolved.map(item => item.index)));
      setConfirmed(false);

      const explicitCommander = resolved.resolved.find(item => item.row.section === "commander");
      if (explicitCommander) setCommanderOverrideId(explicitCommander.card.id);
    } catch (cause) {
      setResolveResult(null);
      setError(cause instanceof Error ? cause.message : "Karten konnten nicht geprüft werden.");
    } finally {
      setBusy(false);
    }
  };

  const loadUrl = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError("");
    setResolveResult(null);

    try {
      const result = await importExternalDeckUrl(url);
      await resolveParsed(result, result.provider, result.deckName || "Importiertes Deck");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Deck-URL konnte nicht geladen werden.");
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setError("");

    try {
      const content = await file.text();
      const result = parseExternalImport(file.name, content);
      setText(content);
      await resolveParsed(result, file.name, mode === "deck" ? fileBaseName(file.name) : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Datei konnte nicht gelesen werden.");
      setBusy(false);
    }
  };

  const loadText = async () => {
    if (!text.trim() || busy) return;
    try {
      const result = parseExternalImport("eingabe.txt", text);
      await resolveParsed(result, "Eingefügte Liste");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Liste konnte nicht gelesen werden.");
    }
  };

  const toggleRow = (index: number) => {
    setSelectedRows(current => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    setConfirmed(false);
  };

  const applyImport = async () => {
    if (!parsed || selectedResolved.length === 0 || !confirmed || busy) return;

    setBusy(true);
    setError("");

    try {
      if (mode === "collection") {
        if (!onImportCollection) throw new Error("Sammlungsimport ist nicht konfiguriert.");
        await onImportCollection(collectionCardsFromResolved(selectedResolved));
      } else {
        if (!onImportDeck) throw new Error("Deckimport ist nicht konfiguriert.");
        await onImportDeck(
          deckFromResolved(
            selectedResolved,
            pool,
            deckName,
            format,
            parsed.provider,
            commanderOverrideId || undefined
          )
        );
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="external-import-backdrop" role="dialog" aria-modal="true" aria-label="Importieren">
      <div className="external-import-dialog panel">
        <div className="external-import-head">
          <div>
            <h2>{mode === "collection" ? "Karten importieren" : "Deck importieren"}</h2>
            <p className="muted">
              Importiere per öffentlicher Deck-URL, CSV/TXT-Datei oder eingefügter Kartenliste. Vor dem Speichern wird jede Karte aufgelöst und zur Kontrolle angezeigt.
            </p>
          </div>
          <button className="secondary" type="button" onClick={onClose} aria-label="Import schließen">×</button>
        </div>

        <div className="external-import-tabs" role="tablist" aria-label="Importquelle">
          <button type="button" className={method === "url" ? "active" : "secondary"} onClick={() => changeMethod("url")}>URL</button>
          <button type="button" className={method === "file" ? "active" : "secondary"} onClick={() => changeMethod("file")}>CSV / Datei</button>
          <button type="button" className={method === "text" ? "active" : "secondary"} onClick={() => changeMethod("text")}>Liste einfügen</button>
        </div>

        {!resolveResult && method === "url" && (
          <div className="external-import-source">
            <label>
              <span>Öffentliche Deck-URL</span>
              <input
                type="url"
                value={url}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setUrl(event.target.value)}
                placeholder="https://www.moxfield.com/decks/…"
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
            <p className="muted external-import-help">
              Direkt unterstützt werden öffentliche Moxfield-, Archidekt- und Deckstats-Links. Private Decks benötigen weiterhin einen Datei-Export.
            </p>
            <button type="button" onClick={() => void loadUrl()} disabled={!url.trim() || busy}>
              {busy ? "URL wird geprüft…" : "URL laden & prüfen"}
            </button>
          </div>
        )}

        {!resolveResult && method === "file" && (
          <div className="external-import-source">
            <label className="external-import-file">
              <span>CSV-, TSV-, TXT- oder DEC-Datei</span>
              <input
                type="file"
                accept=".csv,.tsv,.txt,.dec,text/csv,text/tab-separated-values,text/plain"
                onChange={(event: ChangeEvent<HTMLInputElement>) => void loadFile(event.target.files?.[0])}
                disabled={busy}
              />
            </label>
            <p className="muted external-import-help">
              Die Spaltenreihenfolge ist egal. Erkannte Felder sind u. a. Count/Quantity, Name/Card Name, Edition/Set, Foil/Finish und Collector Number/Card Number.
            </p>
          </div>
        )}

        {!resolveResult && method === "text" && (
          <div className="external-import-source">
            <label>
              <span>Kartenliste</span>
              <textarea
                rows={9}
                value={text}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
                placeholder={"1 Sol Ring [CMM:396]\n1 Command Tower (CMM) 1006\n1 Atraxa, Praetors' Voice *F*"}
              />
            </label>
            <button type="button" onClick={() => void loadText()} disabled={!text.trim() || busy}>
              {busy ? "Liste wird geprüft…" : "Liste prüfen"}
            </button>
          </div>
        )}


        {busy && !resolveResult && parsed && (
          <div className="external-import-loading" role="status" aria-live="polite">
            <div className="external-import-loading-spinner" aria-hidden="true" />
            <div className="external-import-loading-copy">
              <strong>{resolveProgress.label}</strong>
              <span>
                {resolveProgress.total > 0
                  ? `${resolveProgress.processed}/${resolveProgress.total}`
                  : "CSV wird eingelesen…"}
              </span>
              <div className="external-import-loading-bar" aria-hidden="true">
                <span
                  style={{
                    width: resolveProgress.total > 0
                      ? `${Math.round((resolveProgress.processed / resolveProgress.total) * 100)}%`
                      : "8%"
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {resolveResult && parsed && (
          <>
            {mode === "deck" && (
              <div className="external-import-deck-fields">
                <label>
                  <span>Deckname</span>
                  <input value={deckName} onChange={(event: ChangeEvent<HTMLInputElement>) => setDeckName(event.target.value)} />
                </label>
                <label>
                  <span>Format</span>
                  <select value={format} onChange={(event: ChangeEvent<HTMLSelectElement>) => setFormat(event.target.value as Format)}>
                    <option value="commander">Commander</option>
                    <option value="standard">Standard</option>
                  </select>
                </label>
              </div>
            )}

            {mode === "deck" && format === "commander" && !hasExplicitCommander && (
              <label className="external-import-commander">
                <span>Commander</span>
                <select
                  value={commanderOverrideId}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => setCommanderOverrideId(event.target.value)}
                >
                  <option value="">Noch nicht festlegen</option>
                  {commanderCandidates.map(card => (
                    <option key={card.id} value={card.id}>{card.name}</option>
                  ))}
                </select>
              </label>
            )}

            <div className="external-import-summary">
              <div><span>Quelle</span><strong>{parsed.provider}</strong></div>
              <div><span>Erkannt</span><strong>{resolveResult.resolved.length}/{parsed.rows.length} Zeilen</strong></div>
              <div><span>Karten</span><strong>{selectedCopies}/{totalCopies}</strong></div>
              <div><span>Import</span><strong>{sourceLabel || "—"}</strong></div>
            </div>

            <div className="external-import-preview-head">
              <div>
                <h3>Import vor Übernahme prüfen</h3>
                <p className="muted">
                  {isLargeImport
                    ? "Bei Importen über 100 Karten wird eine kompakte Übersicht ohne Bilder angezeigt."
                    : "Nur markierte, eindeutig erkannte Zeilen werden übernommen."}
                </p>
              </div>
              <button className="secondary" type="button" onClick={resetPreview} disabled={busy}>Quelle ändern</button>
            </div>

            {isLargeImport ? (
              <div className="external-import-large-review">
                <div className="external-import-large-totals">
                  <div className="external-import-large-total external-import-large-total-ok">
                    <span>Eindeutig erkannt</span>
                    <strong>{resolvedCopies} von {totalCopies} Karten</strong>
                    <small>{resolvedSummaryRows.length} unterschiedliche Kartennamen</small>
                  </div>
                  <div className="external-import-large-total external-import-large-total-warning">
                    <span>Nicht eindeutig erkannt</span>
                    <strong>{unresolvedCopies} Karten</strong>
                    <small>{unresolvedSummaryRows.length} unterschiedliche Kartennamen</small>
                  </div>
                </div>

                <section className="external-import-summary-list-section">
                  <div className="external-import-summary-list-head">
                    <h4>Erkannte Karten</h4>
                    <span>{resolvedCopies} Karten</span>
                  </div>
                  <div className="external-import-summary-list" role="list">
                    {resolvedSummaryRows.map(item => (
                      <div className="external-import-summary-row" role="listitem" key={`ok-${item.name}`}>
                        <span>{item.name}</span>
                        <strong>{item.count}×</strong>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="external-import-summary-list-section external-import-summary-list-section-warning">
                  <div className="external-import-summary-list-head">
                    <h4>Nicht eindeutig erkannt</h4>
                    <span>{unresolvedCopies} Karten</span>
                  </div>
                  {unresolvedSummaryRows.length > 0 ? (
                    <>
                      <p className="external-import-summary-note">
                        Diese Karten werden nicht übernommen. Bitte prüfe Name, Set und Collector Number in der Quelldatei.
                      </p>
                      <div className="external-import-summary-list" role="list">
                        {unresolvedSummaryRows.map(item => (
                          <div className="external-import-summary-row external-import-summary-row-warning" role="listitem" key={`missing-${item.name}`}>
                            <span>{item.name}</span>
                            <strong>{item.count}×</strong>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="external-import-all-recognized">Alle Karten wurden eindeutig erkannt.</div>
                  )}
                </section>
              </div>
            ) : (
              <>
                <div className="external-import-card-list">
                  {visiblePreviewItems.map(item => {
                    if (item.kind === "resolved") {
                      const { index, row, card } = item;
                      return (
                        <label className="external-import-card" key={`${index}-${card.id}`}>
                          <div className="external-import-card-select">
                            <input
                              className="external-import-card-check"
                              type="checkbox"
                              checked={selectedRows.has(index)}
                              onChange={() => toggleRow(index)}
                              aria-label={`${card.name} importieren`}
                            />
                          </div>
                          <div className="external-import-card-image">
                            {imageFor(card) ? <img src={imageFor(card)} alt={card.name} loading="lazy" /> : <span>Kein Bild</span>}
                          </div>
                          <div className="external-import-card-copy">
                            <strong className="external-import-card-name">{card.name}</strong>
                            <div className="external-import-imported-data">
                              <span><b>Anzahl:</b> {row.count}</span>
                              <span><b>Set:</b> {card.set_name ?? row.edition ?? card.set.toUpperCase()} ({card.set.toUpperCase()})</span>
                              <span><b>Nummer:</b> {card.collector_number || row.collectorNumber || "—"}</span>
                              <span><b>Finish:</b> {row.foil ? "Foil" : "Non-Foil"}</span>
                              {mode === "deck" && <span><b>Bereich:</b> {sectionLabel(row.section)}</span>}
                            </div>
                          </div>
                        </label>
                      );
                    }

                    const { index, row } = item;
                    return (
                      <div className="external-import-card external-import-card-unresolved" key={`unresolved-${index}`}>
                        <div className="external-import-card-select">
                          <input className="external-import-card-check" type="checkbox" disabled />
                        </div>
                        <div className="external-import-card-image external-import-card-image-missing"><span>?</span></div>
                        <div className="external-import-card-copy">
                          <strong className="external-import-card-name">{row.name}</strong>
                          <span className="external-import-missing">Nicht erkannt</span>
                          <div className="external-import-imported-data">
                            <span><b>Anzahl:</b> {row.count}</span>
                            <span><b>Edition:</b> {row.edition?.toUpperCase() || "—"}</span>
                            <span><b>Nummer:</b> {row.collectorNumber || "—"}</span>
                            <span><b>Finish:</b> {row.foil ? "Foil" : "Non-Foil"}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {previewLimit < previewItems.length && (
                  <div className="external-import-load-more">
                    <span>{previewLimit} von {previewItems.length} Zeilen angezeigt</span>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => setPreviewLimit(limit => Math.min(limit + 90, previewItems.length))}
                    >
                      Weitere 90 anzeigen
                    </button>
                  </div>
                )}
              </>
            )}

            <label className="external-import-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setConfirmed(event.target.checked)}
              />
              <span>
                {isLargeImport
                  ? "Ich habe die Übersicht geprüft und möchte alle eindeutig erkannten Karten übernehmen."
                  : "Ich habe die Importliste geprüft und möchte die ausgewählten Karten übernehmen."}
              </span>
            </label>
          </>
        )}

        {error && <div className="external-import-error">{error}</div>}

        <div className="external-import-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>Abbrechen</button>
          {resolveResult && (
            <button
              type="button"
              onClick={() => void applyImport()}
              disabled={busy || !confirmed || selectedResolved.length === 0}
            >
              {busy
                ? "Übernehme…"
                : mode === "collection"
                  ? `${selectedCopies} Karte(n) übernehmen`
                  : "Deck übernehmen"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
