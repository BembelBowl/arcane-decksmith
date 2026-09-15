import { useEffect, useMemo, useState } from "react";
import {
  displayOracleText,
  displayTypeLine,
  getPrintings,
  getScryfallCard,
  imageFor,
  scryfallUrl,
  type ScryfallCard
} from "../scryfall";
import type {
  CardFinish,
  CardRecord
} from "../types";

const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR"
});

function formatEuro(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : EUR_FORMATTER.format(value);
}

function finishLabel(finish: CardFinish): string {
  return finish === "foil" ? "Foil" : "Non-Foil";
}

function finishCountsFor(card: CardRecord): Record<CardFinish, number> {
  const stored = card.finishCounts;

  if (stored) {
    const nonfoil = Math.max(0, Math.floor(Number(stored.nonfoil ?? 0)));
    const foil = Math.max(0, Math.floor(Number(stored.foil ?? 0)));

    if (nonfoil + foil > 0) {
      return { nonfoil, foil };
    }
  }

  return card.foil
    ? { nonfoil: 0, foil: card.count }
    : { nonfoil: card.count, foil: 0 };
}

function priceForRecord(
  card: CardRecord,
  finish: CardFinish
): number | undefined {
  return finish === "foil" ? card.priceEurFoil : card.priceEur;
}

function legacyFoilFlag(counts: Record<CardFinish, number>): boolean {
  return counts.foil > 0 && counts.nonfoil === 0;
}

function manaText(card: ScryfallCard | null, fallback?: string): string {
  if (card?.mana_cost) {
    return card.mana_cost;
  }

  const faces = card?.card_faces
    ?.map(face => face.mana_cost)
    .filter(Boolean);

  return faces?.join(" // ") || fallback || "";
}

function statsText(card: ScryfallCard | null): string | null {
  if (!card) return null;

  if (card.power !== undefined || card.toughness !== undefined) {
    return `${card.power ?? "?"}/${card.toughness ?? "?"}`;
  }

  if (card.loyalty !== undefined) {
    return `Loyalität ${card.loyalty}`;
  }

  return null;
}

type ManaToken =
  | {
      type: "symbol";
      raw: string;
      key: string;
      svgUri: string;
    }
  | {
      type: "separator";
      key: string;
      label: string;
    };

type PrintingEntry = {
  id: string;
  label: string;
  priceText: string;
  href: string;
  isCurrent: boolean;
};

function manaFilename(symbol: string): string {
  const normalized = symbol
    .toUpperCase()
    .replace(/∞/g, "INFINITY")
    .replace(/½/g, "HALF")
    .replace(/[^A-Z0-9]/g, "");

  return normalized;
}

function parseManaTokens(cost: string): ManaToken[] {
  if (!cost.trim()) {
    return [];
  }

  const tokens: ManaToken[] = [];
  const pattern = /\{([^}]+)\}|(\/\/)/g;

  for (const match of cost.matchAll(pattern)) {
    if (match[1]) {
      const raw = match[1].trim();
      const filename = manaFilename(raw);

      if (filename) {
        tokens.push({
          type: "symbol",
          raw,
          key: `symbol-${raw}-${match.index ?? 0}`,
          svgUri: `https://svgs.scryfall.io/card-symbols/${filename}.svg`
        });
      }
      continue;
    }

    if (match[2]) {
      tokens.push({
        type: "separator",
        key: `separator-${match.index ?? 0}`,
        label: "//"
      });
    }
  }

  return tokens;
}

