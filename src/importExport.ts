import type { CardRecord, DeckRecord, Format } from "./types";

export type ImportSection =
  | "main"
  | "commander"
  | "sideboard";

export type ParsedListRow =
  | {
      kind: "card";
      count: number;
      name: string;
      section: ImportSection;
      set?: string;
      collectorNumber?: string;
    }
  | {
      kind: "format";
      format: Format;
    };

function cleanCardName(value: string) {
  return value
    .replace(/\s+\[[^\]]+\]\s*$/g, "")
    .replace(/\s+\([^)]*\)\s*$/g, "")
    .trim();
}

function sectionFromHeading(
  line: string
): ImportSection | null {
  const normalized = line
    .trim()
    .replace(/:$/, "")
    .toLowerCase();

  if (
    normalized === "commander" ||
    normalized === "commanders"
  ) {
    return "commander";
  }

  if (
    normalized === "sideboard" ||
    normalized === "side board" ||
    normalized === "maybeboard" ||
    normalized === "considering"
  ) {
    return "sideboard";
  }

  if (
    normalized === "deck" ||
    normalized === "main" ||
    normalized === "mainboard" ||
    normalized === "main deck" ||
    normalized === "maindeck"
  ) {
    return "main";
  }

  return null;
}

function formatFromLine(
  line: string
): Format | null {
  const match = line.match(
    /^\s*format\s*:\s*(commander|edh|standard)\s*$/i
  );

  if (!match) {
    return null;
  }

  return match[1].toLowerCase() === "standard"
    ? "standard"
    : "commander";
}

/*
 * Erweiterter Parser für Decklisten.
 *
 * Erkennt unter anderem:
 *
 * Format: Commander
 *
 * Commander
 * 1 Cloud, Midgar Mercenary
 *
 * Deck
 * 1 Sol Ring
 * 1 Command Tower
 *
 * Sideboard
 * 1 Example Card
 */
export function parseDeckList(
  text: string
): ParsedListRow[] {
  const result: ParsedListRow[] = [];

  let section: ImportSection = "main";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    /*
     * Leere Zeilen und Kommentarzeilen werden ignoriert.
     */
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("//")
    ) {
      continue;
    }

    /*
     * Prüfen, ob eine neue Sektion beginnt.
     */
    const heading = sectionFromHeading(line);

    if (heading) {
      section = heading;
      continue;
    }

    /*
     * Explizite Formatangabe erkennen.
     */
    const format = formatFromLine(line);

    if (format) {
      result.push({
        kind: "format",
        format
      });

      continue;
    }

    /*
     * Unterstützte Beispiele:
     *
     * 4 Lightning Bolt
     * 4x Lightning Bolt
     * Lightning Bolt
     */
    const match = line.match(
      /^\s*(\d+)\s*x?\s+(.+?)\s*$/i
    );

    const count = match
      ? Number(match[1])
      : 1;

    const rawName = match
      ? match[2]
      : line;

    if (
      !Number.isFinite(count) ||
      count <= 0
    ) {
      continue;
    }

    /*
     * Zusätzlich kann eine eindeutige Druckversion
     * angegeben werden:
     *
     * 1 Lightning Bolt [2XM:117]
     *
     * Dabei ist:
     * 2XM = Setcode
     * 117 = Collector Number
     */
    const setCollector = rawName.match(
      /^(.+?)\s+\[([a-z0-9]+):([^\]]+)\]\s*$/i
    );

    if (setCollector) {
      result.push({
        kind: "card",
        count,
        name: setCollector[1].trim(),
        section,
        set: setCollector[2].trim(),
        collectorNumber:
          setCollector[3].trim()
      });

      continue;
    }

    const name = cleanCardName(rawName);

    if (name) {
      result.push({
        kind: "card",
        count,
        name,
        section
      });
    }
  }

  return result;
}

/*
 * Kompatibilitätsfunktion für den bisherigen Code.
 *
 * Die bestehende App erwartet von parseList()
 * weiterhin nur:
 *
 * {
 *   count,
 *   name
 * }
 *
 * Dadurch können wir importExport.ts zuerst
 * austauschen, ohne App.tsx gleichzeitig ändern
 * zu müssen.
 */
