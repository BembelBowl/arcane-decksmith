import type { CardRecord, DeckRecord } from "./types";

export function parseList(text: string): Array<{ count: number; name: string }> {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const m = line.match(/^\s*(\d+)\s*x?\s+(.+?)\s*$/i);
    return m ? { count: Number(m[1]), name: m[2].trim() } : { count: 1, name: line };
  });
}
export function toCsv(cards: CardRecord[]) {
  const header = ["name","count","set","collectorNumber","lang","foil","manaValue","colors","typeLine","condition","location"].join(",");
  const rows = cards.map(c => [c.name,c.count,c.set,c.collectorNumber,c.lang,c.foil,c.manaValue,c.colors.join("|"),c.typeLine??"",c.condition??"",c.location??""].map(v => `"${String(v).replaceAll('"','""')}"`).join(","));
  return [header,...rows].join("\n");
}
export function download(filename: string, content: string, type="text/plain;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], {type}));
  a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}
export function deckText(deck: DeckRecord) {
  const commander = deck.commanderIds.length ? `Commander\n1 ${deck.cards.find(c=>deck.commanderIds.includes(c.id))?.name ?? ""}\n\n` : "";
  const main = deck.cards.filter(c=>!deck.commanderIds.includes(c.id)).map(c=>`${c.count} ${c.name}`).join("\n");
  const side = deck.sideboard.length ? `\n\nSideboard\n${deck.sideboard.map(c=>`${c.count} ${c.name}`).join("\n")}` : "";
  return commander + main + side;
}
