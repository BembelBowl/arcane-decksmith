import { useMemo, useRef, useState } from "react";
import { finishCountsFor } from "../collectionState";
import {
  MAX_DISPLAY_NAME,
  listingTotal,
  validateDisplayName,
  type MarketListing,
  type OfferInput
} from "../marketplace";
import type { CardRecord } from "../types";
import { useDialogA11y } from "./useDialogA11y";
import "../marketplace.css";

type OfferDialogProps = {
  cards: CardRecord[];
  listings: MarketListing[];
  displayName: string;
  onClose: () => void;
  onSave: (offers: OfferInput[], displayName: string) => Promise<void>;
};

type Amounts = { nonfoil: string; foil: string };

function defaultAmounts(card: CardRecord, listing?: MarketListing): Amounts {
  if (listing) {
    return { nonfoil: String(listing.offered.nonfoil), foil: String(listing.offered.foil) };
  }
  const owned = finishCountsFor(card);
  return owned.nonfoil > 0 ? { nonfoil: "1", foil: "0" } : { nonfoil: "0", foil: "1" };
}

function parseAmount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export default function OfferToMarketDialog({
  cards,
  listings,
  displayName,
  onClose,
  onSave
}: OfferDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const listingByCard = useMemo(
    () => new Map(listings.map(listing => [listing.cardId, listing] as const)),
    [listings]
  );

  const [amounts, setAmounts] = useState<Record<string, Amounts>>(() =>
    Object.fromEntries(cards.map(card => [card.id, defaultAmounts(card, listingByCard.get(card.id))]))
  );
  const [name, setName] = useState(displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useDialogA11y(dialogRef, () => {
    if (!busy) onClose();
  });

  const offers: OfferInput[] = cards.map(card => ({
    card,
    nonfoil: parseAmount(amounts[card.id]?.nonfoil ?? "0"),
    foil: parseAmount(amounts[card.id]?.foil ?? "0")
  }));

  const offeredCopies = offers.reduce((sum, offer) => sum + offer.nonfoil + offer.foil, 0);
  const hasExisting = cards.some(card => listingByCard.has(card.id));
  const nameCheck = validateDisplayName(name);
  const canSave = !busy && nameCheck.ok && (offeredCopies > 0 || hasExisting);

  const setAmount = (cardId: string, finish: keyof Amounts, value: string) => {
    setAmounts(current => ({ ...current, [cardId]: { ...current[cardId], [finish]: value } }));
  };

  const save = async () => {
    if (!nameCheck.ok || !canSave) return;
    setBusy(true);
    setError("");
    try {
      await onSave(offers, nameCheck.name);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Angebote konnten nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="external-import-backdrop">
      <div
        ref={dialogRef}
        className="external-import-dialog panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="offer-dialog-title"
      >
        <div className="external-import-head">
          <div>
            <h2 id="offer-dialog-title">Zum Tausch anbieten</h2>
            <p className="muted">
              Lege fest, wie viele Exemplare andere Spieler im Marketplace sehen. Angezeigt werden Karte,
              Anzahl, Richtpreis und dein Anzeigename – keine E-Mail-Adresse. Mit 0 entfernst du ein Angebot.
            </p>
          </div>
          <button className="secondary" type="button" onClick={onClose} disabled={busy} aria-label="Dialog schließen">
            ×
          </button>
        </div>

        <label className="market-name-field">
          <span>Anzeigename (für andere Spieler sichtbar)</span>
          <input
            value={name}
            maxLength={MAX_DISPLAY_NAME}
            onChange={event => setName(event.target.value)}
            placeholder="z. B. Mox-Meister"
            autoComplete="nickname"
          />
        </label>
        {name.length > 0 && !nameCheck.ok && (
          <p className="market-field-error" role="alert">{nameCheck.error}</p>
        )}

        <div className="market-offer-list">
          {cards.map(card => {
            const owned = finishCountsFor(card);
            const current = amounts[card.id] ?? { nonfoil: "0", foil: "0" };
            return (
              <div className="market-offer-row" key={card.id}>
                {card.imageUri
                  ? <img src={card.imageUri} alt="" loading="lazy" />
                  : <div className="market-offer-noimage" aria-hidden="true">?</div>}
                <div className="market-offer-info">
                  <strong>{card.name}</strong>
                  <span className="muted">
                    {card.setName ?? card.set.toUpperCase()} · #{card.collectorNumber}
                    {listingByCard.has(card.id) ? " · bereits angeboten" : ""}
                  </span>
                </div>
                <label>
                  <span>Non-Foil (max. {owned.nonfoil})</span>
                  <input
                    type="number"
                    min={0}
                    max={owned.nonfoil}
                    inputMode="numeric"
                    value={current.nonfoil}
                    disabled={owned.nonfoil === 0}
                    onChange={event => setAmount(card.id, "nonfoil", event.target.value)}
                  />
                </label>
                <label>
                  <span>Foil (max. {owned.foil})</span>
                  <input
                    type="number"
                    min={0}
                    max={owned.foil}
                    inputMode="numeric"
                    value={current.foil}
                    disabled={owned.foil === 0}
                    onChange={event => setAmount(card.id, "foil", event.target.value)}
                  />
                </label>
              </div>
            );
          })}
        </div>

        <p className="muted external-import-help">
          {cards.length} Karte(n) ausgewählt · {offeredCopies} Exemplar(e) werden angeboten
          {listings.length > 0 ? ` · ${listings.reduce((sum, l) => sum + listingTotal(l.offered), 0)} Exemplar(e) bereits im Marketplace` : ""}
        </p>

        {error && <div className="external-import-error" role="alert">{error}</div>}

        <div className="external-import-actions">
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>Abbrechen</button>
          <button type="button" onClick={() => void save()} disabled={!canSave}>
            {busy ? "Speichere…" : "Angebote speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}
