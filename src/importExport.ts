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
 * Kleine CSV-Engine.
 *
 * Sie berücksichtigt auch Werte wie:
 *
 * "Cloud, Midgar Mercenary"
 *
 * bei denen innerhalb eines CSV-Feldes selbst
 * ein Komma vorkommt.
 */
function parseCsvLine(
  line: string
) {
  const cells: string[] = [];

  let value = "";
  let quoted = false;

  for (
    let index = 0;
    index < line.length;
    index += 1
  ) {
    const char = line[index];

    if (char === '"') {
      /*
       * Zwei doppelte Anführungszeichen innerhalb
       * eines CSV-Feldes bedeuten ein echtes ".
       */
      if (
        quoted &&
        line[index + 1] === '"'
      ) {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (
      char === "," &&
      !quoted
    ) {
      cells.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  cells.push(value);

  return cells.map(
    cell => cell.trim()
  );
}

export interface CollectionCsvRow {
  name: string;
  count: number;
  set?: string;
  collectorNumber?: string;
}

/*
 * Liest CSV-Daten der Sammlung ein.
 *
 * Mindestens benötigt:
 *
 * name,count
 *
 * Optional können zusätzlich vorhanden sein:
 *
 * set
 * collectorNumber
 */
export function parseCollectionCsv(
  text: string
): CollectionCsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .filter(
      line =>
        line.trim().length > 0
    );

  /*
   * Eine CSV-Datei benötigt mindestens
   * Kopfzeile + eine Datenzeile.
   */
  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(
    lines[0]
  ).map(
    header =>
      header.toLowerCase()
  );

  const nameIndex =
    headers.indexOf("name");

  const countIndex =
    headers.indexOf("count");

  /*
   * Ohne Name und Anzahl behandeln wir den Text
   * nicht als Collection-CSV.
   */
  if (
    nameIndex === -1 ||
    countIndex === -1
  ) {
    return [];
  }

  const setIndex =
    headers.indexOf("set");

  const collectorIndex =
    headers.findIndex(
      header =>
        header === "collectornumber" ||
        header === "collector_number" ||
        header === "collector number"
    );

  const rows: CollectionCsvRow[] = [];

  for (
    const line of lines.slice(1)
  ) {
    const cells =
      parseCsvLine(line);

    const name =
      cells[nameIndex]?.trim();

    const count =
      Number(cells[countIndex]);

    if (
      !name ||
      !Number.isFinite(count) ||
      count <= 0
    ) {
      continue;
    }

    rows.push({
      name,
      count,

      set:
        setIndex >= 0
          ? cells[setIndex]?.trim() ||
            undefined
          : undefined,

      collectorNumber:
        collectorIndex >= 0
          ? cells[
              collectorIndex
            ]?.trim() ||
            undefined
          : undefined
    });
  }

  return rows;
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
  /*
   * Commander befinden sich bei Arcane Decksmith
   * nicht im Hauptdeck-Array, sondern werden über
   * commanderIds gespeichert.
   *
   * Deshalb lösen wir ihre Namen über die
   * Sammlung auf.
   */
  const commanderLines =
    deck.commanderIds
      .map(
        id =>
          collection.find(
            card =>
              card.id === id
          )
      )
      .filter(
        (
          card
        ): card is CardRecord =>
          Boolean(card)
      )
      .map(
        card =>
          `1 ${card.name}`
      );

  const format =
    `Format: ${
      deck.format === "commander"
        ? "Commander"
        : "Standard"
    }`;

  const commander =
    commanderLines.length
      ? `\n\nCommander\n${commanderLines.join(
          "\n"
        )}`
      : "";

  const main =
    deck.cards
      .map(
        card =>
          `${card.count} ${card.name}`
      )
      .join("\n");

  const side =
    deck.sideboard.length
      ? `\n\nSideboard\n${deck.sideboard
          .map(
            card =>
              `${card.count} ${card.name}`
          )
          .join("\n")}`
      : "";

  return (
    `${format}` +
    `${commander}` +
    `\n\nDeck\n${main}` +
    `${side}`
  ).trim();
}