export function parseList(
  text: string
): Array<{
  count: number;
  name: string;
}> {
  return parseDeckList(text)
    .filter(
      (
        row
      ): row is Extract<
        ParsedListRow,
        { kind: "card" }
      > =>
        row.kind === "card"
    )
    .map(row => ({
      count: row.count,
      name: row.name
    }));
}

/*
 * Sammlung als CSV exportieren.
 */
export function toCsv(
  cards: CardRecord[]
) {
  const header = [
    "name",
    "count",
    "set",
    "collectorNumber",
    "lang",
    "foil",
    "manaValue",
    "colors",
    "typeLine",
    "condition",
    "location"
  ].join(",");

  const rows = cards.map(
    card =>
      [
        card.name,
        card.count,
        card.set,
        card.collectorNumber,
        card.lang,
        card.foil,
        card.manaValue,
        card.colors.join("|"),
        card.typeLine ?? "",
        card.condition ?? "",
        card.location ?? ""
      ]
        .map(
          value =>
            `"${String(
              value
            ).replaceAll(
              '"',
              '""'
            )}"`
        )
        .join(",")
  );

  return [
    header,
    ...rows
  ].join("\n");
}

/*
 * Erstellt im Browser eine Datei zum Herunterladen.
 *
 * URL.createObjectURL erzeugt dafür vorübergehend
 * eine lokale Browser-URL für den erzeugten Blob.
 */
export function download(
  filename: string,
  content: string,
  type =
    "text/plain;charset=utf-8"
) {
  const anchor =
    document.createElement("a");

  const url =
    URL.createObjectURL(
      new Blob(
        [content],
        { type }
      )
    );

  anchor.href = url;
  anchor.download = filename;

  anchor.click();

  /*
   * Die temporäre URL wird nach dem Download
   * wieder freigegeben.
   */
  setTimeout(
    () =>
      URL.revokeObjectURL(url),
    0
  );
}

/*
 * Exportiert ein Deck in einem Format,
 * das unser neuer Importer später wieder
 * vollständig lesen kann.
 *
 * collection ist optional, damit bestehende
 * Aufrufe weiterhin funktionieren.
 */
export function deckText(
  deck: DeckRecord,
  collection: CardRecord[] = []
) {
  const sourcePool = new Map<string, CardRecord>();
  for (const card of deck.sourceCards ?? []) sourcePool.set(card.id, card);
  for (const card of collection) sourcePool.set(card.id, card);

  const printingSuffix = (
    set: string | undefined,
    collectorNumber: string | undefined
  ) =>
    set && collectorNumber
      ? ` [${set.toUpperCase()}:${collectorNumber}]`
      : "";

  const sourceFinishCounts = (card: CardRecord | undefined) => {
    if (!card) return undefined;
    if (card.finishCounts) return card.finishCounts;
    return card.foil
      ? { nonfoil: 0, foil: card.count }
      : { nonfoil: card.count, foil: 0 };
  };

  const deckCardLines = (card: DeckRecord["cards"][number]): string[] => {
    const source = sourcePool.get(card.id);
    const suffix = printingSuffix(
      card.set ?? source?.set,
      card.collectorNumber ?? source?.collectorNumber
    );
    const counts = card.finishCounts;

    if (counts && counts.nonfoil > 0 && counts.foil > 0) {
      return [
        `${counts.nonfoil} ${card.name}${suffix}`,
        `${counts.foil} ${card.name}${suffix} *F*`
      ];
    }

    const foil = card.foil === true || (counts?.foil ?? 0) > 0;
    return [`${card.count} ${card.name}${suffix}${foil ? " *F*" : ""}`];
  };

  const commanderLines = deck.commanderIds.flatMap(id => {
    const card = sourcePool.get(id);
    if (!card) return [];
    const suffix = printingSuffix(card.set, card.collectorNumber);
    const counts = sourceFinishCounts(card);
    const foil = counts ? counts.foil > 0 && counts.nonfoil === 0 : card.foil;
    return [`1 ${card.name}${suffix}${foil ? " *F*" : ""}`];
  });

  const format = `Format: ${deck.format === "commander" ? "Commander" : "Standard"}`;
  const commander = commanderLines.length
    ? `\n\nCommander\n${commanderLines.join("\n")}`
    : "";
  const main = deck.cards.flatMap(deckCardLines).join("\n");
  const side = deck.sideboard.length
    ? `\n\nSideboard\n${deck.sideboard.flatMap(deckCardLines).join("\n")}`
    : "";

  return (`${format}${commander}\n\nDeck\n${main}${side}`).trim();
}