function euroTextFromString(value: string | null | undefined): string {
  if (!value) {
    return "—";
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatEuro(parsed) : "—";
}

type CardDetailsModalProps = {
  card: CardRecord;
  onClose: () => void;
  onChange?: (card: CardRecord) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
};

export default function CardDetailsModal({
  card,
  onClose,
  onChange,
  onDelete
}: CardDetailsModalProps) {
  const [details, setDetails] = useState<ScryfallCard | null>(null);
  const [printings, setPrintings] = useState<ScryfallCard[]>([]);
  const [loadingPrintings, setLoadingPrintings] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    let active = true;

    setDetails(null);
    setPrintings([]);
    setLoadingPrintings(true);

    void getScryfallCard(card.id)
      .then(async scryfallCard => {
        if (!active) return;
        setDetails(scryfallCard);

        try {
          const nextPrintings = await getPrintings(scryfallCard);
          if (active) {
            setPrintings(nextPrintings);
          }
        } catch (error) {
          console.error("Scryfall-Drucke konnten nicht geladen werden:", error);
        }
      })
      .catch(error => {
        console.error("Kartendetails konnten nicht geladen werden:", error);
      })
      .finally(() => {
        if (active) {
          setLoadingPrintings(false);
        }
      });

    return () => {
      active = false;
    };
  }, [card.id]);

  const counts = useMemo(() => finishCountsFor(card), [card]);

  const finishes = useMemo(
    () => (["nonfoil", "foil"] as CardFinish[]).filter(finish =>
      counts[finish] > 0 || card.availableFinishes?.includes(finish)
    ),
    [card.availableFinishes, counts]
  );

  const oracleText = details
    ? displayOracleText(details)
    : card.oracleText ?? "";
  const typeLine = details
    ? displayTypeLine(details)
    : card.typeLine ?? "";
  const image = details ? imageFor(details) : card.imageUri;
  const statistics = statsText(details);
  const manaCostValue = manaText(details, card.manaCost);
  const manaTokens = useMemo(
    () => parseManaTokens(manaCostValue),
    [manaCostValue]
  );

  const printingEntries = useMemo<PrintingEntry[]>(() => {
    const currentEntry: PrintingEntry = {
      id: details?.id ?? card.id,
      label: `${details?.set_name ?? card.setName ?? card.set.toUpperCase()} #${details?.collector_number ?? card.collectorNumber}`,
      priceText: details
        ? euroTextFromString(details.prices?.eur)
        : formatEuro(card.priceEur),
      href: details?.scryfall_uri ?? scryfallUrl(card.id),
      isCurrent: true
    };

    const rest = printings
      .filter(printing => printing.id !== currentEntry.id)
      .map(printing => ({
        id: printing.id,
        label: `${printing.set_name ?? printing.set.toUpperCase()} #${printing.collector_number}`,
        priceText: euroTextFromString(printing.prices?.eur),
        href: printing.scryfall_uri ?? scryfallUrl(printing.id),
        isCurrent: false
      }));

    return [currentEntry, ...rest];
  }, [
    card.collectorNumber,
    card.id,
    card.priceEur,
    card.set,
    card.setName,
    details,
    printings
  ]);

  const changeFinishCount = (finish: CardFinish, delta: number) => {
    if (!onChange) return;

    const nextCounts = {
      ...counts,
      [finish]: Math.max(0, counts[finish] + delta)
    };

    const nextTotal = nextCounts.nonfoil + nextCounts.foil;
    if (nextTotal < 1) return;

    void onChange({
      ...card,
      count: nextTotal,
      finishCounts: nextCounts,
      foil: legacyFoilFlag(nextCounts),
      updatedAt: Date.now()
    });
  };


  return (
    <div
      className="card-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="card-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-modal-title"
      >
        <button
          className="card-modal-close"
          type="button"
          onClick={onClose}
          aria-label="Kartendetails schließen"
        >
          ×
        </button>

        <div className="card-modal-image-column">
          {image ? (
            <img src={image} alt={card.name} />
          ) : (
            <div className="card-modal-image-placeholder">Kein Kartenbild</div>
          )}
        </div>

        <div className="card-modal-rules-column">
          <header className="card-modal-card-header">
            <div>
              <h2 id="card-modal-title">{card.name}</h2>
              {manaCostValue && (
                manaTokens.length > 0 ? (
                  <div className="card-modal-mana-symbols" aria-label={manaCostValue}>
                    {manaTokens.map(token =>
                      token.type === "symbol" ? (
                        <img
                          key={token.key}
                          className="card-modal-mana-symbol"
                          src={token.svgUri}
                          alt={`{${token.raw}}`}
                          loading="lazy"
                        />
                      ) : (
                        <span key={token.key} className="card-modal-mana-separator">
                          {token.label}
                        </span>
                      )
                    )}
                  </div>
                ) : (
                  <div className="card-modal-mana">
                    {manaCostValue}
                  </div>
                )
              )}
            </div>
          </header>

          <div className="card-modal-type-line">{typeLine}</div>

          <div className="card-modal-oracle">
            {oracleText || "Kein Oracle-Text verfügbar."}
          </div>

          {statistics && (
            <div className="card-modal-stats">{statistics}</div>
          )}

          <div className="card-modal-meta-grid">
            <div>
              <span>Set</span>
              <strong>{details?.set_name ?? card.setName ?? card.set.toUpperCase()}</strong>
            </div>
            <div>
              <span>Collector Nr.</span>
              <strong>#{details?.collector_number ?? card.collectorNumber}</strong>
            </div>
            <div>
              <span>Sprache</span>
              <strong>{(details?.lang ?? card.lang).toUpperCase()}</strong>
            </div>
            <div>
              <span>Seltenheit</span>
              <strong>{details?.rarity ?? "—"}</strong>
            </div>
          </div>

          {details?.artist && (
            <div className="card-modal-artist">
              Illustriert von <strong>{details.artist}</strong>
            </div>
          )}
        </div>

        <aside className="card-modal-side-column">
          <section className="card-modal-side-section">
            <h3>Deine Sammlung</h3>

            <div className="card-modal-owned-total">
              <strong>{card.count}×</strong>
              <span>Gesamt</span>
            </div>

            <div className="card-modal-finish-list">
              {finishes.map(finish => (
                <div className="card-modal-finish-row" key={finish}>
                  <div>
                    <strong>{finishLabel(finish)}</strong>
                    <small>{formatEuro(priceForRecord(card, finish))} pro Karte</small>
                  </div>

                  <div className="card-modal-quantity-control">
                    <button
                      type="button"
                      disabled={!onChange || counts[finish] === 0 || card.count <= 1}
                      onClick={() => changeFinishCount(finish, -1)}
                      aria-label={`${finishLabel(finish)} verringern`}
                    >
                      −
                    </button>
                    <strong>{counts[finish]}</strong>
                    <button
                      type="button"
                      disabled={
                        !onChange ||
                        (!card.availableFinishes?.includes(finish) && counts[finish] === 0)
                      }
                      onClick={() => changeFinishCount(finish, 1)}
                      aria-label={`${finishLabel(finish)} erhöhen`}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {onDelete && (
              <button
                type="button"
                className="danger ghost card-modal-delete"
                onClick={() => void onDelete(card.id).then(onClose)}
              >
                Aus Sammlung löschen
              </button>
            )}
          </section>

          <section className="card-modal-side-section">
            <h3>Drucke</h3>

            {printingEntries.length > 0 ? (
              <div className="card-modal-printings" role="list">
                {printingEntries.map(printing => (
                  <a
                    key={printing.id}
                    href={printing.href}
                    target="_blank"
                    rel="noreferrer"
                    className={printing.isCurrent ? "is-current-printing" : undefined}
                    role="listitem"
                    aria-label={`${printing.label}${printing.isCurrent ? ", aktueller Druck" : ""}`}
                  >
                    <span className="card-modal-printing-main">
                      <span>{printing.label}</span>
                      {printing.isCurrent && (
                        <small>Aktueller Druck</small>
                      )}
                    </span>
                    <span>{printing.priceText}</span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="muted">Keine Druckinformationen verfügbar.</p>
            )}

            {loadingPrintings && (
              <p className="muted card-modal-printings-hint">
                Weitere Drucke werden geladen…
              </p>
            )}

            <a
              className="card-modal-scryfall-link"
              href={details?.scryfall_uri ?? scryfallUrl(card.id)}
              target="_blank"
              rel="noreferrer"
            >
              Auf Scryfall öffnen ↗
            </a>
          </section>
        </aside>
      </section>
    </div>
  );
}
