import type { ScryfallCard, ScryfallSet } from "../scryfall";

export type ScannerMetadata = {
  raw: string;
  setCode?: string;
  collectorNumber?: string;
  language?: string;
};

export type RecognitionCandidate = {
  card: ScryfallCard;
  score: number;
  reasons: string[];
};

const LANGUAGE_CODES = new Set([
  "EN", "DE", "FR", "IT", "ES", "PT", "JA", "KO", "RU", "ZHS", "ZHT", "PHY", "HE", "LA", "GR", "AR"
]);

const NOISE_WORDS = new Set([
  "MTG", "MAGIC", "WIZARDS", "ARTIST", "ILLUS", "ILLUSTRATED", "CARD"
]);

export function normalizeOcrText(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\p{L}\p{N}\-/'&,:. ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCardNameCandidate(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(normalizeOcrText)
    .filter(Boolean)
    .filter(line => line.length >= 2 && line.length <= 80);

  if (lines.length === 0) return "";

  // Die Namenszeile ist im zugeschnittenen Titelbereich normalerweise die
  // längste brauchbare Textzeile. Mana-Symbole verschwinden durch OCR meist.
  return [...lines]
    .sort((a, b) => {
      const aLetters = (a.match(/\p{L}/gu) ?? []).length;
      const bLetters = (b.match(/\p{L}/gu) ?? []).length;
      return bLetters - aLetters || b.length - a.length;
    })[0]
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "")
    .trim();
}

export function extractCardNameCandidates(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(normalizeOcrText)
    .filter(Boolean)
    .filter(line => line.length >= 3 && line.length <= 80)
    .filter(line => {
      const upper = line.toUpperCase();
      if (NOISE_WORDS.has(upper)) return false;
      const letters = (line.match(/\p{L}/gu) ?? []).length;
      if (letters < 3) return false;
      // Reine Metadaten-/Nummernzeilen sind keine Kartennamen.
      if (/^[A-Z]{2,6}\s+[A-Z]?-?\d{1,4}[A-Z]?(?:\s|$)/i.test(line)) return false;
      if (/^\d+(?:\s*\/\s*\d+)?$/.test(line)) return false;
      return true;
    });

  return [...new Set(lines)]
    .sort((a, b) => {
      const aLetters = (a.match(/\p{L}/gu) ?? []).length;
      const bLetters = (b.match(/\p{L}/gu) ?? []).length;
      return bLetters - aLetters || b.length - a.length;
    })
    .slice(0, 4);
}

const RARITY_LETTERS = new Set(["C", "U", "R", "M", "L", "S", "T", "P", "D"]);

function cleanCollectorNumber(value: string): string {
  return value.replace(/^([A-Z]-?)?0+(?=\d)/, "$1").toLowerCase();
}

function isYear(value: string): boolean {
  return /^(?:19|20)\d{2}$/.test(value);
}

/**
 * Sucht die Collector Number nur in typischen Metadatenzeilen:
 * "123/281 R", "0123/0281", "R 0123" oder "A-69/277".
 * Jahreszahlen ("2021/…", "© 2021") werden nie als Nummer gewertet.
 */
function findCollectorNumber(line: string): { value: string; weak: boolean } | undefined {
  const slash = line.match(/(?:^|\s)([A-Z]?-?\d{1,4}[A-Z]?)\s*\/\s*(\d{1,4})(?:\s+([A-Z]))?(?=\s|$)/);
  if (slash) {
    const digits = slash[1].replace(/[^0-9]/g, "");
    if (!isYear(digits) && !isYear(slash[2])) {
      // "4/7" kann auch Stärke/Widerstand sein: ohne Seltenheitsbuchstaben,
      // führende Nullen oder dreistellige Gesamtzahl nur mit Set-Kontext werten.
      const weak = !slash[3] && slash[2].length < 3 && !/^0/.test(digits) && !/[A-Z]/.test(slash[1]);
      return { value: cleanCollectorNumber(slash[1]), weak };
    }
  }

  // Neueres Format ohne Gesamtzahl: Seltenheitsbuchstabe + Nummer.
  const rarity = line.match(/(?:^|\s)([A-Z])\s+([A-Z]?-?\d{3,4}[A-Z]?)(?=\s|$)/);
  if (rarity && RARITY_LETTERS.has(rarity[1]) && !isYear(rarity[2])) {
    return { value: cleanCollectorNumber(rarity[2]), weak: false };
  }

  return undefined;
}

type MetadataCandidate = ScannerMetadata & { weak: boolean; strongSet: boolean };