/*
 * Provider-neutraler Import für externe Sammlungs- und Decklisten.
 *
 * Unterstützt insbesondere das vom Nutzer gelieferte CSV-Schema mit
 * Count, Name, Edition, Foil und Collector Number. Zusätzlich werden
 * gebräuchliche Alias-Spalten anderer MTG-Tools akzeptiert.
 */
export type ExternalImportProvider =
  | "Moxfield"
  | "Deckstats"
  | "Archidekt"
  | "ManaBox"
  | "Generic CSV"
  | "Textliste";

export type ExternalImportCardRow = {
  count: number;
  name: string;
  edition?: string;
  collectorNumber?: string;
  foil: boolean;
  section: ImportSection;
};

export type ExternalImportResult = {
  provider: ExternalImportProvider;
  rows: ExternalImportCardRow[];
  format?: Format;
};

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function detectCsvDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;

  for (const delimiter of candidates) {
    let inQuotes = false;
    let count = 0;

    for (let index = 0; index < firstLine.length; index += 1) {
      const char = firstLine[index];

      if (char === '"') {
        if (inQuotes && firstLine[index + 1] === '"') {
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && char === delimiter) {
        count += 1;
      }
    }

    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  return best;
}

function parseCsvRows(text: string): string[][] {
  const delimiter = detectCsvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    pushField();
    if (row.some(value => value.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      pushField();
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

const HEADER_ALIASES = {
  count: ["count", "quantity", "qty", "amount", "copies", "cardcount", "card count"],
  name: ["name", "card", "cardname", "card name", "card_name"],
  edition: ["edition", "set", "setcode", "set code", "set_code", "expansion", "edition code"],
  collectorNumber: [
    "collectornumber",
    "collector number",
    "collector_number",
    "cardnumber",
    "card number",
    "number",
    "cn"
  ],
  foil: ["foil", "isfoil", "is foil", "finish", "finishing", "printing", "foil?"],
  section: ["section", "board", "decksection", "deck section", "category", "categories"]
} as const;

function headerIndex(headers: string[], aliases: readonly string[]): number {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.findIndex(header => normalizedAliases.has(normalizeHeader(header)));
}

function parsePositiveCount(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "1").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function parseFoil(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return ["foil", "foiled", "true", "yes", "ja", "1", "*f*", "etched", "*e*"].includes(normalized);
}

function importSectionFromValue(value: string | undefined): ImportSection {
  const normalized = (value ?? "").trim().toLowerCase();
  if (/commander|command zone/.test(normalized)) return "commander";
  if (/side|maybe|consider/.test(normalized)) return "sideboard";
  return "main";
}

function detectProvider(headers: string[]): ExternalImportProvider {
  const normalized = new Set(headers.map(normalizeHeader));

  if (normalized.has("tradelistcount") || normalized.has("lastmodified")) {
    return "Moxfield";
  }

  if (normalized.has("bindername") || normalized.has("scryfallid")) {
    return "ManaBox";
  }

  if (normalized.has("quantity") && normalized.has("edition") && normalized.has("collectornumber")) {
    return "Archidekt";
  }

  // Deckstats- und andere CSV-Exporte werden absichtlich nicht allein anhand
  // der Spaltenreihenfolge erkannt. Die Zuordnung läuft über Header-Aliase.
  return "Generic CSV";
}

function parseExternalCsv(text: string): ExternalImportResult | null {
  const matrix = parseCsvRows(text);
  if (matrix.length < 2) return null;

  const headers = matrix[0];
  const nameIndex = headerIndex(headers, HEADER_ALIASES.name);
  if (nameIndex < 0) return null;

  const countIndex = headerIndex(headers, HEADER_ALIASES.count);
  const editionIndex = headerIndex(headers, HEADER_ALIASES.edition);
  const collectorIndex = headerIndex(headers, HEADER_ALIASES.collectorNumber);
  const foilIndex = headerIndex(headers, HEADER_ALIASES.foil);
  const sectionIndex = headerIndex(headers, HEADER_ALIASES.section);

  const rows: ExternalImportCardRow[] = [];

  for (const values of matrix.slice(1)) {
    const name = (values[nameIndex] ?? "").trim();
    if (!name) continue;

    const edition = editionIndex >= 0 ? (values[editionIndex] ?? "").trim() : "";
    const collectorNumber = collectorIndex >= 0 ? (values[collectorIndex] ?? "").trim() : "";

    rows.push({
      count: countIndex >= 0 ? parsePositiveCount(values[countIndex]) : 1,
      name,
      ...(edition ? { edition } : {}),
      ...(collectorNumber ? { collectorNumber } : {}),
      foil: foilIndex >= 0 ? parseFoil(values[foilIndex]) : false,
      section: sectionIndex >= 0 ? importSectionFromValue(values[sectionIndex]) : "main"
    });
  }

  return rows.length > 0
    ? { provider: detectProvider(headers), rows }
    : null;
}

function parseExternalText(text: string): ExternalImportResult {
  const rows: ExternalImportCardRow[] = [];
  let section: ImportSection = "main";
  let detectedFormat: Format | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;

    const heading = sectionFromHeading(line);
    if (heading) {
      section = heading;
      continue;
    }

    const format = formatFromLine(line);
    if (format) {
      detectedFormat = format;
      continue;
    }

    const quantity = line.match(/^\s*(\d+)\s*x?\s+(.+?)\s*$/i);
    const count = quantity ? parsePositiveCount(quantity[1]) : 1;
    let payload = quantity ? quantity[2].trim() : line;

    let foil = false;
    if (/\s+(?:\*f\*|\[foil\]|\(foil\)|foil)\s*$/i.test(payload)) {
      foil = true;
      payload = payload.replace(/\s+(?:\*f\*|\[foil\]|\(foil\)|foil)\s*$/i, "").trim();
    }

    let name = payload;
    let edition = "";
    let collectorNumber = "";

    const colonPrinting = payload.match(/^(.+?)\s+\[([a-z0-9]+):([^\]]+)\]\s*$/i);
    const parenPrinting = payload.match(/^(.+?)\s+\(([a-z0-9]+)\)\s+([a-z0-9][a-z0-9-]*)\s*$/i);
    const bracketPrinting = payload.match(/^(.+?)\s+\[([a-z0-9]+)\]\s+([a-z0-9][a-z0-9-]*)\s*$/i);
    const setOnly = payload.match(/^(.+?)\s+\(([a-z0-9]+)\)\s*$/i);

    if (colonPrinting) {
      name = colonPrinting[1].trim();
      edition = colonPrinting[2].trim();
      collectorNumber = colonPrinting[3].trim();
    } else if (parenPrinting) {
      name = parenPrinting[1].trim();
      edition = parenPrinting[2].trim();
      collectorNumber = parenPrinting[3].trim();
    } else if (bracketPrinting) {
      name = bracketPrinting[1].trim();
      edition = bracketPrinting[2].trim();
      collectorNumber = bracketPrinting[3].trim();
    } else if (setOnly) {
      name = setOnly[1].trim();
      edition = setOnly[2].trim();
    } else {
      name = cleanCardName(payload);
    }

    if (!name) continue;

    rows.push({
      count,
      name,
      ...(edition ? { edition } : {}),
      ...(collectorNumber ? { collectorNumber } : {}),
      foil,
      section
    });
  }

  return {
    provider: "Textliste",
    rows,
    ...(detectedFormat ? { format: detectedFormat } : {})
  };
}

export function parseExternalImport(
  filename: string,
  text: string
): ExternalImportResult {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Die Importdatei ist leer.");
  }

  const looksLikeCsv = /\.csv$/i.test(filename) || /[,;\t]/.test(trimmed.split(/\r?\n/, 1)[0] ?? "");
  if (looksLikeCsv) {
    const csv = parseExternalCsv(trimmed);
    if (csv) return csv;
  }

  const list = parseExternalText(trimmed);
  if (list.rows.length === 0) {
    throw new Error(
      "Keine Karten erkannt. Benötigt werden mindestens Name und Anzahl; für exakte Druckversionen zusätzlich Edition/Set und Collector Number."
    );
  }

  return list;
}
