import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useDialogA11y } from "./useDialogA11y";
import {
  getCardByFuzzyName,
  getCardsBySetAndCollectorNumbers,
  getPrintings,
  getSets,
  imageFor,
  normalizeCard,
  resolveCardsFromDefaultBulkData,
  type ScryfallCard,
  type ScryfallSet
} from "../scryfall";
import {
  collectorNumberVariants,
  decidePrinting,
  normalizeCardName,
  normalizeCollectorNumber,
  normalizeSetToken,
  rawCollectorNumber
} from "../printingMatch";
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
  reason: "not_found" | "ambiguous" | "network";
};

type ResolveResult = {
  resolved: ResolvedRow[];
  unresolved: UnresolvedRow[];
};

type ImportSummaryRow = {
  name: string;
  count: number;
};

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
  const normalizedLeft = normalizeCardName(left);
  const normalizedRight = normalizeCardName(right);
  if (normalizedLeft === normalizedRight) return true;

  const leftFaces = normalizedLeft.split(" // ");
  const rightFaces = normalizedRight.split(" // ");
  return leftFaces.length > 0 && rightFaces.length > 0 && leftFaces[0] === rightFaces[0];
}

/**
 * Bulk Data (hunderte MB) lohnt sich nur für echte Großimporte. Entscheidend ist
 * die Anzahl eindeutiger Druckversions-Anfragen, nicht die Kopienanzahl: Ein
 * Commander-Deck mit Sideboard (110 Karten, viele Standardländer) bleibt im
 * API-Pfad. Echte Großimporte laufen weiterhin ausschließlich, atomar und
 * deterministisch über Bulk Data.
 */
const BULK_THRESHOLD_UNIQUE_ROWS: Record<"collection" | "deck", number> = {
  collection: 100,
  deck: 150
};

function uniqueLookupCount(rows: ExternalImportCardRow[]): number {
  return new Set(
    rows.map(row =>
      `${normalizeCardName(row.name)}|${(row.edition ?? "").trim().toLowerCase()}|${(row.collectorNumber ?? "").trim().toLowerCase()}`
    )
  ).size;
}

function usesBulkResolution(rows: ExternalImportCardRow[], mode: "collection" | "deck"): boolean {
  return uniqueLookupCount(rows) > BULK_THRESHOLD_UNIQUE_ROWS[mode];
}

const SET_CODE_PATTERN = /^[a-z0-9]{2,6}$/i;

/**
 * Ersetzt Setnamen (z. B. "Innistrad: Crimson Vow") durch Setcodes. Genau eine
 * Scryfall-Anfrage für die Setliste; bei Fehlern bleibt der Wert unverändert
 * (der Bulk-Pfad erkennt Setnamen zusätzlich direkt).
 */
async function mapEditionNamesToCodes(rows: ExternalImportCardRow[]): Promise<ExternalImportCardRow[]> {
  const needsMapping = rows.some(row => row.edition && !SET_CODE_PATTERN.test(row.edition.trim()));
  if (!needsMapping) return rows;

  let sets: ScryfallSet[];
  try {
    sets = await getSets();
  } catch {
    return rows;
  }

  const byName = new Map<string, string[]>();
  for (const set of sets) {
    const key = normalizeSetToken(set.name);
    byName.set(key, [...(byName.get(key) ?? []), set.code]);
  }

  return rows.map(row => {
    if (!row.edition || SET_CODE_PATTERN.test(row.edition.trim())) return row;
    const codes = byName.get(normalizeSetToken(row.edition));
    // Nur eindeutige Setnamen werden übersetzt.
    return codes?.length === 1 ? { ...row, edition: codes[0] } : row;
  });
}

