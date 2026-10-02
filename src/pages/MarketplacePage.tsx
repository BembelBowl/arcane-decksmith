import { useEffect, useMemo, useState } from "react";
import { finishCountsFor } from "../collectionState";
import {
  loadMarketPage,
  marketplaceSupported,
  type MarketCursor
} from "../marketDb";
import {
  MAX_DISPLAY_NAME,
  listingTotal,
  validateDisplayName,
  type MarketListing,
  type OfferInput
} from "../marketplace";
import type { CardRecord } from "../types";
import "../marketplace.css";

type MarketplacePageProps = {
  uid: string;
  demoMode: boolean;
  collection: CardRecord[];
  myListings: MarketListing[];
  displayName: string;
  onSaveOffers: (offers: OfferInput[], displayName: string) => Promise<void>;
  onRemoveListing: (listing: MarketListing) => Promise<void>;
};

type Tab = "browse" | "mine";

type LoadedPage = {
  key: string;
  listings: MarketListing[];
  cursor: MarketCursor | null;
  hasMore: boolean;
  error: string;
};

const EURO = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

function euro(value: number | undefined): string {
  return value === undefined ? "–" : EURO.format(value);
}

function offeredLabel(listing: MarketListing): string {
  const parts: string[] = [];
  if (listing.offered.nonfoil > 0) parts.push(`Non-Foil ${listing.offered.nonfoil}×`);
  if (listing.offered.foil > 0) parts.push(`Foil ${listing.offered.foil}×`);
  return parts.join(" · ");
}

function ListingCard({ listing, own }: { listing: MarketListing; own: boolean }) {
  return (
    <article className="market-card">
      {listing.imageUri
        ? <img src={listing.imageUri} alt={listing.name} loading="lazy" />
        : <div className="market-card-noimage">Kein Bild</div>}
      <div className="market-card-body">
        <h3>{listing.name}</h3>
        <div className="meta">
          {listing.setName ?? listing.set.toUpperCase()} · #{listing.collectorNumber} · {listing.lang.toUpperCase()}
        </div>
        <div className="market-offered">{offeredLabel(listing)}</div>
        <div className="meta">
          Richtpreis: {listing.offered.nonfoil > 0 ? euro(listing.priceEur) : ""}
          {listing.offered.nonfoil > 0 && listing.offered.foil > 0 ? " / " : ""}
          {listing.offered.foil > 0 ? `Foil ${euro(listing.priceEurFoil)}` : ""}
        </div>
        <div className="market-owner">
          {own ? <span className="market-own-badge">Dein Angebot</span> : <>von <strong>{listing.ownerName}</strong></>}
        </div>
      </div>
    </article>
  );
}