/**
 * Liest Set-Code, Collector Number und Sprache aus dem OCR-Text.
 *
 * Im Vollbild enthält der Regeltext häufig Wörter, die zufällig Set-Codes
 * (ONE, ALL, WAR, ICE) oder Sprachcodes (IT, EN, DE, LA, ES) sind. Deshalb
 * werden Set und Sprache nur aus der Metadatenzeile gelesen, also der Zeile
 * mit der Collector Number oder der direkt benachbarten Zeile
 * (z. B. "123/281 R" + "ONE • EN").
 */
export function parseScannerMetadata(
  rawText: string,
  sets: ScryfallSet[]
): ScannerMetadata {
  const lines = rawText
    .split(/\r?\n/)
    .map(line => normalizeOcrText(line).toUpperCase())
    .filter(Boolean);
  const raw = lines.join(" ");
  const knownSets = new Set(sets.map(set => set.code.toUpperCase()));
  const candidates: MetadataCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const found = findCollectorNumber(lines[index]);
    if (!found) continue;

    const metadataLines = [lines[index], lines[index + 1], lines[index - 1]]
      .filter((line): line is string => Boolean(line));

    let setCode: string | undefined;
    let language: string | undefined;

    for (const line of metadataLines) {
      const tokens = line.split(/\s+/).map(token => token.replace(/[^A-Z0-9]/g, "")).filter(Boolean);
      for (let position = 0; position < tokens.length; position += 1) {
        const token = tokens[position];
        if (!knownSets.has(token)) continue;
        const next = tokens[position + 1];
        // Bevorzugt "SET • SPRACHE"; sonst nur ein Set-Code in der Nummernzeile selbst.
        if (next && LANGUAGE_CODES.has(next)) {
          setCode = token.toLowerCase();
          language = next.toLowerCase();
          break;
        }
        if (line === lines[index] && !setCode) {
          setCode = token.toLowerCase();
        }
      }
      if (language) break;
    }

    candidates.push({
      raw,
      collectorNumber: found.value,
      setCode,
      language,
      weak: found.weak,
      strongSet: Boolean(language)
    });
  }

  const best =
    candidates.find(candidate => candidate.strongSet) ??
    candidates.find(candidate => !candidate.weak);

  if (!best) return { raw };
  return {
    raw,
    collectorNumber: best.collectorNumber,
    ...(best.setCode ? { setCode: best.setCode } : {}),
    ...(best.language ? { language: best.language } : {})
  };
}

function normalizeComparable(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }

  return prev[b.length];
}

export function nameSimilarity(ocrName: string, cardName: string): number {
  const a = normalizeComparable(ocrName);
  const b = normalizeComparable(cardName);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const distance = editDistance(a, b);
  return Math.max(0, 1 - distance / Math.max(a.length, b.length));
}

export function scorePrinting(
  card: ScryfallCard,
  ocrName: string,
  metadata: ScannerMetadata
): RecognitionCandidate {
  let score = 0;
  const reasons: string[] = [];

  const similarity = nameSimilarity(ocrName, card.name);
  if (similarity >= 0.93) {
    score += 40;
    reasons.push("Name stimmt sehr gut überein");
  } else if (similarity >= 0.75) {
    score += 28;
    reasons.push("Name wahrscheinlich erkannt");
  } else if (similarity >= 0.55) {
    score += 15;
    reasons.push("Name teilweise erkannt");
  }

  if (metadata.setCode && card.set.toLowerCase() === metadata.setCode) {
    score += 30;
    reasons.push(`Set ${card.set.toUpperCase()} erkannt`);
  }

  if (
    metadata.collectorNumber &&
    normalizeComparable(card.collector_number) === normalizeComparable(metadata.collectorNumber)
  ) {
    score += 30;
    reasons.push(`Collector Number ${card.collector_number} erkannt`);
  }

  if (metadata.language && card.lang?.toLowerCase() === metadata.language) {
    score += 5;
    reasons.push(`Sprache ${metadata.language.toUpperCase()} erkannt`);
  }

  return { card, score: Math.min(100, score), reasons };
}

export function rankPrintings(
  cards: ScryfallCard[],
  ocrName: string,
  metadata: ScannerMetadata
): RecognitionCandidate[] {
  return cards
    .map(card => scorePrinting(card, ocrName, metadata))
    .sort((a, b) => b.score - a.score ||
      (b.card.released_at ?? "").localeCompare(a.card.released_at ?? ""));
}

export function shouldIgnoreName(name: string): boolean {
  const clean = normalizeOcrText(name);
  if (clean.length < 2) return true;
  const upper = clean.toUpperCase();
  return NOISE_WORDS.has(upper) || /^\d+$/.test(clean);
}