async function resolveImportRows(
  inputRows: ExternalImportCardRow[],
  mode: "collection" | "deck",
  onProgress?: (processed: number, total: number, label: string) => void
): Promise<ResolveResult> {
  const totalCopies = inputRows.reduce((sum, row) => sum + row.count, 0);
  // Für das Matching werden Setnamen auf Codes abgebildet; angezeigt und
  // exportiert werden weiterhin die Originalzeilen.
  const rows = await mapEditionNamesToCodes(inputRows);

  if (usesBulkResolution(inputRows, mode)) {
    const bulkResult = await resolveCardsFromDefaultBulkData(
      rows.map((row, index) => ({
        index,
        name: row.name,
        set: row.edition,
        collectorNumber: row.collectorNumber,
        count: row.count
      })),
      onProgress,
      mode
    );

    const notFoundSet = new Set(bulkResult.notFoundIndexes);
    const ambiguousSet = new Set(bulkResult.ambiguousIndexes);
    const resolved: ResolvedRow[] = [];
    const unresolved: UnresolvedRow[] = [];

    for (let index = 0; index < inputRows.length; index += 1) {
      const row = inputRows[index];
      const card = bulkResult.cardsByIndex.get(index);
      if (card) {
        resolved.push({ index, row, card });
      } else if (ambiguousSet.has(index)) {
        unresolved.push({ index, row, reason: "ambiguous" });
      } else if (notFoundSet.has(index)) {
        unresolved.push({ index, row, reason: "not_found" });
      } else {
        // Jeder Eingabedatensatz muss nach dem atomaren Bulk-Lauf exakt einer
        // Kategorie zugeordnet sein. Andernfalls zeigen wir bewusst kein
        // Teilresultat an, weil dieses nicht reproduzierbar wäre.
        throw new Error(`Interner Importfehler: Zeile ${index + 1} wurde nicht klassifiziert.`);
      }
    }

    const classifiedRows = resolved.length + unresolved.length;
    const classifiedCopies = [...resolved, ...unresolved]
      .reduce((sum, item) => sum + item.row.count, 0);

    if (classifiedRows !== inputRows.length || classifiedCopies !== totalCopies) {
      throw new Error(
        `Importprüfung inkonsistent: erwartet ${inputRows.length} Zeilen / ${totalCopies} Karten, ` +
        `klassifiziert ${classifiedRows} Zeilen / ${classifiedCopies} Karten.`
      );
    }

    return { resolved, unresolved };
  }

  // --- API-Pfad für kleine Importe -------------------------------------------
  // Stufe 1: Set + Collector Number (inkl. Schreibvarianten wie "A69"/"A-69",
  // "069"/"69") gebündelt pro Set abfragen.
  const bySet = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.edition || !row.collectorNumber) continue;
    const set = row.edition.trim().toLowerCase();
    const numbers = bySet.get(set) ?? new Set<string>();
    for (const variant of collectorNumberVariants(row.collectorNumber)) numbers.add(variant);
    bySet.set(set, numbers);
  }

  const exactRaw = new Map<string, ScryfallCard[]>();
  const exactNormalized = new Map<string, ScryfallCard[]>();
  const temporaryFailureSets = new Set<string>();
  const addTo = (map: Map<string, ScryfallCard[]>, key: string, card: ScryfallCard) => {
    const list = map.get(key) ?? [];
    if (!list.some(item => item.id === card.id)) list.push(card);
    map.set(key, list);
  };

  const exactTotal = [...bySet.values()].reduce((sum, numbers) => sum + numbers.size, 0);
  let exactProcessed = 0;

  onProgress?.(0, exactTotal || rows.length, exactTotal > 0
    ? "Druckversionen werden geprüft…"
    : "Kartennamen werden geprüft…");

  for (const [set, numbers] of bySet) {
    const baseProcessed = exactProcessed;
    const result = await getCardsBySetAndCollectorNumbers(
      set,
      [...numbers],
      (setProcessed) => {
        onProgress?.(
          Math.min(exactTotal, baseProcessed + setProcessed),
          exactTotal,
          "Druckversionen werden geprüft…"
        );
      }
    );

    for (const card of result.cards) {
      addTo(exactRaw, importKey(card.set, rawCollectorNumber(card.collector_number)), card);
      addTo(exactNormalized, importKey(card.set, normalizeCollectorNumber(card.collector_number)), card);
    }
    if (result.temporaryFailures.length > 0) temporaryFailureSets.add(set);

    exactProcessed += numbers.size;
    onProgress?.(exactProcessed, exactTotal, "Druckversionen werden geprüft…");
  }

  const resolvedByIndex = new Map<number, ResolvedRow>();
  const fallbackIndexes: number[] = [];
  const unresolved: UnresolvedRow[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const original = inputRows[index];

    if (row.edition && row.collectorNumber) {
      const set = row.edition.trim().toLowerCase();
      const decision = decidePrinting(
        row.name,
        {
          exactRaw: exactRaw.get(importKey(set, rawCollectorNumber(row.collectorNumber))) ?? [],
          exactNormalized: exactNormalized.get(importKey(set, normalizeCollectorNumber(row.collectorNumber))) ?? []
        },
        mode
      );

      if (decision.status === "resolved") {
        resolvedByIndex.set(index, { index, row: original, card: decision.card });
        continue;
      }
      if (decision.status === "ambiguous") {
        unresolved.push({ index, row: original, reason: "ambiguous" });
        continue;
      }
      if (temporaryFailureSets.has(set)) {
        // Netzwerkfehler werden nicht als "Karte nicht gefunden" gewertet.
        // So bleibt die erkannte Importmenge nachvollziehbar und der Nutzer
        // kann die Prüfung wiederholen, ohne bereits erkannte Karten zu verlieren.
        unresolved.push({ index, row: original, reason: "network" });
        continue;
      }
    }

    fallbackIndexes.push(index);
  }

  if (fallbackIndexes.length > 0) {
    onProgress?.(0, fallbackIndexes.length, "Übrige Karten werden per Name geprüft…");
  }

  // Stufe 2: Namensbasierte Fallbacks. Set + Collector Number bleiben
  // autoritativ: Der Name liefert nur Kandidaten, entschieden wird über
  // Name + Collector Number (setübergreifend), Set + Name oder nur Name –
  // jeweils nur bei genau einem Treffer (Sammlung) bzw. deterministisch (Deck).
  for (let fallbackPosition = 0; fallbackPosition < fallbackIndexes.length; fallbackPosition += 1) {
    const index = fallbackIndexes[fallbackPosition];
    const row = rows[index];
    const original = inputRows[index];

    try {
      let fuzzy: ScryfallCard | null = null;
      // DFC-/MDFC-sicher: Bei rebalanced Arena-Karten wie
      // "A-Mischievous Catgeist // A-Catlike Curiosity" wird zuerst die
      // Vorderseite probiert; nur passende Namen werden akzeptiert.
      for (const lookupName of cardNameLookupCandidates(row.name)) {
        const candidate = await getCardByFuzzyName(lookupName);
        if (candidate && namesEqual(candidate.name, row.name)) {
          fuzzy = candidate;
          break;
        }
      }

      if (!fuzzy) {
        unresolved.push({ index, row: original, reason: "not_found" });
      } else if (mode === "deck" && !row.edition && !row.collectorNumber) {
        // Deckimport ohne Druckangabe: Das Deck braucht nur die Karte. Bewusst
        // wird Scryfalls Standarddruck übernommen, ohne alle Printings zu laden.
        resolvedByIndex.set(index, { index, row: original, card: fuzzy });
      } else {
        const printings = await getPrintings(fuzzy);
        const edition = row.edition ? normalizeSetToken(row.edition) : "";
        const inSet = edition
          ? printings.filter(card =>
              normalizeSetToken(card.set) === edition ||
              normalizeSetToken(card.set_name ?? "") === edition
            )
          : [];
        const collector = row.collectorNumber ? normalizeCollectorNumber(row.collectorNumber) : "";

        const decision = decidePrinting(
          row.name,
          {
            nameCollector: collector
              ? printings.filter(card => normalizeCollectorNumber(card.collector_number) === collector)
              : [],
            setName: inSet,
            name: edition || collector ? [] : printings
          },
          mode
        );

        if (decision.status === "resolved") {
          resolvedByIndex.set(index, { index, row: original, card: decision.card });
        } else {
          unresolved.push({ index, row: original, reason: decision.status });
        }
      }
    } catch (error) {
      console.warn(`Scryfall fallback lookup failed for ${row.name}`, error);
      unresolved.push({ index, row: original, reason: "network" });
    }

    onProgress?.(
      fallbackPosition + 1,
      fallbackIndexes.length,
      "Übrige Karten werden per Name geprüft…"
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

function csvCell(value: string | number): string {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function safeDownloadBase(value: string): string {
  const clean = value
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return clean || "import";
}

function triggerDownload(content: string, mimeType: string, fileName: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function unresolvedReasonLabel(reason: UnresolvedRow["reason"]): string {
  if (reason === "network") return "Technisch nicht geprüft";
  if (reason === "ambiguous") return "Mehrere Druckversionen möglich";
  return "Nicht erkannt";
}

/** Größenlimit für Importdateien (vor dem Einlesen geprüft). */
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;

function downloadUnresolvedCsv(rows: UnresolvedRow[], sourceLabel: string): void {
  const header = ["Count", "Name", "Edition", "Collector Number", "Finish", "Status"];
  const body = rows
    .slice()
    .sort((a, b) => a.row.name.localeCompare(b.row.name, "de", { sensitivity: "base" }))
    .map(({ row, reason }) => [
      row.count,
      row.name,
      row.edition?.toUpperCase() ?? "",
      row.collectorNumber ?? "",
      row.foil ? "Foil" : "Non-Foil",
      unresolvedReasonLabel(reason)
    ]);

  const csv = [header, ...body]
    .map(columns => columns.map(csvCell).join(";"))
    .join("\r\n");

  triggerDownload(
    `\uFEFF${csv}`,
    "text/csv;charset=utf-8",
    `${safeDownloadBase(sourceLabel)}-nicht-erkannt.csv`
  );
}

function downloadUnresolvedTxt(rows: UnresolvedRow[], sourceLabel: string): void {
  const lines = rows
    .slice()
    .sort((a, b) => a.row.name.localeCompare(b.row.name, "de", { sensitivity: "base" }))
    .map(({ row, reason }) => {
      const edition = row.edition ? row.edition.toUpperCase() : "—";
      const number = row.collectorNumber || "—";
      const finish = row.foil ? "Foil" : "Non-Foil";
      return `${row.count}x ${row.name} | Set: ${edition} | Nr.: ${number} | ${finish} | ${unresolvedReasonLabel(reason)}`;
    });

  triggerDownload(
    lines.join("\r\n"),
    "text/plain;charset=utf-8",
    `${safeDownloadBase(sourceLabel)}-nicht-erkannt.txt`
  );
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
  const [duplicateMode, setDuplicateMode] = useState<"add" | "skip">("add");
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogA11y(dialogRef, () => {
    if (!busy) onClose();
  });

  const totalCopies = useMemo(
    () => parsed?.rows.reduce((sum, row) => sum + row.count, 0) ?? 0,
    [parsed]
  );

  const selectedResolved = useMemo(
    () => resolveResult?.resolved.filter(item => selectedRows.has(item.index)) ?? [],
    [resolveResult, selectedRows]
  );


  const isLargeImport = useMemo(
    () => parsed ? usesBulkResolution(parsed.rows, mode) : false,
    [parsed, mode]
  );

  const resolvedCopies = useMemo(
    () => resolveResult?.resolved.reduce((sum, item) => sum + item.row.count, 0) ?? 0,
    [resolveResult]
  );

  const unresolvedCopies = useMemo(
    () => resolveResult?.unresolved
      .filter(item => item.reason === "not_found")
      .reduce((sum, item) => sum + item.row.count, 0) ?? 0,
    [resolveResult]
  );

  const ambiguousCopies = useMemo(
    () => resolveResult?.unresolved
      .filter(item => item.reason === "ambiguous")
      .reduce((sum, item) => sum + item.row.count, 0) ?? 0,
    [resolveResult]
  );

  const ambiguousSummaryRows = useMemo(
    () => summarizeRows(resolveResult?.unresolved.filter(item => item.reason === "ambiguous") ?? []),
    [resolveResult]
  );

  const ownedIds = useMemo(() => new Set(pool.map(card => card.id)), [pool]);

  const alreadyOwnedResolved = useMemo(
    () => mode === "collection"
      ? selectedResolved.filter(item => ownedIds.has(item.card.id))
      : [],
    [mode, ownedIds, selectedResolved]
  );

  const alreadyOwnedCopies = alreadyOwnedResolved.reduce((sum, item) => sum + item.row.count, 0);

  const rowsToImport = useMemo(
    () => duplicateMode === "skip"
      ? selectedResolved.filter(item => !ownedIds.has(item.card.id))
      : selectedResolved,
    [duplicateMode, ownedIds, selectedResolved]
  );

  const importCopies = rowsToImport.reduce((sum, item) => sum + item.row.count, 0);

  const technicalFailureCopies = useMemo(
    () => resolveResult?.unresolved
      .filter(item => item.reason === "network")
      .reduce((sum, item) => sum + item.row.count, 0) ?? 0,
    [resolveResult]
  );

  const resolvedSummaryRows = useMemo(
    () => summarizeRows(resolveResult?.resolved ?? []),
    [resolveResult]
  );

  const unresolvedSummaryRows = useMemo(
    () => summarizeRows(resolveResult?.unresolved.filter(item => item.reason === "not_found") ?? []),
    [resolveResult]
  );

  const unresolvedDownloadRows = useMemo(
    () => resolveResult?.unresolved.filter(item => item.reason !== "network") ?? [],
    [resolveResult]
  );

  const unresolvedDownloadCopies = unresolvedDownloadRows.reduce((sum, item) => sum + item.row.count, 0);

  const technicalFailureSummaryRows = useMemo(
    () => summarizeRows(resolveResult?.unresolved.filter(item => item.reason === "network") ?? []),
    [resolveResult]
  );

  const hasTechnicalFailures = technicalFailureCopies > 0;

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
    setDuplicateMode("add");
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
    if (next.rows.length === 0) {
      setParsed(next);
      setResolveResult(null);
      setBusy(false);
      setError(
        `Keine gültigen Kartenzeilen gefunden. ${next.skipped?.length ?? 0} Zeile(n) wurden wegen ungültiger Anzahl übersprungen.`
      );
      return;
    }

    setBusy(true);
    setError("");
    const importCardCount = next.rows.reduce((sum, row) => sum + row.count, 0);
    setResolveProgress({ processed: 0, total: importCardCount, label: "Import wird vorbereitet…" });
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

      const resolved = await resolveImportRows(next.rows, mode, (processed, total, progressLabel) => {
        setResolveProgress({ processed, total, label: progressLabel });
      });

      // Große Importe dürfen niemals in einen normalen API-/Netzwerk-Fallback
      // geraten. Bulk Data liefert entweder ein vollständig klassifiziertes
      // Ergebnis oder der gesamte Prüflauf schlägt fehl.
      if (usesBulkResolution(next.rows, mode) && resolved.unresolved.some(item => item.reason === "network")) {
        throw new Error("Interner Importfehler: Ein großer Import hat unerwartet die normale Scryfall-API verwendet.");
      }

      setResolveProgress({ processed: importCardCount, total: importCardCount, label: "Alle Karten wurden geprüft." });
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
      if (file.size > MAX_IMPORT_FILE_BYTES) {
        throw new Error(
          `Die Datei ist zu groß (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
          `Erlaubt sind höchstens ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB.`
        );
      }
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

  const retryResolution = async () => {
    if (!parsed || busy) return;
    await resolveParsed(
      parsed,
      sourceLabel || parsed.provider,
      mode === "deck" ? deckName : undefined
    );
  };

  const applyImport = async () => {
    if (!parsed || rowsToImport.length === 0 || !confirmed || busy || hasTechnicalFailures) return;

    setBusy(true);
    setError("");

    try {
      if (mode === "collection") {
        if (!onImportCollection) throw new Error("Sammlungsimport ist nicht konfiguriert.");
        await onImportCollection(collectionCardsFromResolved(rowsToImport));
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
    <div className="external-import-backdrop">
      <div
        ref={dialogRef}
        className="external-import-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "collection" ? "Karten importieren" : "Deck importieren"}
      >
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
                  ? `${resolveProgress.processed}/${resolveProgress.total} Karten`
                  : "Karten werden gezählt…"}
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
              <div><span>Gesamt</span><strong>{totalCopies} Karten</strong></div>
              <div><span>Erkannt</span><strong>{resolvedCopies} Karten</strong></div>
              <div><span>Nicht erkannt</span><strong>{unresolvedCopies} Karten</strong></div>
              <div><span>Mehrdeutig</span><strong>{ambiguousCopies} Karten</strong></div>
              <div><span>Import</span><strong>{sourceLabel || "—"}</strong></div>
            </div>

            {parsed.skipped && parsed.skipped.length > 0 && (
              <div className="external-import-network-warning">
                <strong>{parsed.skipped.length} Zeile(n) übersprungen (Anzahl 0 oder ungültig).</strong>
                <span>
                  {parsed.skipped.slice(0, 5).map(item => `Zeile ${item.line}: ${item.name} – ${item.reason}`).join(" · ")}
                  {parsed.skipped.length > 5 ? ` · und ${parsed.skipped.length - 5} weitere` : ""}
                </span>
              </div>
            )}

            {mode === "collection" && alreadyOwnedResolved.length > 0 && (
              <div className="external-import-network-warning external-import-duplicates">
                <strong>
                  {alreadyOwnedCopies} Karte(n) aus {alreadyOwnedResolved.length} Zeile(n) sind bereits in der Sammlung.
                </strong>
                <span>Bei einem erneuten Import derselben Datei würden die Anzahlen sonst doppelt gezählt.</span>
                <div className="external-import-duplicate-options" role="radiogroup" aria-label="Umgang mit vorhandenen Karten">
                  <label>
                    <input
                      type="radio"
                      name="duplicate-mode"
                      checked={duplicateMode === "add"}
                      onChange={() => { setDuplicateMode("add"); setConfirmed(false); }}
                    />
                    <span>Trotzdem hinzufügen (Anzahl addieren)</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="duplicate-mode"
                      checked={duplicateMode === "skip"}
                      onChange={() => { setDuplicateMode("skip"); setConfirmed(false); }}
                    />
                    <span>Vorhandene überspringen</span>
                  </label>
                </div>
              </div>
            )}

            <div className="external-import-preview-head">
              <div>
                <h3>Import vor Übernahme prüfen</h3>
                <p className="muted">
                  {isLargeImport
                    ? "Bei Importen über 100 Karten wird ausschließlich Scryfall Bulk Data verwendet. Die Gesamtzahl basiert auf Count und nicht auf CSV-Zeilen."
                    : "Nur markierte, eindeutig erkannte Karten werden übernommen."}
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
                    <span>Nicht erkannt</span>
                    <strong>{unresolvedCopies} Karten</strong>
                    <small>{unresolvedSummaryRows.length} unterschiedliche Kartennamen</small>
                  </div>
                  <div className="external-import-large-total external-import-large-total-warning">
                    <span>Mehrdeutig</span>
                    <strong>{ambiguousCopies} Karten</strong>
                    <small>{ambiguousSummaryRows.length} unterschiedliche Kartennamen</small>
                  </div>
                  {hasTechnicalFailures && !isLargeImport && (
                    <div className="external-import-large-total external-import-large-total-network">
                      <span>Technisch noch nicht geprüft</span>
                      <strong>{technicalFailureCopies} Karten</strong>
                      <small>Scryfall-Abfrage nach mehreren Versuchen fehlgeschlagen</small>
                    </div>
                  )}
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
                    <h4>Nicht erkannt</h4>
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

                {ambiguousSummaryRows.length > 0 && (
                  <section className="external-import-summary-list-section external-import-summary-list-section-warning">
                    <div className="external-import-summary-list-head">
                      <h4>Mehrere Druckversionen möglich</h4>
                      <span>{ambiguousCopies} Karten</span>
                    </div>
                    <p className="external-import-summary-note">
                      Für diese Zeilen passen mehrere Druckversionen. Sie werden nicht geraten und nicht übernommen. Bitte Set und Collector Number ergänzen.
                    </p>
                    <div className="external-import-summary-list" role="list">
                      {ambiguousSummaryRows.map(item => (
                        <div className="external-import-summary-row external-import-summary-row-warning" role="listitem" key={`ambiguous-${item.name}`}>
                          <span>{item.name}</span>
                          <strong>{item.count}×</strong>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {hasTechnicalFailures && (
                  <section className="external-import-summary-list-section external-import-summary-list-section-network">
                    <div className="external-import-summary-list-head">
                      <h4>Technisch nicht geprüft</h4>
                      <span>{technicalFailureCopies} Karten</span>
                    </div>
                    <p className="external-import-summary-note">
                      Diese Karten wurden nicht als falsch erkannt. Ihre Scryfall-Abfrage ist nach mehreren automatischen Wiederholungen fehlgeschlagen. Bitte die Prüfung erneut starten; bis dahin ist die Übernahme gesperrt.
                    </p>
                    <div className="external-import-summary-list" role="list">
                      {technicalFailureSummaryRows.map(item => (
                        <div className="external-import-summary-row external-import-summary-row-network" role="listitem" key={`network-${item.name}`}>
                          <span>{item.name}</span>
                          <strong>{item.count}×</strong>
                        </div>
                      ))}
                    </div>
                    <button className="secondary external-import-retry" type="button" onClick={() => void retryResolution()} disabled={busy}>
                      Prüfung erneut starten
                    </button>
                  </section>
                )}
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
                          <span className="external-import-missing">{unresolvedReasonLabel(item.reason)}</span>
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
                    <span>{Math.min(previewLimit, previewItems.length)} Vorschau-Einträge angezeigt</span>
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

            {unresolvedDownloadRows.length > 0 && (
              <div className="external-import-unresolved-export">
                <div>
                  <strong>Nicht übernommene Karten exportieren</strong>
                  <span>{unresolvedDownloadCopies} Karte(n) aus {unresolvedDownloadRows.length} Importzeile(n) – nicht erkannt oder mehrdeutig</span>
                </div>
                <div className="external-import-unresolved-export-actions">
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => downloadUnresolvedCsv(unresolvedDownloadRows, sourceLabel)}
                  >
                    CSV herunterladen
                  </button>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => downloadUnresolvedTxt(unresolvedDownloadRows, sourceLabel)}
                  >
                    TXT herunterladen
                  </button>
                </div>
              </div>
            )}

            {hasTechnicalFailures && !isLargeImport && (
              <div className="external-import-network-warning">
                <strong>{technicalFailureCopies} Karte(n) konnten technisch noch nicht geprüft werden.</strong>
                <span>Die Übernahme bleibt gesperrt, damit dieselbe Datei nicht je nach Netzwerkzustand unterschiedliche Ergebnisse liefert.</span>
                <button className="secondary" type="button" onClick={() => void retryResolution()} disabled={busy}>
                  Prüfung erneut starten
                </button>
              </div>
            )}

            <label className="external-import-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={hasTechnicalFailures}
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
              disabled={busy || !confirmed || rowsToImport.length === 0 || hasTechnicalFailures}
            >
              {busy
                ? "Übernehme…"
                : mode === "collection"
                  ? `${importCopies} Karte(n) übernehmen`
                  : "Deck übernehmen"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
