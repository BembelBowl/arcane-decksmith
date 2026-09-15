import type { CardRecord, DeckRecord } from "../types";

type DeckLibraryProps = {
  decks: DeckRecord[];
  pool: CardRecord[];
  onOpenDeck: (deckId: string) => void;
};


function colorSymbolUrl(color: string): string {
  return `https://svgs.scryfall.io/card-symbols/${encodeURIComponent(color.toUpperCase())}.svg`;
}

function cardImage(card: CardRecord | undefined): string | undefined {
  return (
    card?.imageUri ??
    card?.imageUris?.large ??
    card?.imageUris?.normal ??
    card?.imageUris?.small
  );
}

function deckArtwork(deck: DeckRecord, pool: CardRecord[]): string | undefined {
  for (const commanderId of deck.commanderIds) {
    const image = cardImage(pool.find(card => card.id === commanderId));
    if (image) return image;
  }

  for (const deckCard of deck.cards) {
    const source = pool.find(card => card.id === deckCard.id);
    if (source && !/\bLand\b/i.test(source.typeLine ?? deckCard.typeLine ?? "")) {
      const image = cardImage(source);
      if (image) return image;
    }
  }

  return cardImage(pool.find(card => deck.cards.some(deckCard => deckCard.id === card.id)));
}

function deckCount(deck: DeckRecord): number {
  return (
    deck.cards.reduce((sum, card) => sum + card.count, 0) +
    (deck.format === "commander" ? deck.commanderIds.length : 0)
  );
}

function commanderNames(deck: DeckRecord, pool: CardRecord[]): string[] {
  return deck.commanderIds
    .map(id => pool.find(card => card.id === id)?.name)
    .filter((name): name is string => Boolean(name));
}

function formatLabel(deck: DeckRecord): string {
  return deck.format === "commander" ? "Commander" : "Standard";
}

function colorIdentity(deck: DeckRecord): string[] {
  if (deck.colors.length > 0) {
    return deck.colors;
  }

  return deck.format === "commander" ? ["C"] : [];
}

export default function DeckLibrary({ decks, pool, onOpenDeck }: DeckLibraryProps) {
  return (
    <section>
      <div className="pagehead deck-library-pagehead">
        <div>
          <h2>Decks</h2>
          <p className="muted">
            {decks.length === 1 ? "1 gespeichertes Deck" : `${decks.length} gespeicherte Decks`}
          </p>
        </div>
      </div>

      {decks.length === 0 ? (
        <div className="panel empty-state">
          <h3>Noch keine Decks gespeichert</h3>
          <p className="muted">
            Erstelle unter „Deck bauen“ ein automatisches oder manuelles Deck.
          </p>
        </div>
      ) : (
        <div className="deck-library-grid">
          {decks.map(deck => {
            const art = deckArtwork(deck, pool);
            const commanders = commanderNames(deck, pool);
            const colors = colorIdentity(deck);
            const commanderText = commanders.join(" + ");

            return (
              <button
                type="button"
                className="deck-library-card"
                key={deck.id}
                onClick={() => onOpenDeck(deck.id)}
                aria-label={`${deck.name} öffnen`}
              >
                <div
                  className="deck-library-art"
                  style={art ? { backgroundImage: `url(${art})` } : undefined}
                >
                  <div className="deck-library-art-shade" />
                  <div className="deck-library-format-pill">{formatLabel(deck)}</div>
                </div>

                <div className="deck-library-copy">
                  <div className="deck-library-copy-main">
                    <div className="deck-library-title-row">
                      <h3>{deck.name}</h3>
                      <span>{deckCount(deck)} Karten</span>
                    </div>

                    <p className="deck-library-subtitle">{commanderText || formatLabel(deck)}</p>
                  </div>

                  <div className="deck-library-meta">
                    <span>{formatLabel(deck)}</span>
                    {typeof deck.score === "number" && <span>Score {deck.score}</span>}
                    {colors.length > 0 && (
                      <span className="deck-library-colors" aria-label="Farbidentität">
                        {colors.map(color => (
                          <img
                            key={color}
                            src={colorSymbolUrl(color)}
                            alt={color}
                            title={color}
                            width={20}
                            height={20}
                            loading="lazy"
                            style={{
                              display: "block",
                              width: 20,
                              height: 20,
                              filter: "drop-shadow(0 1px 1px rgba(0,0,0,.35))"
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