function BrowseTab({ uid, refreshToken }: { uid: string; refreshToken: number }) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<LoadedPage | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);

  const key = `${search}#${refreshToken}`;
  const loading = page?.key !== key;

  useEffect(() => {
    let active = true;

    loadMarketPage({ search })
      .then(result => {
        if (active) setPage({ key, listings: result.listings, cursor: result.cursor, hasMore: result.hasMore, error: "" });
      })
      .catch(cause => {
        console.error("Marketplace konnte nicht geladen werden:", cause);
        if (active) {
          setPage({
            key,
            listings: [],
            cursor: null,
            hasMore: false,
            error: cause instanceof Error ? cause.message : "Der Marketplace konnte nicht geladen werden."
          });
        }
      });

    return () => {
      active = false;
    };
  }, [key, search]);

  const loadMore = async () => {
    if (!page || !page.cursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const next = await loadMarketPage({ search, cursor: page.cursor });
      setPage(current =>
        current && current.key === key
          ? { ...current, listings: [...current.listings, ...next.listings], cursor: next.cursor, hasMore: next.hasMore }
          : current
      );
    } catch (cause) {
      setPage(current =>
        current ? { ...current, error: cause instanceof Error ? cause.message : "Weitere Angebote konnten nicht geladen werden." } : current
      );
    } finally {
      setMoreBusy(false);
    }
  };

  return (
    <>
      <form
        className="searchbar market-searchbar"
        onSubmit={event => {
          event.preventDefault();
          setSearch(searchInput.trim());
        }}
      >
        <input
          value={searchInput}
          onChange={event => setSearchInput(event.target.value)}
          placeholder="Kartenname (Anfang), z. B. Sol Ring"
          aria-label="Angebote durchsuchen"
        />
        <button className="primary" type="submit">Suchen</button>
        {search && (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setSearchInput("");
              setSearch("");
            }}
          >
            Zurücksetzen
          </button>
        )}
      </form>
      <p className="muted market-hint">
        Die Suche findet Karten, deren Name mit deiner Eingabe beginnt. Ohne Suche siehst du die neuesten Angebote.
      </p>

      {loading ? (
        <div className="loading">Angebote werden geladen…</div>
      ) : page?.error && page.listings.length === 0 ? (
        <div className="panel" role="alert">
          <p>{page.error}</p>
        </div>
      ) : page && page.listings.length === 0 ? (
        <div className="panel collection-empty-state">
          <strong>{search ? "Keine Angebote zu dieser Suche." : "Noch keine Angebote im Marketplace."}</strong>
          <span className="muted">
            {search ? "Versuche einen anderen Namensanfang." : "Biete in deiner Sammlung Karten zum Tausch an."}
          </span>
        </div>
      ) : (
        <>
          <div className="market-grid">
            {page?.listings.map(listing => (
              <ListingCard key={listing.id} listing={listing} own={listing.ownerId === uid} />
            ))}
          </div>
          {page?.error && <p className="market-field-error" role="alert">{page.error}</p>}
          {page?.hasMore && (
            <div className="market-more">
              <button className="secondary" type="button" onClick={() => void loadMore()} disabled={moreBusy}>
                {moreBusy ? "Lade…" : "Weitere Angebote laden"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function MyOfferRow({
  listing,
  card,
  disabled,
  onSave,
  onRemove
}: {
  listing: MarketListing;
  card: CardRecord | undefined;
  disabled: boolean;
  onSave: (nonfoil: number, foil: number) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const owned = card ? finishCountsFor(card) : { nonfoil: 0, foil: 0 };
  const [nonfoil, setNonfoil] = useState(String(listing.offered.nonfoil));
  const [foil, setFoil] = useState(String(listing.offered.foil));
  const [busy, setBusy] = useState(false);

  const parse = (value: string) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };

  const changed = parse(nonfoil) !== listing.offered.nonfoil || parse(foil) !== listing.offered.foil;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="market-offer-row">
      {listing.imageUri
        ? <img src={listing.imageUri} alt="" loading="lazy" />
        : <div className="market-offer-noimage" aria-hidden="true">?</div>}
      <div className="market-offer-info">
        <strong>{listing.name}</strong>
        <span className="muted">
          {listing.setName ?? listing.set.toUpperCase()} · #{listing.collectorNumber}
          {!card ? " · nicht mehr in der Sammlung" : ""}
        </span>
      </div>
      <label>
        <span>Non-Foil (max. {owned.nonfoil})</span>
        <input
          type="number"
          min={0}
          max={owned.nonfoil}
          inputMode="numeric"
          value={nonfoil}
          disabled={disabled || busy || owned.nonfoil === 0}
          onChange={event => setNonfoil(event.target.value)}
        />
      </label>
      <label>
        <span>Foil (max. {owned.foil})</span>
        <input
          type="number"
          min={0}
          max={owned.foil}
          inputMode="numeric"
          value={foil}
          disabled={disabled || busy || owned.foil === 0}
          onChange={event => setFoil(event.target.value)}
        />
      </label>
      <div className="market-offer-actions">
        <button
          type="button"
          disabled={disabled || busy || !changed || !card}
          onClick={() => void run(() => onSave(parse(nonfoil), parse(foil)))}
        >
          Speichern
        </button>
        <button
          className="secondary"
          type="button"
          disabled={disabled || busy}
          onClick={() => void run(onRemove)}
        >
          Entfernen
        </button>
      </div>
    </div>
  );
}

function MineTab({
  collection,
  myListings,
  displayName,
  onSaveOffers,
  onRemoveListing
}: Omit<MarketplacePageProps, "uid" | "demoMode">) {
  const cardsById = useMemo(() => new Map(collection.map(card => [card.id, card] as const)), [collection]);
  const [name, setName] = useState(displayName);
  const [nameBusy, setNameBusy] = useState(false);
  const [message, setMessage] = useState("");

  const nameCheck = validateDisplayName(name);
  const nameChanged = nameCheck.ok && nameCheck.name !== displayName;
  const copies = myListings.reduce((sum, listing) => sum + listingTotal(listing.offered), 0);

  const saveName = async () => {
    if (!nameCheck.ok) return;
    setNameBusy(true);
    setMessage("");
    try {
      await onSaveOffers([], nameCheck.name);
      setMessage("Anzeigename gespeichert.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Anzeigename konnte nicht gespeichert werden.");
    } finally {
      setNameBusy(false);
    }
  };

  const reportError = (cause: unknown) => {
    setMessage(cause instanceof Error ? cause.message : "Aktion fehlgeschlagen.");
  };

  return (
    <>
      <div className="panel market-profile">
        <label className="market-name-field">
          <span>Dein Anzeigename (für andere Spieler sichtbar)</span>
          <input
            value={name}
            maxLength={MAX_DISPLAY_NAME}
            onChange={event => setName(event.target.value)}
            placeholder="z. B. Mox-Meister"
          />
        </label>
        <button type="button" onClick={() => void saveName()} disabled={nameBusy || !nameChanged}>
          {nameBusy ? "Speichere…" : "Namen speichern"}
        </button>
        {name.length > 0 && !nameCheck.ok && <p className="market-field-error" role="alert">{nameCheck.error}</p>}
        {message && <p className="muted" role="status">{message}</p>}
      </div>

      {myListings.length === 0 ? (
        <div className="panel collection-empty-state">
          <strong>Du bietest noch keine Karten an.</strong>
          <span className="muted">
            Wähle in deiner Sammlung Karten aus und klicke auf „Zum Tausch anbieten“.
          </span>
        </div>
      ) : (
        <>
          <p className="muted">{myListings.length} Karten · {copies} Exemplare im Marketplace</p>
          <div className="market-offer-list">
            {myListings.map(listing => (
              <MyOfferRow
                key={`${listing.id}-${listing.offered.nonfoil}-${listing.offered.foil}`}
                listing={listing}
                card={cardsById.get(listing.cardId)}
                disabled={false}
                onSave={async (nonfoil, foil) => {
                  const card = cardsById.get(listing.cardId);
                  if (!card) return;
                  try {
                    await onSaveOffers([{ card, nonfoil, foil }], displayName || listing.ownerName);
                    setMessage("");
                  } catch (cause) {
                    reportError(cause);
                  }
                }}
                onRemove={async () => {
                  try {
                    await onRemoveListing(listing);
                    setMessage("");
                  } catch (cause) {
                    reportError(cause);
                  }
                }}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export default function MarketplacePage(props: MarketplacePageProps) {
  const [tab, setTab] = useState<Tab>("browse");
  const [refreshToken, setRefreshToken] = useState(0);

  if (!marketplaceSupported || props.demoMode) {
    return (
      <section>
        <div className="pagehead">
          <div>
            <h2>Marketplace</h2>
          </div>
        </div>
        <div className="panel" role="status">
          <strong>Der Marketplace braucht ein Konto.</strong>
          <p className="muted">
            Im lokalen Demo-Modus ist er nicht verfügbar, weil die Angebote für andere Spieler sichtbar sein müssen.
            Melde dich mit einem Konto an, um Karten zum Tausch anzubieten.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Marketplace</h2>
          <p className="muted">
            Karten, die andere Spieler zum Tausch anbieten. Du siehst Karte, Anzahl, Richtpreis und Anzeigenamen.
          </p>
        </div>
        <button className="secondary" type="button" onClick={() => setRefreshToken(token => token + 1)}>
          Aktualisieren
        </button>
      </div>

      <div className="external-import-tabs market-tabs" role="tablist" aria-label="Marketplace">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "browse"}
          className={tab === "browse" ? "active" : "secondary"}
          onClick={() => setTab("browse")}
        >
          Angebote anderer Spieler
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "mine"}
          className={tab === "mine" ? "active" : "secondary"}
          onClick={() => setTab("mine")}
        >
          Meine Angebote ({props.myListings.length})
        </button>
      </div>

      {tab === "browse"
        ? <BrowseTab uid={props.uid} refreshToken={refreshToken} />
        : <MineTab key={props.displayName} {...props} />}
    </section>
  );
}
