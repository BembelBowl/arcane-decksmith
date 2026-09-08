import {
  mkdir,
  writeFile
} from "node:fs/promises";

const SOURCE =
  "https://raw.githubusercontent.com/ShjnAki/scryfall-cards-jsonl/master/de.jsonl";

console.log(
  "Deutscher Kartenindex wird geladen…"
);

const response =
  await fetch(SOURCE);

if (!response.ok) {
  throw new Error(
    `Deutscher Kartenindex konnte nicht geladen werden: ${response.status}`
  );
}

const text =
  await response.text();

const entries = [];
const seen =
  new Set();

for (
  const line
  of text.split("\n")
) {
  const trimmed =
    line.trim();

  if (!trimmed) {
    continue;
  }

  try {
    const card =
      JSON.parse(trimmed);

    if (
      card.lang !== "de" ||
      card.game !== "paper" ||
      !card.printed_name ||
      !card.name ||
      !card.cardmarket_id
    ) {
      continue;
    }

    const printedName =
      String(
        card.printed_name
      ).trim();

    const englishName =
      String(
        card.name
      ).trim();

    const cardmarketId =
      String(
        card.cardmarket_id
      ).trim();

    if (
      !printedName ||
      !englishName ||
      !cardmarketId
    ) {
      continue;
    }

    const key =
      `${printedName.toLocaleLowerCase("de-DE")}::${englishName.toLocaleLowerCase("en-US")}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    entries.push({
      p: printedName,
      e: englishName,
      c: cardmarketId
    });
  } catch {
    // Ungültige Einzelzeilen überspringen.
  }
}

entries.sort(
  (a, b) =>
    a.p.localeCompare(
      b.p,
      "de"
    )
);

await mkdir(
  "public",
  {
    recursive: true
  }
);

await writeFile(
  "public/de-card-index.json",
  JSON.stringify(entries),
  "utf8"
);

console.log(
  `Deutscher Kartenindex: ${entries.length} Namen.`
);
