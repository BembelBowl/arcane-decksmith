import type { CardRecord, DeckCard, DeckRecord } from "../types";

type DeckBoardProps = {
  deck: DeckRecord;
  pool: CardRecord[];
  onCardClick: (card: CardRecord) => void;
};

type BoardEntry = {
  key: string;
  deckCard?: DeckCard;
  source: CardRecord;
  count: number;
  commander: boolean;
};

const GROUP_ORDER = [
  "Commander",
  "Kreaturen",
  "Artefakte",
  "Verzauberungen",
  "Spontanzauber",
  "Hexereien",
  "Planeswalker",
  "Schlachten",
  "Länder",
  "Sonstiges"
] as const;

function cardImage(card: CardRecord): string | undefined {
  return card.imageUri ?? card.imageUris?.large ?? card.imageUris?.normal ?? card.imageUris?.small;
}

function groupFor(typeLine: string | undefined, commander: boolean): (typeof GROUP_ORDER)[number] {
  if (commander) return "Commander";
  const type = typeLine ?? "";
  if (/\bCreature\b/i.test(type)) return "Kreaturen";
  if (/\bArtifact\b/i.test(type)) return "Artefakte";
  if (/\bEnchantment\b/i.test(type)) return "Verzauberungen";
  if (/\bInstant\b/i.test(type)) return "Spontanzauber";
  if (/\bSorcery\b/i.test(type)) return "Hexereien";
  if (/\bPlaneswalker\b/i.test(type)) return "Planeswalker";
  if (/\bBattle\b/i.test(type)) return "Schlachten";
  if (/\bLand\b/i.test(type)) return "Länder";
  return "Sonstiges";
}

export default function DeckBoard({ deck, pool, onCardClick }: DeckBoardProps) {
  const entries: BoardEntry[] = [];

  if (deck.format === "commander") {
    deck.commanderIds.forEach((id, index) => {
      const source = pool.find(card => card.id === id);
      if (source) {
        entries.push({
          key: `commander-${id}-${index}`,
          source,
          count: 1,
          commander: true
        });
      }
    });
  }

  deck.cards.forEach(deckCard => {
    const source = pool.find(card => card.id === deckCard.id);
    if (!source) return;
    entries.push({
      key: `main-${deckCard.id}`,
      source,
      deckCard,
      count: deckCard.count,
      commander: false
    });
  });

  const grouped = new Map<(typeof GROUP_ORDER)[number], BoardEntry[]>();
  for (const group of GROUP_ORDER) grouped.set(group, []);

  for (const entry of entries) {
    const group = groupFor(entry.source.typeLine ?? entry.deckCard?.typeLine, entry.commander);
    grouped.get(group)?.push(entry);
  }

  for (const group of GROUP_ORDER) {
    grouped.get(group)?.sort((a, b) => {
      const mvDiff = (a.source.manaValue ?? 0) - (b.source.manaValue ?? 0);
      return mvDiff || a.source.name.localeCompare(b.source.name, "de");
    });
  }

  const visibleGroups = GROUP_ORDER.filter(group => (grouped.get(group)?.length ?? 0) > 0);

  return (
    <div className="deck-board-shell">
      <div className="deck-board" role="list" aria-label="Deckkarten nach Kartentyp">
        {visibleGroups.map(group => {
          const cards = grouped.get(group) ?? [];
          const total = cards.reduce((sum, entry) => sum + entry.count, 0);

          return (
            <section className="deck-board-column" key={group}>
              <header>
                <strong>{group}</strong>
                <span>{total}</span>
              </header>

              <div className="deck-board-stack">
                {cards.map((entry, index) => {
                  const image = cardImage(entry.source);
                  return (
                    <button
                      type="button"
                      className="deck-board-card"
                      style={{ zIndex: index + 1 }}
                      key={entry.key}
                      onClick={() => onCardClick(entry.source)}
                      title={`${entry.source.name} anzeigen`}
                    >
                      {image && (
                        <span
                          className="deck-board-card-art"
                          style={{ backgroundImage: `url(${image})` }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="deck-board-card-shade" aria-hidden="true" />
                      <span className="deck-board-card-copy">
                        <strong>
                          {entry.count > 1 ? `${entry.count}× ` : ""}
                          {entry.source.name}
                        </strong>
                        <small>
                          {entry.commander ? "Commander" : `MV ${entry.source.manaValue ?? 0}`}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
