import type { CardRecord } from "../types";

type CardStatus = {
  current: number;
  currentByName: number;
  ruleLimitLabel: string;
  disabled: boolean;
};

type ManualCardPoolBoardProps = {
  cards: CardRecord[];
  onCardClick: (card: CardRecord) => void;
  onAdd: (card: CardRecord) => void;
  statusForCard: (card: CardRecord) => CardStatus;
};

const GROUP_ORDER = [
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

type GroupName = (typeof GROUP_ORDER)[number];

function cardImage(card: CardRecord): string | undefined {
  return card.imageUri ?? card.imageUris?.large ?? card.imageUris?.normal ?? card.imageUris?.small;
}

function groupFor(typeLine: string | undefined): GroupName {
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

export default function ManualCardPoolBoard({
  cards,
  onCardClick,
  onAdd,
  statusForCard
}: ManualCardPoolBoardProps) {
  const grouped = new Map<GroupName, CardRecord[]>();
  for (const group of GROUP_ORDER) grouped.set(group, []);

  for (const card of cards) grouped.get(groupFor(card.typeLine))?.push(card);

  for (const group of GROUP_ORDER) {
    grouped.get(group)?.sort((a, b) => {
      const mvDiff = (a.manaValue ?? 0) - (b.manaValue ?? 0);
      return mvDiff || a.name.localeCompare(b.name, "de");
    });
  }

  const visibleGroups = GROUP_ORDER.filter(group => (grouped.get(group)?.length ?? 0) > 0);

  return (
    <div className="deck-board-shell manual-pool-board-shell">
      <div className="deck-board manual-pool-board" role="list" aria-label="Verfügbare Karten nach Kartentyp">
        {visibleGroups.map(group => {
          const groupCards = grouped.get(group) ?? [];

          return (
            <section className="deck-board-column manual-pool-column" key={group}>
              <header>
                <strong>{group}</strong>
                <span>{groupCards.length}</span>
              </header>

              <div className="deck-board-stack">
                {groupCards.map((card, index) => {
                  const image = cardImage(card);
                  const status = statusForCard(card);

                  return (
                    <article className="deck-board-entry manual-pool-entry" style={{ zIndex: index + 1 }} key={card.id}>
                      <button
                        type="button"
                        className="deck-board-card"
                        onClick={() => onCardClick(card)}
                        title={`${card.name} anzeigen`}
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
                          <strong>{card.name}</strong>
                          <small>
                            MV {card.manaValue ?? 0} · im Deck {status.currentByName}/{status.ruleLimitLabel}
                          </small>
                        </span>
                      </button>

                      <div className="deck-board-card-actions manual-pool-actions">
                        <button
                          type="button"
                          className="primary"
                          disabled={status.disabled}
                          onClick={() => onAdd(card)}
                        >
                          +1 hinzufügen
                        </button>
                      </div>
                    </article>
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
