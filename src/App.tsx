function deckManaCurve(
  deck: DeckRecord
): Array<{label:string;count:number}> {
  const counts=[0,0,0,0,0,0,0,0];

  for(const card of deck.cards){
    if(/\bLand\b/i.test(card.typeLine??"")){
      continue;
    }

    const mv=Math.max(
      0,
      Math.floor(
        Number.isFinite(card.manaValue)
          ?card.manaValue
          :0
      )
    );

    counts[Math.min(mv,7)]+=card.count;
  }

  return counts.map((count,index)=>({
    label:index===7?"7+":String(index),
    count
  }));
}

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { User } from "firebase/auth";
import { subscribeAuth, login, logout, authMessage } from "./auth";
import { firebaseConfigured } from "./firebase";
import {
  loadCollection,
  loadDecks,
  removeCard,
  removeDeck,
  saveCard,
  saveDeck,
  uidFromEmail
} from "./db";
import {
  autocomplete,
  availableFinishes,
  canonicalEnglishCard,
  displayName,
  displayOracleText,
  displayTypeLine,
  euroPriceFor,
  getCard,
  getCards,
  getCardsBySetAndCollectorNumbers,
  getPrintings,
  getSets,
  imageFor,
  searchCards,
  scryfallUrl,
  normalizeCard,
  type ScryfallCard,
  type ScryfallSet
} from "./scryfall";
import {
  buildDeck,
  cardLegalForDeck,
  commanderCandidates,
  commanderColorIdentity,
  commanderPairCandidates,
  deckCopyLimit,
  deckProfileFor,
  deckStats,
  roleOf,
  type DeckStrategy,
  type DeckTuning,
  type LockedDeckCard
} from "./deckBuilder";
import {
  deckText,
  download,
  parseCollectionCsv,
  parseDeckList,
  toCsv
} from "./importExport";
import {
  generateAiDeckExplanation,
  generateDeckExplanation
} from "./ai";
import type {
  CardFinish,
  CardRecord,
  DeckRecord,
  Format,
  GroupBy,
  ViewMode
} from "./types";
import "./styles.css";

const COLORS = ["W", "U", "B", "R", "G"];

const COLOR_NAMES: Record<string, string> = {
  W: "Weiß",
  U: "Blau",
  B: "Schwarz",
  R: "Rot",
  G: "Grün"
};

const COLOR_ORDER = ["W", "U", "B", "R", "G"];

const TYPE_ORDER = [
  "Land",
  "Kreatur",
  "Planeswalker",
  "Spontanzauber",
  "Hexerei",
  "Verzauberung",
  "Artefakt",
  "Schlacht",
  "Sonstiges"
];

const EUR_FORMATTER =
  new Intl.NumberFormat(
    "de-DE",
    {
      style: "currency",
      currency: "EUR"
    }
  );

function formatEuro(
  value:
    | number
    | undefined
    | null
): string {
  return value === undefined ||
    value === null ||
    !Number.isFinite(value)
    ? "kein EUR-Preis"
    : EUR_FORMATTER.format(value);
}

function finishLabel(
  finish: CardFinish
): string {
  return finish === "foil"
    ? "Foil"
    : "Non-Foil";
}

function finishCountsFor(
  card: CardRecord
): Record<CardFinish, number> {
  const stored =
    card.finishCounts;

  if (stored) {
    const nonfoil =
      Math.max(
        0,
        Math.floor(
          Number(
            stored.nonfoil ?? 0
          )
        )
      );

    const foil =
      Math.max(
        0,
        Math.floor(
          Number(
            stored.foil ?? 0
          )
        )
      );

    if (
      nonfoil + foil > 0
    ) {
      return {
        nonfoil,
        foil
      };
    }
  }

  return card.foil
    ? {
        nonfoil: 0,
        foil: card.count
      }
    : {
        nonfoil: card.count,
        foil: 0
      };
}

function priceForRecord(
  card: CardRecord,
  finish: CardFinish
): number | undefined {
  return finish === "foil"
    ? card.priceEurFoil
    : card.priceEur;
}

function highestOwnedUnitValue(
  card: CardRecord
): number | undefined {
  const counts =
    finishCountsFor(card);

  const prices: number[] = [];

  if (
    counts.nonfoil > 0 &&
    card.priceEur !== undefined
  ) {
    prices.push(
      card.priceEur
    );
  }

  if (
    counts.foil > 0 &&
    card.priceEurFoil !== undefined
  ) {
    prices.push(
      card.priceEurFoil
    );
  }

  return prices.length > 0
    ? Math.max(...prices)
    : undefined;
}

function collectionValueForCard(
  card: CardRecord
): {
  value: number;
  unpricedCopies: number;
} {
  const counts =
    finishCountsFor(card);

  let value = 0;
  let unpricedCopies = 0;

  if (counts.nonfoil > 0) {
    if (
      card.priceEur !== undefined
    ) {
      value +=
        counts.nonfoil *
        card.priceEur;
    } else {
      unpricedCopies +=
        counts.nonfoil;
    }
  }

  if (counts.foil > 0) {
    if (
      card.priceEurFoil !==
      undefined
    ) {
      value +=
        counts.foil *
        card.priceEurFoil;
    } else {
      unpricedCopies +=
        counts.foil;
    }
  }

  return {
    value,
    unpricedCopies
  };
}

function legacyFoilFlag(
  counts:
    Record<CardFinish, number>
): boolean {
  return (
    counts.foil > 0 &&
    counts.nonfoil === 0
  );
}


type CommanderBracketEstimate = {
  bracket: 2 | 3 | 4 | 5;
  label: string;
  gameChangers: number;
  extraTurnCards: number;
  massLandDenialCards: number;
  tutorCards: number;
  reasons: string[];
};

function looksLikeExtraTurnCard(
  card: CardRecord
): boolean {
  return /take an extra turn/i.test(
    card.oracleText ?? ""
  );
}

function looksLikeMassLandDenial(
  card: CardRecord
): boolean {
  const text =
    card.oracleText ?? "";

  return (
    /destroy all lands/i.test(text) ||
    /destroy all nonbasic lands/i.test(text) ||
    /return all lands to their owners'? hands/i.test(text) ||
    /lands don'?t untap/i.test(text) ||
    /nonbasic lands are mountains/i.test(text) ||
    /each player sacrifices .*lands?/i.test(text)
  );
}

function looksLikeTutor(
  card: CardRecord
): boolean {
  const text =
    card.oracleText ?? "";

  return (
    /search your library for (?:a|an) (?!basic land|land)/i.test(text) ||
    /search your library for up to (?:one|two|three|four|\d+) (?!basic land|land)/i.test(text)
  );
}

function commanderBracketEstimate(
  deck: DeckRecord,
  pool: CardRecord[]
): CommanderBracketEstimate | null {
  if (deck.format !== "commander") {
    return null;
  }

  const entries: Array<{
    card: CardRecord;
    count: number;
  }> = [];

  for (const deckCard of deck.cards) {
    const source = pool.find(
      card => card.id === deckCard.id
    );

    if (source) {
      entries.push({
        card: source,
        count: deckCard.count
      });
    }
  }

  for (const commanderId of deck.commanderIds) {
    const commander = pool.find(
      card => card.id === commanderId
    );

    if (commander) {
      entries.push({
        card: commander,
        count: 1
      });
    }
  }

  const countMatching = (
    predicate: (card: CardRecord) => boolean
  ) =>
    entries.reduce(
      (sum, entry) =>
        sum +
        (predicate(entry.card)
          ? entry.count
          : 0),
      0
    );

  const gameChangers =
    countMatching(
      card => card.gameChanger === true
    );

  const extraTurnCards =
    countMatching(
      looksLikeExtraTurnCard
    );

  const massLandDenialCards =
    countMatching(
      looksLikeMassLandDenial
    );

  const tutorCards =
    countMatching(
      looksLikeTutor
    );

  if (deck.cedh) {
    return {
      bracket: 5,
      label: "Bracket 5 – cEDH",
      gameChangers,
      extraTurnCards,
      massLandDenialCards,
      tutorCards,
      reasons: [
        "Im Deck-Editor ausdrücklich als cEDH-Deck markiert."
      ]
    };
  }

  const reasons: string[] = [];

  let bracket: 2 | 3 | 4 = 2;

  if (
    gameChangers > 3 ||
    massLandDenialCards > 0 ||
    extraTurnCards >= 3 ||
    tutorCards >= 6
  ) {
    bracket = 4;
  } else if (
    gameChangers > 0 ||
    extraTurnCards > 0 ||
    tutorCards >= 3
  ) {
    bracket = 3;
  }

  if (gameChangers > 0) {
    reasons.push(
      `${gameChangers} Game Changer${gameChangers === 1 ? "" : "s"} erkannt.`
    );
  } else {
    reasons.push(
      "Keine Game Changer in den geladenen Scryfall-Daten erkannt."
    );
  }

  if (extraTurnCards > 0) {
    reasons.push(
      `${extraTurnCards} Extra-Turn-Karte${extraTurnCards === 1 ? "" : "n"} erkannt.`
    );
  }

  if (massLandDenialCards > 0) {
    reasons.push(
      `${massLandDenialCards} Karte${massLandDenialCards === 1 ? "" : "n"} mit möglicher massenhafter Landverwehrung erkannt.`
    );
  }

  if (tutorCards >= 3) {
    reasons.push(
      `${tutorCards} Nichtland-Tutoren erkannt.`
    );
  }

  if (bracket === 2) {
    reasons.push(
      "Keine automatisch erkannten Merkmale erzwingen Bracket 3 oder 4."
    );
  }

  const label =
    bracket === 4
      ? "Bracket 4 – Optimized"
      : bracket === 3
        ? "Bracket 3 – Upgraded"
        : "Bracket 2 – Core";

  return {
    bracket,
    label,
    gameChangers,
    extraTurnCards,
    massLandDenialCards,
    tutorCards,
    reasons
  };
}

function parseCollectorNumbers(
  input: string
): string[] {
  return input
    .split(/[\s,;]+/)
    .map(value =>
      value.trim()
    )
    .filter(Boolean);
}

function collectorNumberCounts(
  numbers: string[]
): Map<string, number> {
  const counts =
    new Map<string, number>();

  for (
    const number
    of numbers
  ) {
    const key =
      number.toLowerCase();

    counts.set(
      key,
      (counts.get(key) ?? 0) + 1
    );
  }

  return counts;
}

function colorGroupName(colors: string[]): string {
  if (!colors.length) {
    return "Farblos";
  }

  const ordered = COLOR_ORDER.filter(color =>
    colors.includes(color)
  );

  return ordered
    .map(color => COLOR_NAMES[color] ?? color)
    .join(" / ");
}

function primaryTypeGroup(
  typeLine: string | undefined
): string {
  const type = (typeLine ?? "").toLowerCase();

  if (type.includes("land")) return "Land";
  if (type.includes("creature")) return "Kreatur";
  if (type.includes("planeswalker")) return "Planeswalker";
  if (type.includes("instant")) return "Spontanzauber";
  if (type.includes("sorcery")) return "Hexerei";
  if (type.includes("enchantment")) return "Verzauberung";
  if (type.includes("artifact")) return "Artefakt";
  if (type.includes("battle")) return "Schlacht";

  return "Sonstiges";
}

function compareGroupNames(
  a: string,
  b: string,
  group: GroupBy
): number {
  if (group === "manaValue") {
    const av = Number(a.replace("MV ", ""));
    const bv = Number(b.replace("MV ", ""));

    return av - bv;
  }

  if (group === "type") {
    const ai = TYPE_ORDER.indexOf(a);
    const bi = TYPE_ORDER.indexOf(b);

    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  }

  if (group === "color") {
    if (a === "Farblos" && b !== "Farblos") return -1;
    if (b === "Farblos" && a !== "Farblos") return 1;

    const ac = a.split(" / ").length;
    const bc = b.split(" / ").length;

    if (ac !== bc) return ac - bc;
  }

  return a.localeCompare(b, "de", {
    numeric: true,
    sensitivity: "base"
  });
}

function App() {
  const [auth, setAuth] = useState<{
    user: User | null;
    loading: boolean;
  }>({
    user: null,
    loading: true
  });

  const [demoEmail, setDemoEmail] = useState("");
  const [demoMode, setDemoMode] = useState(false);

  useEffect(
    () => subscribeAuth(setAuth),
    []
  );

  if (auth.loading) {
    return (
      <div className="splash">
        Arcane Decksmith wird geladen…
      </div>
    );
  }

  if (!auth.user && !demoMode) {
    return (
      <Auth
        onDemo={email => {
          setDemoEmail(email);
          setDemoMode(true);
        }}
      />
    );
  }

  const uid =
    auth.user?.uid ??
    uidFromEmail(demoEmail);

  return (
    <Main
      user={auth.user}
      uid={uid}
      demoMode={demoMode}
      onExitDemo={() => setDemoMode(false)}
    />
  );
}

function Auth({
  onDemo
}: {
  onDemo: (email: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const submit = async () => {
    setBusy(true);
    setMsg("");

    try {
      await login(email, pw);
    } catch (e: any) {
      setMsg(authMessage(e?.code ?? ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <img
          className="brand-logo"
          src="./ad_logo.png"
          alt="Arcane Decksmith Logo"
        />

        <h1>Arcane Decksmith</h1>

        <p className="muted">
          Deine Sammlung. Deine Karten. Dein Deck.
        </p>

        {!firebaseConfigured && (
          <div className="notice">
            Firebase ist noch nicht konfiguriert. Du kannst
            den lokalen Demo-Modus verwenden.
          </div>
        )}

        <label>
          E-Mail
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
          />
        </label>

        <label>
          Passwort
          <input
            value={pw}
            onChange={e => setPw(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>

        {msg && (
          <div className="error">
            {msg}
          </div>
        )}

        <button
          className="primary full"
          disabled={busy || !email || !pw}
          onClick={submit}
        >
          {busy ? "…" : "Anmelden"}
        </button>

        <div className="divider">
          oder
        </div>

        <button
          className="secondary full"
          onClick={() =>
            onDemo(email || "demo@example.com")
          }
        >
          Lokalen Demo-Modus verwenden
        </button>
      </div>
    </div>
  );
}

function Main({
  user,
  uid,
  demoMode,
  onExitDemo
}: {
  user: User | null;
  uid: string;
  demoMode: boolean;
  onExitDemo: () => void;
}) {
  const [collection, setCollection] =
    useState<CardRecord[]>([]);

  const [decks, setDecks] =
    useState<DeckRecord[]>([]);

  const [page, setPage] = useState<
    "collection" |
    "search" |
    "builder" |
    "decks"
  >("collection");

  const [busy, setBusy] = useState(true);
  const [toast, setToast] = useState("");

  useEffect(() => {
    void (async () => {
      setBusy(true);

      try {
        const loadedCollection =
          await loadCollection(uid);

        const loadedDecks =
          await loadDecks(uid);

        setCollection(loadedCollection);
        setDecks(loadedDecks);

        if (
          loadedCollection.length >
          0
        ) {
          void (async () => {
            try {
              const freshCards =
                await getCards(
                  loadedCollection.map(
                    card =>
                      card.id
                  )
                );

              const freshById =
                new Map(
                  freshCards.map(
                    card => [
                      card.id,
                      card
                    ] as const
                  )
                );

              const refreshedCollection =
  loadedCollection.map(
    card => {
      const fresh =
        freshById.get(
          card.id
        );

      if (!fresh) {
        return card;
      }

      const counts =
        finishCountsFor(
          card
        );

      return {
        ...card,
        setName:
          fresh.setName ??
          card.setName,

        finishCounts:
          counts,

        availableFinishes:
          fresh.availableFinishes &&
          fresh.availableFinishes.length > 0
            ? fresh.availableFinishes
            : card.availableFinishes,

        ...(fresh.priceEur !==
        undefined
          ? {
              priceEur:
                fresh.priceEur
            }
          : {}),

        ...(fresh.priceEurFoil !==
        undefined
          ? {
              priceEurFoil:
                fresh.priceEurFoil
            }
          : {}),

        priceUpdatedAt:
          fresh.priceUpdatedAt ??
          Date.now(),

        gameChanger:
          fresh.gameChanger ??
          card.gameChanger,

        foil:
          legacyFoilFlag(
            counts
          )
      };
    }
  );

setCollection(
  refreshedCollection
);

for (
  const card
  of refreshedCollection
) {
  await saveCard(
    uid,
    card
  );
}
            } catch {
              // Die gespeicherten Daten bleiben nutzbar, falls Scryfall gerade nicht erreichbar ist.
            }
          })();
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [uid]);

  const persistCard =
    async (c: CardRecord) => {
      await saveCard(uid, c);
      setCollection(
        await loadCollection(uid)
      );
    };

  const persistDeck =
    async (d: DeckRecord) => {
      await saveDeck(uid, d);
      setDecks(
        await loadDecks(uid)
      );

      setPage("decks");
      setToast("Deck gespeichert.");

      setTimeout(
        () => setToast(""),
        2200
      );
    };

  const delCard =
    async (id: string) => {
      await removeCard(uid, id);

      setCollection(
        await loadCollection(uid)
      );
    };

  const delDeck =
    async (id: string) => {
      await removeDeck(uid, id);

      setDecks(
        await loadDecks(uid)
      );
    };

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="logo"
          onClick={() =>
            setPage("collection")
          }
        >
          <img
            src="./ad_logo.png"
            alt="Arcane Decksmith Logo"
          />
          Arcane Decksmith
        </button>

        <nav>
          {(
            [
              "collection",
              "search",
              "builder",
              "decks"
            ] as const
          ).map(p => (
            <button
              key={p}
              className={
                page === p
                  ? "nav active"
                  : "nav"
              }
              onClick={() =>
                setPage(p)
              }
            >
              {p === "collection"
                ? "Sammlung"
                : p === "search"
                  ? "Kartensuche"
                  : p === "builder"
                    ? "Deck bauen"
                    : "Decks"}
            </button>
          ))}
        </nav>

        <div className="userbox">
          <span>
            {demoMode
              ? "Demo"
              : user?.email}
          </span>

          <button
            onClick={
              demoMode
                ? onExitDemo
                : logout
            }
          >
            Abmelden
          </button>
        </div>
      </header>

      {toast && (
        <div className="toast">
          {toast}
        </div>
      )}

      <main>
        {busy
          ? (
            <div className="loading">
              Daten werden geladen…
            </div>
          )
          : page === "collection"
            ? (
              <Collection
                cards={collection}
                onChange={persistCard}
                onDelete={delCard}
              />
            )
            : page === "search"
              ? (
<Search
  cards={collection}
  onImport={async next => {
    for (const c of next) {
      await saveCard(uid, c);
    }

    setCollection(
      await loadCollection(uid)
    );
  }}
  onAdd={async (
    c,
    finish
  ) => {
    const canonical =
      await canonicalEnglishCard(c);

    const existing =
      collection.find(
        x =>
          x.id === canonical.id ||
          (
            x.oracleId ===
              canonical.oracle_id &&
            x.set.toLowerCase() ===
              canonical.set.toLowerCase() &&
            x.collectorNumber.toLowerCase() ===
              canonical.collector_number.toLowerCase()
          )
      );

    if (existing) {
      const counts =
        finishCountsFor(
          existing
        );

      const nextCounts = {
        ...counts,
        [finish]:
          counts[finish] + 1
      };

      const fresh =
        normalizeCard(
          canonical,
          1,
          finish === "foil"
        );

      await persistCard({
        ...existing,
        count:
          existing.count + 1,
        finishCounts:
          nextCounts,
        availableFinishes:
          fresh.availableFinishes,
        ...(fresh.priceEur !== undefined
          ? {
              priceEur:
                fresh.priceEur
            }
          : {}),
        ...(fresh.priceEurFoil !== undefined
          ? {
              priceEurFoil:
                fresh.priceEurFoil
            }
          : {}),
        priceUpdatedAt:
          fresh.priceUpdatedAt,
        gameChanger:
          fresh.gameChanger ??
          existing.gameChanger,
        foil:
          legacyFoilFlag(
            nextCounts
          ),
        updatedAt:
          Date.now()
      });

      setToast(
        `${canonical.name}: ${finishLabel(finish)} hinzugefügt · Anzahl ${existing.count + 1}.`
      );
    } else {
      const fresh =
        normalizeCard(
          canonical,
          1,
          finish === "foil"
        );

      await persistCard(
        fresh
      );

      setToast(
        `${canonical.name} (${finishLabel(finish)}) wurde zur Sammlung hinzugefügt.`
      );
    }

    setTimeout(
      () => setToast(""),
      2200
    );
  }}
/>
              )
              : page === "builder"
                ? (
                  <Builder
                    pool={collection}
                    onSave={persistDeck}
                    demoMode={demoMode}
                  />
                )
                : (
                  <Decks
                    decks={decks}
                    pool={collection}
                    onDelete={delDeck}
                    onSave={persistDeck}
                    demoMode={demoMode}
                  />
                )}
      </main>

      <footer>
        Scryfall-Daten & Bilder werden direkt von
        Scryfall geladen. Keine Kaufentscheidung
        aufgrund von Preisen.
      </footer>
    </div>
  );
}

function Search({
  cards,
  onAdd,
  onImport
}: {
  cards: CardRecord[];
  onAdd: (
    c: ScryfallCard,
    finish: CardFinish
  ) => Promise<void>;
  onImport: (
    c: CardRecord[]
  ) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] =
    useState<ScryfallCard[]>([]);
  const [suggestions, setSuggestions] =
    useState<string[]>([]);
  const [busy, setBusy] =
    useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      if (q.length >= 2) {
        void autocomplete(q)
          .then(setSuggestions)
          .catch(() =>
            setSuggestions([])
          );
      } else {
        setSuggestions([]);
      }
    }, 300);

    return () =>
      clearTimeout(t);
  }, [q]);

  const go = async () => {
    setBusy(true);

    try {
      setResults(
        await searchCards(q)
      );
    } catch (e: any) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <style>{`
        .search-sticky-head{
          position:sticky;
          top:72px;
          z-index:20;
          margin:0 -4px 16px;
          padding:8px 4px 12px;
          background:linear-gradient(
            180deg,
            rgba(5,9,18,.98) 0%,
            rgba(5,9,18,.94) 82%,
            rgba(5,9,18,0) 100%
          );
          backdrop-filter:blur(14px);
        }

        .search-sticky-head .pagehead{
          margin-bottom:10px;
        }

        .search-tool-actions{
          display:flex;
          flex-wrap:wrap;
          gap:8px;
          margin-top:8px;
        }

        @media (max-width:850px){
          .search-sticky-head{
            top:112px;
          }
        }
      `}</style>

<div className="search-sticky-head">
  <div className="pagehead">
    <div>
      <h2>Kartensuche</h2>
      <p className="muted">
        Scryfall-Suche, Import und Bulk-Hinzufügen.
      </p>
    </div>
  </div>

  <div className="searchbar">
    <input
      value={q}
      onChange={e =>
        setQ(e.target.value)
      }
      onKeyDown={e =>
        e.key === "Enter" &&
        void go()
      }
      placeholder="z. B. Lightning Bolt"
    />

    <button
      className="primary"
      onClick={go}
    >
      Suchen
    </button>
  </div>
</div>

{suggestions.length > 0 && (
  <div className="suggestions">
    {suggestions.map(s => (
      <button
        key={s}
        onClick={async () => {
          setQ(s);
          setSuggestions([]);
          setBusy(true);

          try {
            setResults(
              await searchCards(s)
            );
          } catch (e: any) {
            alert(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {s}
      </button>
    ))}
  </div>
)}

        {suggestions.length > 0 && (
          <div className="suggestions">
            {suggestions.map(s => (
              <button
                key={s}
                onClick={async () => {
                  setQ(s);
                  setSuggestions([]);
                  setBusy(true);

                  try {
                    setResults(
                      await searchCards(s)
                    );
                  } catch (e: any) {
                    alert(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

      </div>

      <SearchCollectionTools
        cards={cards}
        onImport={onImport}
      />

      {busy
        ? (
          <div className="loading">
            Scryfall fragt Karten ab…
          </div>
        )
        : (
          <div className="card-grid">
            {results.map(c => (
              <SearchCard
                key={c.id}
                card={c}
                onAdd={onAdd}
              />
            ))}
          </div>
        )}
    </section>
  );
}

function SearchCollectionTools({
  cards,
  onImport
}: {
  cards: CardRecord[];
  onImport: (
    c: CardRecord[]
  ) => Promise<void>;
}) {
  const [showImport, setShowImport] =
    useState(false);
  const [importText, setImportText] =
    useState("");
  const [importBusy, setImportBusy] =
    useState(false);
  const [importPreview, setImportPreview] =
    useState<{
      cards: CardRecord[];
      requestedRows: number;
      resolvedRows: number;
      addedCopies: number;
      source: "csv" | "text";
      issues: string[];
    } | null>(null);

  const [showBulkAdd, setShowBulkAdd] =
    useState(false);
  const [bulkSetCode, setBulkSetCode] =
    useState("");
  const [bulkNumbers, setBulkNumbers] =
    useState("");
  const [bulkSets, setBulkSets] =
    useState<ScryfallSet[]>([]);
  const [bulkSetsBusy, setBulkSetsBusy] =
    useState(false);
  const [bulkBusy, setBulkBusy] =
    useState(false);
  const [bulkPreview, setBulkPreview] =
    useState<{
      cards: CardRecord[];
      rows: Array<{
        collectorNumber: string;
        count: number;
        name?: string;
        finish?: CardFinish;
        found: boolean;
      }>;
      requestedCopies: number;
      resolvedCopies: number;
      issues: string[];
    } | null>(null);

  const resetImport = () => {
    setImportText("");
    setImportPreview(null);
  };

  const closeImport = () => {
    resetImport();
    setShowImport(false);
  };

  const resetBulkAdd = () => {
    setBulkNumbers("");
    setBulkPreview(null);
  };

  const closeBulkAdd = () => {
    resetBulkAdd();
    setShowBulkAdd(false);
  };

  const ensureBulkSets = async () => {
    if (
      bulkSets.length > 0 ||
      bulkSetsBusy
    ) {
      return;
    }

    setBulkSetsBusy(true);

    try {
      setBulkSets(
        await getSets()
      );
    } catch (error) {
      console.error(
        "Scryfall-Sets konnten nicht geladen werden:",
        error
      );
      alert(
        "Die Set-Liste konnte nicht von Scryfall geladen werden."
      );
    } finally {
      setBulkSetsBusy(false);
    }
  };

  const toggleBulkAdd = () => {
    const next = !showBulkAdd;

    if (next) {
      closeImport();
      void ensureBulkSets();
    }

    setShowBulkAdd(next);
  };

  const previewBulkAdd = async () => {
    const numbers =
      parseCollectorNumbers(
        bulkNumbers
      );

    if (
      !bulkSetCode ||
      numbers.length === 0
    ) {
      return;
    }

    setBulkBusy(true);
    setBulkPreview(null);

    try {
      const counts =
        collectorNumberCounts(
          numbers
        );

      const lookup =
        await getCardsBySetAndCollectorNumbers(
          bulkSetCode,
          Array.from(
            counts.keys()
          )
        );

      const byCollectorNumber =
        new Map(
          lookup.cards.map(
            card => [
              card.collector_number
                .toLowerCase(),
              card
            ] as const
          )
        );

      const next =
        cards.map(
          card => ({
            ...card,
            ...(card.finishCounts
              ? {
                  finishCounts: {
                    ...card.finishCounts
                  }
                }
              : {})
          })
        );

      const rows:
        Array<{
          collectorNumber: string;
          count: number;
          name?: string;
          finish?: CardFinish;
          found: boolean;
        }> = [];
      const issues: string[] = [];
      let resolvedCopies = 0;

      for (
        const [
          collectorNumber,
          count
        ] of counts
      ) {
        const scryfallCard =
          byCollectorNumber.get(
            collectorNumber
          );

        if (!scryfallCard) {
          rows.push({
            collectorNumber,
            count,
            found: false
          });
          issues.push(
            `#${collectorNumber}: in diesem Set nicht gefunden.`
          );
          continue;
        }

        const finishes =
          availableFinishes(
            scryfallCard
          );

        const finish:
          CardFinish | undefined =
            finishes.includes(
              "nonfoil"
            )
              ? "nonfoil"
              : finishes.includes(
                  "foil"
                )
                ? "foil"
                : undefined;

        if (!finish) {
          rows.push({
            collectorNumber,
            count,
            name: scryfallCard.name,
            found: false
          });
          issues.push(
            `#${collectorNumber} ${scryfallCard.name}: Scryfall meldet kein unterstütztes Finish.`
          );
          continue;
        }

        const normalized =
          normalizeCard(
            scryfallCard,
            count,
            finish === "foil"
          );

        const existing =
          next.find(
            card =>
              card.id ===
                normalized.id ||
              (
                card.oracleId ===
                  normalized.oracleId &&
                card.set.toLowerCase() ===
                  normalized.set.toLowerCase() &&
                card.collectorNumber.toLowerCase() ===
                  normalized.collectorNumber.toLowerCase()
              )
          );

        if (existing) {
          const currentCounts =
            finishCountsFor(
              existing
            );
          const nextCounts = {
            ...currentCounts,
            [finish]:
              currentCounts[finish] +
              count
          };

          existing.count += count;
          existing.finishCounts =
            nextCounts;
          existing.availableFinishes =
            normalized.availableFinishes;
          existing.priceEur =
            normalized.priceEur ??
            existing.priceEur;
          existing.priceEurFoil =
            normalized.priceEurFoil ??
            existing.priceEurFoil;
          existing.priceUpdatedAt =
            normalized.priceUpdatedAt;
          existing.gameChanger =
            normalized.gameChanger ??
            existing.gameChanger;
          existing.foil =
            legacyFoilFlag(
              nextCounts
            );
          existing.updatedAt =
            Date.now();
        } else {
          next.push(
            normalized
          );
        }

        rows.push({
          collectorNumber:
            scryfallCard.collector_number,
          count,
          name:
            scryfallCard.name,
          finish,
          found: true
        });

        resolvedCopies += count;
      }

      setBulkPreview({
        cards: next,
        rows,
        requestedCopies:
          numbers.length,
        resolvedCopies,
        issues
      });
    } catch (error) {
      console.error(
        "Bulk-Hinzufügen fehlgeschlagen:",
        error
      );
      alert(
        "Die Collector Numbers konnten nicht vollständig bei Scryfall geprüft werden."
      );
    } finally {
      setBulkBusy(false);
    }
  };

  const applyBulkAdd = async () => {
    if (
      !bulkPreview ||
      bulkPreview.resolvedCopies === 0
    ) {
      return;
    }

    setBulkBusy(true);

    try {
      await onImport(
        bulkPreview.cards
      );
      closeBulkAdd();
    } finally {
      setBulkBusy(false);
    }
  };

  const readImportFile = async (
    file: File | undefined
  ) => {
    if (!file) {
      return;
    }

    try {
      setImportText(
        await file.text()
      );
      setImportPreview(null);
    } catch {
      setImportPreview({
        cards: cards.map(
          card => ({ ...card })
        ),
        requestedRows: 0,
        resolvedRows: 0,
        addedCopies: 0,
        source: "text",
        issues: [
          "Die ausgewählte Datei konnte nicht gelesen werden."
        ]
      });
    }
  };

  const previewCollectionImport =
    async () => {
      if (!importText.trim()) {
        return;
      }

      setImportBusy(true);
      setImportPreview(null);

      try {
        const csvRows =
          parseCollectionCsv(
            importText
          );

        const source:
          "csv" | "text" =
            csvRows.length > 0
              ? "csv"
              : "text";

        const parsedTextRows =
          parseDeckList(
            importText
          );

        const rows =
          source === "csv"
            ? csvRows
            : parsedTextRows.flatMap(
                row =>
                  row.kind === "card"
                    ? [
                        {
                          name: row.name,
                          count: row.count,
                          set: row.set,
                          collectorNumber:
                            row.collectorNumber
                        }
                      ]
                    : []
              );

        const next =
          cards.map(
            card => ({
              ...card,
              ...(card.finishCounts
                ? {
                    finishCounts: {
                      ...card.finishCounts
                    }
                  }
                : {})
            })
          );

        const issues: string[] = [];
        let resolvedRows = 0;
        let addedCopies = 0;

        for (const row of rows) {
          try {
            const matches =
              await searchCards(
                row.name
              );

            const exactNameMatches =
              matches.filter(
                card =>
                  card.name.toLowerCase() ===
                  row.name.toLowerCase()
              );

            let candidates =
              exactNameMatches.length > 0
                ? exactNameMatches
                : matches;

            if (row.set) {
              candidates =
                candidates.filter(
                  card =>
                    card.set.toLowerCase() ===
                    row.set!.toLowerCase()
                );
            }

            if (row.collectorNumber) {
              candidates =
                candidates.filter(
                  card =>
                    card.collector_number.toLowerCase() ===
                    row.collectorNumber!.toLowerCase()
                );
            }

            const chosen =
              candidates[0];

            if (!chosen) {
              issues.push(
                `${row.count}× ${row.name}: nicht bei Scryfall gefunden${row.set ? ` (Set ${row.set.toUpperCase()})` : ""}.`
              );
              continue;
            }

            const finishes =
              availableFinishes(
                chosen
              );
            const isFoilOnly =
              !finishes.includes(
                "nonfoil"
              ) &&
              finishes.includes(
                "foil"
              );

            const normalized =
              normalizeCard(
                chosen,
                row.count,
                isFoilOnly
              );

            const existing =
              next.find(
                card =>
                  card.id ===
                    normalized.id
              );

            if (existing) {
              const counts =
                finishCountsFor(
                  existing
                );
              const finish:
                CardFinish =
                  isFoilOnly
                    ? "foil"
                    : "nonfoil";
              const nextCounts = {
                ...counts,
                [finish]:
                  counts[finish] +
                  row.count
              };

              existing.count +=
                row.count;
              existing.finishCounts =
                nextCounts;
              existing.availableFinishes =
                normalized.availableFinishes;
              existing.priceEur =
                normalized.priceEur ??
                existing.priceEur;
              existing.priceEurFoil =
                normalized.priceEurFoil ??
                existing.priceEurFoil;
              existing.priceUpdatedAt =
                normalized.priceUpdatedAt;
              existing.gameChanger =
                normalized.gameChanger ??
                existing.gameChanger;
              existing.foil =
                legacyFoilFlag(
                  nextCounts
                );
              existing.updatedAt =
                Date.now();
            } else {
              next.push(
                normalized
              );
            }

            resolvedRows += 1;
            addedCopies +=
              row.count;
          } catch {
            issues.push(
              `${row.count}× ${row.name}: Scryfall-Abfrage fehlgeschlagen.`
            );
          }
        }

        setImportPreview({
          cards: next,
          requestedRows:
            rows.length,
          resolvedRows,
          addedCopies,
          source,
          issues
        });
      } finally {
        setImportBusy(false);
      }
    };

  const applyCollectionImport =
    async () => {
      if (
        !importPreview ||
        importPreview.resolvedRows === 0
      ) {
        return;
      }

      setImportBusy(true);

      try {
        await onImport(
          importPreview.cards
        );
        closeImport();
      } finally {
        setImportBusy(false);
      }
    };

  return (
    <>
      <div className="search-tool-actions">
        <button
          className="secondary"
          onClick={toggleBulkAdd}
        >
          Bulk hinzufügen
        </button>

        <button
          className="secondary"
          onClick={() => {
            if (showImport) {
              closeImport();
            } else {
              closeBulkAdd();
              setShowImport(true);
            }
          }}
        >
          Import
        </button>
      </div>

      {showBulkAdd && (
        <div className="panel">
          <h3>Bulk hinzufügen</h3>
          <p className="muted">
            Wähle ein Set und gib die Collector Numbers durch Kommas getrennt ein. Wiederholte Nummern erhöhen automatisch die Anzahl. Gibt es Non-Foil und Foil, wird beim Bulk standardmäßig Non-Foil verwendet.
          </p>

          <div className="two">
            <label>
              Set
              <select
                value={bulkSetCode}
                onChange={e => {
                  setBulkSetCode(
                    e.target.value
                  );
                  setBulkPreview(null);
                }}
                disabled={bulkSetsBusy}
              >
                <option value="">
                  {bulkSetsBusy
                    ? "Sets werden geladen…"
                    : "— Set auswählen —"}
                </option>
                {bulkSets.map(set => (
                  <option
                    key={set.id}
                    value={set.code}
                  >
                    {set.name} ({set.code.toUpperCase()})
                  </option>
                ))}
              </select>
            </label>

            <label>
              Collector Numbers
              <textarea
                value={bulkNumbers}
                onChange={e => {
                  setBulkNumbers(
                    e.target.value
                  );
                  setBulkPreview(null);
                }}
                rows={4}
                placeholder="z. B. 12, 18, 18, 34, 105"
              />
            </label>
          </div>

          <div className="row">
            <button
              className="primary"
              onClick={() =>
                void previewBulkAdd()
              }
              disabled={
                bulkBusy ||
                !bulkSetCode ||
                parseCollectorNumbers(
                  bulkNumbers
                ).length === 0
              }
            >
              {bulkBusy
                ? "Bulk wird geprüft…"
                : "Bulk prüfen"}
            </button>
            <button
              className="secondary"
              onClick={closeBulkAdd}
              disabled={bulkBusy}
            >
              Abbrechen
            </button>
          </div>

          {bulkPreview && (
            <div className="ai-box">
              <h3>Bulk-Vorschau</h3>
              <p>
                Eingaben: <strong>{bulkPreview.requestedCopies}</strong> Karten
                <br />
                Gefunden: <strong>{bulkPreview.resolvedCopies}</strong> Karten
              </p>

              <div className="deck-list">
                {bulkPreview.rows.map(row => (
                  <div key={row.collectorNumber}>
                    <span>
                      #{row.collectorNumber}
                      {row.name
                        ? ` · ${row.name}`
                        : " · nicht gefunden"}
                    </span>
                    <strong>
                      {row.count}×
                      {row.finish
                        ? ` · ${finishLabel(row.finish)}`
                        : ""}
                    </strong>
                  </div>
                ))}
              </div>

              {bulkPreview.issues.length > 0 && (
                <div className="notice">
                  <strong>Hinweise:</strong>
                  <div className="deck-list">
                    {bulkPreview.issues.map(
                      (issue, index) => (
                        <div key={`${issue}-${index}`}>
                          <span>{issue}</span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              <div className="row">
                <button
                  className="primary"
                  onClick={() =>
                    void applyBulkAdd()
                  }
                  disabled={
                    bulkBusy ||
                    bulkPreview.resolvedCopies === 0
                  }
                >
                  Bulk übernehmen
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    setBulkPreview(null)
                  }
                  disabled={bulkBusy}
                >
                  Eingabe bearbeiten
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showImport && (
        <div className="panel">
          <h3>Sammlung importieren</h3>
          <p className="muted">
            Du kannst eine Textliste oder eine CSV-Datei importieren. CSV-Dateien aus Arcane Decksmith können Set und Collector Number zur genauen Zuordnung enthalten.
          </p>

          <label>
            CSV- oder Textdatei auswählen
            <input
              type="file"
              accept=".csv,text/csv,.txt,text/plain"
              onChange={e =>
                void readImportFile(
                  e.target.files?.[0]
                )
              }
            />
          </label>

          <textarea
            value={importText}
            onChange={e => {
              setImportText(
                e.target.value
              );
              setImportPreview(null);
            }}
            placeholder={
              "4 Lightning Bolt\n2x Counterspell\n1 Sol Ring"
            }
            rows={7}
          />

          <div className="row">
            <button
              className="primary"
              onClick={() =>
                void previewCollectionImport()
              }
              disabled={
                importBusy ||
                !importText.trim()
              }
            >
              {importBusy
                ? "Import wird geprüft…"
                : "Import prüfen"}
            </button>
            <button
              className="secondary"
              onClick={closeImport}
              disabled={importBusy}
            >
              Abbrechen
            </button>
          </div>

          {importPreview && (
            <div className="ai-box">
              <h3>Import-Zusammenfassung</h3>
              <p>
                Quelle: <strong>{importPreview.source === "csv" ? "CSV" : "Textliste"}</strong>
                <br />
                Zeilen erkannt: <strong>{importPreview.requestedRows}</strong>
                <br />
                Erfolgreich aufgelöst: <strong>{importPreview.resolvedRows}</strong>
                <br />
                Hinzugefügte Karten: <strong>{importPreview.addedCopies}</strong>
              </p>

              {importPreview.issues.length > 0 && (
                <div className="notice">
                  <strong>Hinweise vor dem Übernehmen:</strong>
                  <div className="deck-list">
                    {importPreview.issues.map(
                      (issue, index) => (
                        <div key={`${issue}-${index}`}>
                          <span>{issue}</span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              <button
                className="primary"
                onClick={() =>
                  void applyCollectionImport()
                }
                disabled={
                  importBusy ||
                  importPreview.resolvedRows === 0
                }
              >
                Import übernehmen
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SearchCard({
  card,
  onAdd
}: {
  card: ScryfallCard;
  onAdd: (
    card: ScryfallCard,
    finish: CardFinish
  ) => void | Promise<void>;
}) {
  const [
    selectedCard,
    setSelectedCard
  ] =
    useState<ScryfallCard>(card);

  const [
    selectedFinish,
    setSelectedFinish
  ] =
    useState<CardFinish>(
      availableFinishes(card)[0] ??
      "nonfoil"
    );

  const [
    printings,
    setPrintings
  ] =
    useState<ScryfallCard[]>([]);

  const [
    showPrintings,
    setShowPrintings
  ] =
    useState(false);

  const [
    loadingPrintings,
    setLoadingPrintings
  ] =
    useState(false);

  const [
    printingError,
    setPrintingError
  ] =
    useState("");

  useEffect(() => {
    setSelectedCard(card);
    setSelectedFinish(
      availableFinishes(card)[0] ??
      "nonfoil"
    );
    setPrintings([]);
    setShowPrintings(false);
    setPrintingError("");
  }, [card.id]);

  useEffect(() => {
    const finishes =
      availableFinishes(
        selectedCard
      );

    setSelectedFinish(
      current =>
        finishes.includes(current)
          ? current
          : finishes[0] ??
            "nonfoil"
    );
  }, [selectedCard.id]);

  const selectedFinishes =
    availableFinishes(
      selectedCard
    );

  const loadPrintings = async () => {
    if (showPrintings) {
      setShowPrintings(false);
      return;
    }

    setShowPrintings(true);

    if (printings.length > 0) {
      return;
    }

    setLoadingPrintings(true);
    setPrintingError("");

    try {
      const variants =
        await getPrintings(card);

      setPrintings(variants);
    } catch {
      setPrintingError(
        "Die Varianten konnten nicht von Scryfall geladen werden."
      );
    } finally {
      setLoadingPrintings(false);
    }
  };

  return (
    <article className="card-tile">
      <img
        alt={displayName(selectedCard)}
        src={imageFor(selectedCard)}
        loading="lazy"
      />

      <div className="card-body">
        <h3>
          {displayName(selectedCard)}
        </h3>

        <div className="meta">
          {selectedCard.mana_cost ?? "—"} ·
          {" "}MV {selectedCard.cmc ?? 0} ·{" "}
          {selectedCard.set.toUpperCase()}
          {" "}#
          {selectedCard.collector_number}
        </div>

        {selectedCard.set_name && (
          <div className="meta">
            {selectedCard.set_name}
          </div>
        )}

        <p>
          {displayTypeLine(
            selectedCard
          )}
        </p>

        <p className="oracle">
          {displayOracleText(
            selectedCard
          )}
        </p>

        <div className="variant-box">
          <div className="variant-info-title">
            Finish & Scryfall-Preis
          </div>

          {selectedFinishes.length > 0
            ? (
              <div className="row">
                {selectedFinishes.map(
                  finish => (
                    <button
                      key={finish}
                      className={
                        selectedFinish ===
                        finish
                          ? "primary"
                          : "secondary"
                      }
                      onClick={() =>
                        setSelectedFinish(
                          finish
                        )
                      }
                    >
                      {finishLabel(
                        finish
                      )}
                      {" · "}
                      {formatEuro(
                        euroPriceFor(
                          selectedCard,
                          finish
                        )
                      )}
                    </button>
                  )
                )}
              </div>
            )
            : (
              <div className="muted">
                Für diese Ausgabe meldet Scryfall kein unterstütztes
                Non-Foil- oder Foil-Finish.
              </div>
            )}
        </div>

        <div className="variant-actions">
          <button
            className="secondary"
            onClick={loadPrintings}
            disabled={
              loadingPrintings
            }
          >
            {loadingPrintings
              ? "Varianten werden geladen…"
              : showPrintings
                ? "Varianten schließen"
                : "Varianten / Drucke"}
          </button>
        </div>

        {showPrintings && (
          <div className="variant-box">
            {printingError && (
              <div className="error">
                {printingError}
              </div>
            )}

            {!printingError &&
              loadingPrintings && (
                <div className="muted">
                  Scryfall lädt verfügbare
                  Drucke…
                </div>
              )}

            {!loadingPrintings &&
              printings.length > 0 && (
                <>
                  <div className="variant-field">
                    <label
                      htmlFor={
                        `variant-${card.id}`
                      }
                    >
                      Ausgabe auswählen
                    </label>

                    <select
                      id={
                        `variant-${card.id}`
                      }
                      className="variant-select"
                      value={
                        selectedCard.id
                      }
                      onChange={e => {
                        const chosen =
                          printings.find(
                            p =>
                              p.id ===
                              e.target.value
                          );

                        if (chosen) {
                          setSelectedCard(
                            chosen
                          );
                        }
                      }}
                    >
                      {printings.map(p => (
                        <option
                          key={p.id}
                          value={p.id}
                        >
                          {(
                            p.set_name ??
                            p.set
                          )}
                          {" · #"}
                          {
                            p.collector_number
                          }
                          {p.lang &&
                          p.lang !== "en"
                            ? ` · ${p.lang.toUpperCase()}`
                            : ""}
                          {" · "}
                          {availableFinishes(
                            p
                          )
                            .map(
                              finish =>
                                `${finishLabel(finish)} ${formatEuro(
                                  euroPriceFor(
                                    p,
                                    finish
                                  )
                                )}`
                            )
                            .join(" / ")}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="variant-info">
                    <div className="variant-info-title">
                      Gewählte Ausgabe
                    </div>

                    <div className="variant-info-row">
                      <span>
                        Set
                      </span>

                      <strong>
                        {selectedCard.set_name ??
                          selectedCard.set.toUpperCase()}
                      </strong>
                    </div>

                    <div className="variant-info-row">
                      <span>
                        Collector-Nr.
                      </span>

                      <strong>
                        {
                          selectedCard.collector_number
                        }
                      </strong>
                    </div>

                    {selectedCard.lang && (
                      <div className="variant-info-row">
                        <span>
                          Sprache
                        </span>

                        <strong>
                          {selectedCard.lang.toUpperCase()}
                        </strong>
                      </div>
                    )}

                    {selectedCard.rarity && (
                      <div className="variant-info-row">
                        <span>
                          Seltenheit
                        </span>

                        <strong>
                          {
                            selectedCard.rarity
                          }
                        </strong>
                      </div>
                    )}
                  </div>
                </>
              )}
          </div>
        )}

        <div className="row search-card-actions">
          <button
            className="primary"
            disabled={
              selectedFinishes.length ===
              0
            }
            onClick={() =>
              onAdd(
                selectedCard,
                selectedFinish
              )
            }
          >
            + Sammlung
          </button>

          <a
            href={
              scryfallUrl(
                selectedCard.id
              )
            }
            target="_blank"
            rel="noreferrer"
          >
            Scryfall ↗
          </a>
        </div>
      </div>
    </article>
  );
}

function Collection({
  cards,
  onChange,
  onDelete
}: {
  cards: CardRecord[];
  onChange: (
    c: CardRecord
  ) => Promise<void>;
  onDelete: (
    id: string
  ) => Promise<void>;
}) {
  const [query, setQuery] =
    useState("");

  const [group, setGroup] =
    useState<GroupBy>("none");

  const [view, setView] =
    useState<ViewMode>("grid");

  const [sort, setSort] =
    useState("name");

  const [selected, setSelected] =
    useState<Set<string>>(
      new Set()
    );

  const filtered =
    useMemo(
      () =>
        cards
          .filter(c =>
            `${c.name} ${c.set} ${c.setName ?? ""} ${c.typeLine} ${c.oracleText}`
              .toLowerCase()
              .includes(
                query.toLowerCase()
              )
          )
          .sort((a, b) =>
            sort === "mv"
              ? a.manaValue -
                b.manaValue
              : sort === "count"
                ? b.count -
                  a.count
                : sort === "value"
                  ? (
                      (
                        highestOwnedUnitValue(
                          b
                        ) ?? -1
                      ) -
                      (
                        highestOwnedUnitValue(
                          a
                        ) ?? -1
                      )
                    ) ||
                    a.name.localeCompare(
                      b.name
                    )
                  : a.name.localeCompare(
                      b.name
                    )
          ),
      [
        cards,
        query,
        sort
      ]
    );

  const total =
    cards.reduce(
      (n, c) =>
        n + c.count,
      0
    );

  const collectionStats = useMemo(() => {
    const physicalTotal =
      cards.reduce(
        (sum, card) =>
          sum + card.count,
        0
      );

    const uniqueTotal =
      cards.length;

    const nonlandCards =
      cards.filter(
        card =>
          !/(?:^|\s)Land(?:\s|$|—)/i.test(
            card.typeLine ?? ""
          )
      );

    const nonlandPhysicalTotal =
      nonlandCards.reduce(
        (sum, card) =>
          sum + card.count,
        0
      );

    const averageCopies =
      uniqueTotal > 0
        ? physicalTotal /
          uniqueTotal
        : 0;

    const weightedManaValue =
      nonlandCards.reduce(
        (sum, card) =>
          sum +
          (
            Number.isFinite(
              card.manaValue
            )
              ? card.manaValue
              : 0
          ) *
            card.count,
        0
      );

    const averageManaValue =
      nonlandPhysicalTotal > 0
        ? weightedManaValue /
          nonlandPhysicalTotal
        : 0;

    const colorCounts:
      Record<string, number> = {
        Weiß: 0,
        Blau: 0,
        Schwarz: 0,
        Rot: 0,
        Grün: 0,
        Mehrfarbig: 0,
        Farblos: 0
      };

    for (
      const card
      of cards
    ) {
      const colors =
        card.colors ?? [];

      let key =
        "Farblos";

      if (
        colors.length > 1
      ) {
        key =
          "Mehrfarbig";
      } else if (
        colors.length === 1
      ) {
        key =
          COLOR_NAMES[
            colors[0]
          ] ??
          "Farblos";
      }

      colorCounts[key] =
        (
          colorCounts[key] ??
          0
        ) +
        card.count;
    }

    const manaCounts:
      Record<string, number> = {
        "MV 0": 0,
        "MV 1": 0,
        "MV 2": 0,
        "MV 3": 0,
        "MV 4": 0,
        "MV 5": 0,
        "MV 6": 0,
        "MV 7+": 0
      };

    for (
      const card
      of nonlandCards
    ) {
      const mv =
        Math.max(
          0,
          Math.floor(
            Number.isFinite(
              card.manaValue
            )
              ? card.manaValue
              : 0
          )
        );

      const key =
        mv >= 7
          ? "MV 7+"
          : `MV ${mv}`;

      manaCounts[key] =
        (
          manaCounts[key] ??
          0
        ) +
        card.count;
    }

    const typeCounts:
      Record<string, number> =
        Object.fromEntries(
          TYPE_ORDER.map(
            type => [
              type,
              0
            ]
          )
        );

    for (
      const card
      of cards
    ) {
      const key =
        primaryTypeGroup(
          card.typeLine
        );

      typeCounts[key] =
        (
          typeCounts[key] ??
          0
        ) +
        card.count;
    }

    const setMap =
      new Map<
        string,
        {
          name: string;
          count: number;
        }
      >();

    for (
      const card
      of cards
    ) {
      const key =
        card.set.toLowerCase();

      const existing =
        setMap.get(key);

      if (existing) {
        existing.count +=
          card.count;
      } else {
        setMap.set(
          key,
          {
            name:
              card.setName ??
              card.set.toUpperCase(),
            count:
              card.count
          }
        );
      }
    }

    const sets =
      Array.from(
        setMap.values()
      ).sort(
        (a, b) =>
          b.count -
            a.count ||
          a.name.localeCompare(
            b.name,
            "de"
          )
      );

    const mostFrequent =
      [...cards]
        .filter(
          card =>
            card.count > 1
        )
        .sort(
          (a, b) =>
            b.count -
              a.count ||
            a.name.localeCompare(
              b.name,
              "de"
            )
        )
        .slice(
          0,
          10
        );

    let collectionValue = 0;
    let unpricedCopies = 0;

    let mostValuableCard:
      | {
          name: string;
          finish: CardFinish;
          value: number;
        }
      | null = null;

    for (
      const card
      of cards
    ) {
      const cardValue =
        collectionValueForCard(
          card
        );

      collectionValue +=
        cardValue.value;

      unpricedCopies +=
        cardValue.unpricedCopies;

      const counts =
        finishCountsFor(card);

      for (
        const finish
        of [
          "nonfoil",
          "foil"
        ] as CardFinish[]
      ) {
        if (
          counts[finish] <= 0
        ) {
          continue;
        }

        const value =
          priceForRecord(
            card,
            finish
          );

        if (
          value !== undefined &&
          (
            !mostValuableCard ||
            value >
              mostValuableCard.value
          )
        ) {
          mostValuableCard = {
            name: card.name,
            finish,
            value
          };
        }
      }
    }

    const toRows = (
      counts:
        Record<
          string,
          number
        >,
      base: number
    ) =>
      Object.entries(
        counts
      ).map(
        ([
          label,
          count
        ]) => ({
          label,
          count,
          percentage:
            base > 0
              ? (
                  count /
                  base
                ) *
                100
              : 0
        })
      );

    return {
      physicalTotal,
      uniqueTotal,
      averageCopies,
      averageManaValue,
      collectionValue,
      unpricedCopies,
      mostValuableCard,

      colors:
        toRows(
          colorCounts,
          physicalTotal
        ),

      manaValues:
        toRows(
          manaCounts,
          nonlandPhysicalTotal
        ),

      types:
        toRows(
          typeCounts,
          physicalTotal
        ),

      sets,
      mostFrequent
    };
  }, [cards]);

  const groups =
    useMemo(() => {
      if (
        group ===
        "none"
      ) {
        return [
          [
            "Alle",
            filtered
          ]
        ] as Array<
          [
            string,
            CardRecord[]
          ]
        >;
      }

      const grouped =
        filtered.reduce<
          Record<
            string,
            CardRecord[]
          >
        >(
          (
            acc,
            card
          ) => {
            const key =
              group === "color"
                ? colorGroupName(
                    card.colors
                  )
                : group === "type"
                  ? primaryTypeGroup(
                      card.typeLine
                    )
                  : group === "set"
                    ? (
                        card.setName ??
                        card.set.toUpperCase()
                      )
                    : `MV ${card.manaValue}`;

            (
              acc[key] ??=
                []
            ).push(card);

            return acc;
          },
          {}
        );

      return Object
        .entries(grouped)
        .sort(
          (
            [a],
            [b]
          ) =>
            compareGroupNames(
              a,
              b,
              group
            )
        );
    }, [
      filtered,
      group
    ]);

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Sammlung</h2>

          <p className="muted">
            {cards.length} unterschiedliche Karten · {total} physische Karten
          </p>
        </div>

        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              download(
                "collection.csv",
                toCsv(cards),
                "text/csv;charset=utf-8"
              )
            }
          >
            CSV export
          </button>
        </div>
      </div>

      <details className="panel collection-stats">
  <summary className="collection-stats-toggle">
    Sammlungs-Statistiken
  </summary>
        <style>{`
          .collection-stats-summary{
            display:grid;
            grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
            gap:12px;
            margin-bottom:18px;
          }

          .collection-stat-card{
            padding:12px;
            border:1px solid rgba(255,255,255,.12);
            border-radius:12px;
            background:rgba(255,255,255,.025);
          }

          .collection-stat-card strong{
            display:block;
            font-size:1.35rem;
            margin-bottom:4px;
          }

.collection-stat-card > span,
.collection-stat-card > small{
  display:block;
}

.collection-stat-card > small{
  margin-top:6px;
  line-height:1.4;
}

          .collection-stat-grid{
            display:grid;
            grid-template-columns:repeat(3,minmax(0,1fr));
            gap:18px;
          }

          .collection-stat-extra{
            margin-top:22px;
          }

          .collection-stat-extra .deck-list{
            max-height:320px;
            overflow:auto;
          }

          .collection-stat-extra .deck-list > div{
            display:flex;
            justify-content:space-between;
            gap:12px;
          }


          .collection-stat-section h3{
            margin-top:0;
          }

          .collection-stat-row{
            margin-bottom:10px;
          }

          .collection-stat-label{
            display:flex;
            justify-content:space-between;
            gap:12px;
            margin-bottom:4px;
            font-size:.92rem;
          }

          .collection-stat-row progress{
            width:100%;
            height:10px;
          }

          @media (max-width:900px){
            .collection-stat-grid{
              grid-template-columns:1fr;
            }
          }
        `}</style>

        <div className="collection-stats-summary">
          <div className="collection-stat-card">
            <strong>
              {collectionStats.physicalTotal}
            </strong>

            <span className="muted">
              Physische Karten
            </span>
          </div>

          <div className="collection-stat-card">
            <strong>
              {collectionStats.uniqueTotal}
            </strong>

            <span className="muted">
              Unterschiedliche Karten
            </span>
          </div>

          <div className="collection-stat-card">
            <strong>
              {collectionStats.averageCopies.toFixed(2)}
            </strong>

            <span className="muted">
              Ø Exemplare pro Karte
            </span>
          </div>

          <div className="collection-stat-card">
            <strong>
              {collectionStats.averageManaValue.toFixed(2)}
            </strong>

            <span className="muted">
              Ø Mana Value ohne Länder
            </span>
          </div>

          <div className="collection-stat-card">
            <strong>
              {collectionStats.unpricedCopies <
              collectionStats.physicalTotal
                ? formatEuro(
                    collectionStats.collectionValue
                  )
                : "—"}
            </strong>

            <span className="muted">
              Sammlungswert
            </span>

            {collectionStats.unpricedCopies > 0 && (
              <small className="muted">
                {collectionStats.unpricedCopies} Exemplar(e) ohne EUR-Preis
              </small>
            )}
          </div>

          <div className="collection-stat-card">
            <strong>
              {collectionStats.mostValuableCard
                ? formatEuro(
                    collectionStats
                      .mostValuableCard
                      .value
                  )
                : "—"}
            </strong>

            <span className="muted">
              Teuerste Karte
            </span>

            {collectionStats.mostValuableCard && (
              <small className="muted">
                {
                  collectionStats
                    .mostValuableCard
                    .name
                }
                {" · "}
                {finishLabel(
                  collectionStats
                    .mostValuableCard
                    .finish
                )}
              </small>
            )}
          </div>
        </div>

        <div className="collection-stat-grid">
          <div className="collection-stat-section">
            <h3>
              Farben
            </h3>

            <p className="muted">
              Verteilung der physischen Karten nach ihren gedruckten Farben.
            </p>

            {collectionStats.colors.map(
              row => (
                <div
                  className="collection-stat-row"
                  key={row.label}
                >
                  <div className="collection-stat-label">
                    <span>
                      {row.label}
                    </span>

                    <span>
                      {row.count} ·{" "}
                      {row.percentage.toFixed(1)}%
                    </span>
                  </div>

                  <progress
                    max={100}
                    value={row.percentage}
                  />
                </div>
              )
            )}
          </div>

          <div className="collection-stat-section">
            <h3>
              Mana Value
            </h3>

            <p className="muted">
              Nur Nichtländer, damit Länder die MV-0-Verteilung nicht verzerren.
            </p>

            {collectionStats.manaValues.map(
              row => (
                <div
                  className="collection-stat-row"
                  key={row.label}
                >
                  <div className="collection-stat-label">
                    <span>
                      {row.label}
                    </span>

                    <span>
                      {row.count} ·{" "}
                      {row.percentage.toFixed(1)}%
                    </span>
                  </div>

                  <progress
                    max={100}
                    value={row.percentage}
                  />
                </div>
              )
            )}
          </div>

          <div className="collection-stat-section">
            <h3>
              Kartenarten
            </h3>

            <p className="muted">
              Jede Karte wird nach ihrem primären Kartentyp genau einmal gezählt.
            </p>

            {collectionStats.types.map(
              row => (
                <div
                  className="collection-stat-row"
                  key={row.label}
                >
                  <div className="collection-stat-label">
                    <span>
                      {row.label}
                    </span>

                    <span>
                      {row.count} ·{" "}
                      {row.percentage.toFixed(1)}%
                    </span>
                  </div>

                  <progress
                    max={100}
                    value={row.percentage}
                  />
                </div>
              )
            )}
          </div>
        </div>

        <div className="collection-stat-grid collection-stat-extra">
          <div className="collection-stat-section">
            <h3>Häufigste Karten</h3>

            {collectionStats.mostFrequent.length === 0
              ? (
                <p className="muted">
                  Keine Karte ist mehrfach vorhanden.
                </p>
              )
              : (
                <div className="deck-list">
                  {collectionStats.mostFrequent.map(card => (
                    <div key={card.id}>
                      <span>
                        {card.name}
                      </span>
                      <strong>
                        {card.count}×
                      </strong>
                    </div>
                  ))}
                </div>
              )}
          </div>

          <div className="collection-stat-section">
            <h3>Set-Verteilung</h3>

            {collectionStats.sets.length === 0
              ? (
                <p className="muted">
                  Keine Set-Daten vorhanden.
                </p>
              )
              : (
                <div className="deck-list">
                  {collectionStats.sets
                    .slice(0, 12)
                    .map(set => (
                      <div key={set.name}>
                        <span>
                          {set.name}
                        </span>
                        <strong>
                          {set.count}
                        </strong>
                      </div>
                    ))}

                  {collectionStats.sets.length > 12 && (
                    <small className="muted">
                      + {collectionStats.sets.length - 12} weitere Sets
                    </small>
                  )}
                </div>
              )}
          </div>
        </div>
     </details>

      <div className="toolbar">
        <input
          value={query}
          onChange={e =>
            setQuery(
              e.target.value
            )
          }
          placeholder="Sammlung durchsuchen…"
        />

        <select
          value={sort}
          onChange={e =>
            setSort(
              e.target.value
            )
          }
        >
          <option value="name">
            Name
          </option>

          <option value="mv">
            Mana Value
          </option>

          <option value="count">
            Anzahl
          </option>

          <option value="value">
            Wert
          </option>
        </select>

        <select
          value={group}
          onChange={e =>
            setGroup(
              e.target
                .value as GroupBy
            )
          }
        >
          <option value="none">
            Keine Gruppierung
          </option>

          <option value="color">
            Farbe
          </option>

          <option value="type">
            Typ
          </option>

          <option value="set">
            Set
          </option>

          <option value="manaValue">
            Mana Value
          </option>
        </select>

        <button
          className="secondary"
          onClick={() =>
            setView(
              view === "grid"
                ? "list"
                : "grid"
            )
          }
        >
          {view === "grid"
            ? "Listenansicht"
            : "Kartenansicht"}
        </button>
      </div>

      {groups.map(
        ([name, list]) => (
          <div key={name}>
            <h3 className="group-title">
              {name}
            </h3>

            <div
              className={
                view === "grid"
                  ? "card-grid"
                  : "list-view"
              }
            >
              {list.map(c => (
                <CollectionCard
                  key={c.id}
                  card={c}
                  selected={
                    selected.has(
                      c.id
                    )
                  }
                  toggle={() =>
                    setSelected(s => {
                      const n =
                        new Set(s);

                      if (
                        n.has(c.id)
                      ) {
                        n.delete(c.id);
                      } else {
                        n.add(c.id);
                      }

                      return n;
                    })
                  }
                  onChange={
                    onChange
                  }
                  onDelete={
                    onDelete
                  }
                />
              ))}
            </div>
          </div>
        )
      )}

      {selected.size > 0 && (
        <div className="bulkbar">
          {selected.size} ausgewählt

          <button
            onClick={async () => {
              for (
                const id
                of selected
              ) {
                await onDelete(id);
              }

              setSelected(
                new Set()
              );
            }}
          >
            Ausgewählte löschen
          </button>
        </div>
      )}
    </section>
  );
}

function CollectionCard({
  card,
  selected,
  toggle,
  onChange,
  onDelete
}: {
  card: CardRecord;
  selected: boolean;
  toggle: () => void;
  onChange: (
    c: CardRecord
  ) => Promise<void>;
  onDelete: (
    id: string
  ) => Promise<void>;
}) {
  const counts =
    finishCountsFor(card);

  const finishesToShow =
    (
      [
        "nonfoil",
        "foil"
      ] as CardFinish[]
    ).filter(
      finish =>
        counts[finish] > 0 ||
        card.availableFinishes
          ?.includes(finish)
    );

  const cardValue =
    collectionValueForCard(
      card
    );

  const changeFinishCount = (
    finish: CardFinish,
    delta: number
  ) => {
    const nextCounts = {
      ...counts,
      [finish]:
        Math.max(
          0,
          counts[finish] +
            delta
        )
    };

    const nextTotal =
      nextCounts.nonfoil +
      nextCounts.foil;

    if (nextTotal < 1) {
      return;
    }

    void onChange({
      ...card,
      count: nextTotal,
      finishCounts:
        nextCounts,
      foil:
        legacyFoilFlag(
          nextCounts
        ),
      updatedAt:
        Date.now()
    });
  };

  return (
    <article className="collection-card">
      <div className="select">
        <input
          type="checkbox"
          checked={selected}
          onChange={toggle}
        />
      </div>

      {card.imageUri && (
        <img
          src={card.imageUri}
          alt=""
          loading="lazy"
        />
      )}

      <div className="card-body">
        <h3>
          {card.name}
        </h3>

        <div className="meta">
          {card.setName ??
            card.set.toUpperCase()}
          {" · #"}
          {card.collectorNumber}
          {" · MV "}
          {card.manaValue}
        </div>

        <p>
          {card.typeLine}
        </p>

        <div className="variant-box">
          <div className="variant-info-title">
            Finish & Scryfall-Preis
          </div>

          {finishesToShow.map(
            finish => (
              <div
                className="variant-info-row"
                key={finish}
              >
                <span>
                  {finishLabel(
                    finish
                  )}
                  {" ×"}
                  {counts[finish]}
                </span>

                <strong>
                  {formatEuro(
                    priceForRecord(
                      card,
                      finish
                    )
                  )}
                </strong>

                <span className="row">
                  <button
                    onClick={() =>
                      changeFinishCount(
                        finish,
                        -1
                      )
                    }
                    disabled={
                      counts[finish] ===
                        0 ||
                      card.count <= 1
                    }
                    aria-label={`${finishLabel(finish)} verringern`}
                  >
                    −
                  </button>

                  <button
                    onClick={() =>
                      changeFinishCount(
                        finish,
                        1
                      )
                    }
                    disabled={
                      !card.availableFinishes
                        ?.includes(
                          finish
                        ) &&
                      counts[finish] ===
                        0
                    }
                    aria-label={`${finishLabel(finish)} erhöhen`}
                  >
                    +
                  </button>
                </span>
              </div>
            )
          )}

          <div className="variant-info-row">
            <span>
              Gesamt
            </span>

            <strong>
              {card.count}×
            </strong>
          </div>

          <div className="variant-info-row">
            <span>
              Gesamtwert
            </span>

            <strong>
              {cardValue.unpricedCopies <
              card.count
                ? formatEuro(
                    cardValue.value
                  )
                : "kein EUR-Preis"}
            </strong>
          </div>

          {cardValue.unpricedCopies > 0 && (
            <small className="muted">
              {cardValue.unpricedCopies} Exemplar(e) ohne EUR-Preis
            </small>
          )}
        </div>

        <div className="quantity">
          <button
            className="danger ghost"
            onClick={() =>
              onDelete(card.id)
            }
          >
            Löschen
          </button>
        </div>
      </div>
    </article>
  );
}

type HelpDotProps = {
  text: string;
};

function HelpDot({
  text
}: HelpDotProps) {
  return (
    <span
      className="help-dot"
      title={text}
      aria-label={text}
      role="img"
      tabIndex={0}
    >
      ?
    </span>
  );
}

type TuningSliderProps = {
  label: string;
  value: number;
  onChange: (
    value: number
  ) => void;
  help: string;
  lowLabel?: string;
  highLabel?: string;
};

function TuningSlider({
  label,
  value,
  onChange,
  help,
  lowLabel = "Weniger",
  highLabel = "Mehr"
}: TuningSliderProps) {
  const valueText =
    value === 0
      ? "Standard"
      : value < 0
        ? value === -2
          ? `Deutlich ${lowLabel.toLowerCase()}`
          : lowLabel
        : value === 2
          ? `Deutlich ${highLabel.toLowerCase()}`
          : highLabel;

  return (
    <div className="tuning-control">
      <div className="tuning-control-head">
        <span>
          {label}
        </span>

        <HelpDot
          text={help}
        />

        <strong>
          {valueText}
        </strong>
      </div>

      <input
        type="range"
        min="-2"
        max="2"
        step="1"
        value={value}
        onChange={event =>
          onChange(
            Number(
              event.target.value
            )
          )
        }
        aria-label={label}
      />

      <div className="tuning-scale">
        <span>
          {lowLabel}
        </span>

        <span>
          Standard
        </span>

        <span>
          {highLabel}
        </span>
      </div>
    </div>
  );
}

function Builder({
  pool,
  onSave,
  demoMode
}: {
  pool: CardRecord[];
  onSave: (
    d: DeckRecord
  ) => Promise<void>;
  demoMode: boolean;
}) {
  const [
    format,
    setFormat
  ] =
    useState<Format>(
      "commander"
    );

  const [
    colors,
    setColors
  ] =
    useState<string[]>(
      [...COLORS]
    );

  const [
    commanderId,
    setCommanderId
  ] =
    useState("");

  const [
    secondCommanderId,
    setSecondCommanderId
  ] =
    useState("");

  const [
    target,
    setTarget
  ] =
    useState(3);

  const [
    min,
    setMin
  ] =
    useState(0);

  const [
    max,
    setMax
  ] =
    useState(15);

  const [
    name,
    setName
  ] =
    useState(
      "Neues Deck"
    );

  const [
    result,
    setResult
  ] =
    useState<
      DeckRecord |
      null
    >(null);

  const [
    analysisText,
    setAnalysisText
  ] =
    useState("");

  const [
    aiBusy,
    setAiBusy
  ] =
    useState(false);

  const [
    strategy,
    setStrategy
  ] =
    useState<DeckStrategy>(
      "balanced"
    );

  const [
    landsTune,
    setLandsTune
  ] =
    useState(0);

  const [
    rampTune,
    setRampTune
  ] =
    useState(0);

  const [
    drawTune,
    setDrawTune
  ] =
    useState(0);

  const [
    interactionTune,
    setInteractionTune
  ] =
    useState(0);

  const [
    boardwipeTune,
    setBoardwipeTune
  ] =
    useState(0);

  const [
    protectionTune,
    setProtectionTune
  ] =
    useState(0);

  const [
    recursionTune,
    setRecursionTune
  ] =
    useState(0);

  const [
    synergyTune,
    setSynergyTune
  ] =
    useState(0);

  const [
    curveTune,
    setCurveTune
  ] =
    useState(0);

  const [
    commanderSynergyTune,
    setCommanderSynergyTune
  ] =
    useState(0);

  const [
    aggressionTune,
    setAggressionTune
  ] =
    useState(0);

  const [
    lockedCards,
    setLockedCards
  ] =
    useState<
      LockedDeckCard[]
    >([]);

  const [
    excludedCardIds,
    setExcludedCardIds
  ] =
    useState<string[]>(
      []
    );

  const commanders =
    useMemo(
      () =>
        commanderCandidates(
          pool
        ),
      [pool]
    );

  const primaryCommander =
    useMemo(
      () =>
        commanders.find(
          card =>
            card.id ===
            commanderId
        ),
      [
        commanders,
        commanderId
      ]
    );

  const secondCommanderOptions =
    useMemo(
      () =>
        primaryCommander
          ? commanderPairCandidates(
              pool,
              primaryCommander
            )
          : [],
      [
        pool,
        primaryCommander
      ]
    );

  const secondCommander =
    useMemo(
      () =>
        secondCommanderOptions.find(
          card =>
            card.id ===
            secondCommanderId
        ),
      [
        secondCommanderOptions,
        secondCommanderId
      ]
    );

  const selectedCommanders =
    useMemo(
      () =>
        [
          primaryCommander,
          secondCommander
        ].filter(
          (
            card
          ): card is CardRecord =>
            Boolean(card)
        ),
      [
        primaryCommander,
        secondCommander
      ]
    );

  const activeColors =
    format === "commander"
      ? commanderColorIdentity(
          selectedCommanders
        )
      : colors;

  const tuning =
    useMemo<DeckTuning>(
      () => ({
        strategy,
        lands: landsTune,
        ramp: rampTune,
        draw: drawTune,
        interaction:
          interactionTune,
        boardwipes:
          boardwipeTune,
        protection:
          protectionTune,
        recursion:
          recursionTune,
        synergy:
          synergyTune,
        curve:
          curveTune,
        commanderSynergy:
          commanderSynergyTune,
        aggression:
          aggressionTune
      }),
      [
        strategy,
        landsTune,
        rampTune,
        drawTune,
        interactionTune,
        boardwipeTune,
        protectionTune,
        recursionTune,
        synergyTune,
        curveTune,
        commanderSynergyTune,
        aggressionTune
      ]
    );

  const profile =
    useMemo(
      () =>
        deckProfileFor(
          format,
          target,
          tuning
        ),
      [
        format,
        target,
        tuning
      ]
    );

  const lockedIds =
    useMemo(
      () =>
        new Set(
          lockedCards.map(
            card =>
              card.id
          )
        ),
      [lockedCards]
    );

  const excludedIds =
    useMemo(
      () =>
        new Set(
          excludedCardIds
        ),
      [excludedCardIds]
    );

  useEffect(() => {
    if (
      secondCommanderId &&
      !secondCommanderOptions.some(
        card =>
          card.id ===
          secondCommanderId
      )
    ) {
      setSecondCommanderId(
        ""
      );
    }
  }, [
    secondCommanderId,
    secondCommanderOptions
  ]);

  const resetDeckSelection =
    () => {
      setResult(null);
      setAnalysisText("");
      setLockedCards([]);
      setExcludedCardIds([]);
    };

  const changeFormat =
    (next: Format) => {
      setFormat(next);
      resetDeckSelection();

      if (
        next ===
        "standard"
      ) {
        setCommanderId("");
        setSecondCommanderId(
          ""
        );
      }
    };

  const chooseCommander =
    (id: string) => {
      setCommanderId(id);
      setSecondCommanderId(
        ""
      );
      resetDeckSelection();
    };

  const chooseSecondCommander =
    (id: string) => {
      setSecondCommanderId(
        id
      );
      resetDeckSelection();
    };

  const toggleStandardColor =
    (color: string) => {
      setColors(current =>
        current.includes(color)
          ? current.filter(
              value =>
                value !==
                color
            )
          : [
              ...current,
              color
            ]
      );

      resetDeckSelection();
    };

  const build = () => {
    const deck =
      buildDeck(pool, {
        name,
        format,
        colors:
          activeColors,
        commanders:
          format ===
          "commander"
            ? selectedCommanders
            : undefined,
        targetManaValue:
          target,
        minManaValue:
          min,
        maxManaValue:
          max,
        tuning,
        lockedCards,
        excludedCardIds
      });

    setResult(deck);
    setAnalysisText("");
  };

  const toggleLocked =
    (
      card:
        DeckRecord["cards"][number]
    ) => {
      setExcludedCardIds(
        current =>
          current.filter(
            id =>
              id !==
              card.id
          )
      );

      setLockedCards(
        current =>
          current.some(
            item =>
              item.id ===
              card.id
          )
            ? current.filter(
                item =>
                  item.id !==
                  card.id
              )
            : [
                ...current,
                {
                  id: card.id,
                  count:
                    card.count
                }
              ]
      );
    };

  const toggleExcluded =
    (
      card:
        DeckRecord["cards"][number]
    ) => {
      setLockedCards(
        current =>
          current.filter(
            item =>
              item.id !==
              card.id
          )
      );

      setExcludedCardIds(
        current =>
          current.includes(
            card.id
          )
            ? current.filter(
                id =>
                  id !==
                  card.id
              )
            : [
                ...current,
                card.id
              ]
      );
    };

  const explain =
    async () => {
      if (
        !result ||
        result.cards.length ===
          0
      ) {
        return;
      }

      setAiBusy(true);
      setAnalysisText("");

      try {
        const text =
          await generateAiDeckExplanation(
            result
          );

        setAnalysisText(
          text
        );
      } catch (error) {
        console.error(
          "KI-Analyse fehlgeschlagen:",
          error
        );

        const fallback =
          generateDeckExplanation(
            result
          );

        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unbekannter Fehler bei der KI-Analyse.";

        setAnalysisText(
          fallback +
          "\n\n---\n\n" +
          "### ⚠️ Generative KI nicht verfügbar\n\n" +
          errorMessage +
          "\n\nDie lokale Deckanalyse wird deshalb als Fallback angezeigt."
        );
      } finally {
        setAiBusy(false);
      }
    };

  const resultHasCards =
    (
      result?.cards.reduce(
        (
          sum,
          card
        ) =>
          sum +
          card.count,
        0
      ) ??
      0
    ) > 0;

  const builderDisabled =
    pool.length === 0 ||
    (
      format ===
      "commander"
        ? selectedCommanders.length ===
          0
        : colors.length ===
          0
    ) ||
    min > max;

  return (
    <section>
      <style>{`
        .builder-controls h3 {
          margin-top: 0;
        }

        .label-with-help {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          flex-wrap: wrap;
        }

        .help-dot {
          display: inline-grid;
          place-items: center;
          width: 18px;
          height: 18px;
          flex: 0 0 18px;
          border: 1px solid rgba(85, 215, 229, 0.42);
          border-radius: 50%;
          background: rgba(85, 215, 229, 0.08);
          color: #55d7e5;
          font-size: 12px;
          font-weight: 800;
          line-height: 1;
          cursor: help;
          user-select: none;
        }

        .help-dot:hover,
        .help-dot:focus {
          border-color: rgba(214, 173, 88, 0.7);
          color: var(--gold-bright);
          outline: none;
          box-shadow: 0 0 0 3px rgba(214, 173, 88, 0.08);
        }

        .tuning-section {
          margin: 20px 0;
          padding: 16px;
          border: 1px solid rgba(214, 173, 88, 0.18);
          border-radius: 12px;
          background: rgba(6, 13, 24, 0.48);
        }

        .tuning-heading h3 {
          margin: 0 0 5px;
        }

        .tuning-heading p {
          margin: 0 0 15px;
          font-size: 12px;
        }

        .tuning-control {
          padding: 11px 0;
          border-top: 1px solid rgba(113, 138, 167, 0.12);
        }

        .tuning-control:first-of-type {
          border-top: 0;
        }

        .tuning-control-head {
          display: grid;
          grid-template-columns: auto 18px 1fr;
          align-items: center;
          gap: 7px;
          margin-bottom: 5px;
          color: var(--text-soft);
        }

        .tuning-control-head strong {
          justify-self: end;
          color: var(--gold-bright);
          font-size: 12px;
          font-weight: 700;
        }

        .tuning-control input[type="range"] {
          width: 100%;
          margin: 4px 0 2px;
        }

        .tuning-scale {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          color: var(--muted);
          font-size: 10px;
        }

        .profile-preview {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 14px;
          padding-top: 13px;
          border-top: 1px solid rgba(214, 173, 88, 0.18);
        }

        .profile-preview strong {
          width: 100%;
          margin-bottom: 2px;
          color: var(--gold-bright);
          font-size: 12px;
        }

        .profile-preview span,
        .selection-status span {
          padding: 5px 8px;
          border: 1px solid rgba(85, 215, 229, 0.16);
          border-radius: 999px;
          background: rgba(85, 215, 229, 0.05);
          color: #c8d9e5;
          font-size: 11px;
        }

        .selection-status {
          display: flex;
          flex-wrap: wrap;
          gap: 7px;
          margin-top: 10px;
        }

        .result-heading {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 10px;
        }

        .result-heading h3 {
          margin: 0 0 5px;
        }

        .result-heading p {
          margin: 0;
          max-width: 700px;
          font-size: 12px;
        }

        .optimizable-deck-list .deck-list-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 12px;
          align-items: center;
        }

        .optimizable-deck-list .deck-list-row.locked {
          border-color: rgba(214, 173, 88, 0.34);
          background: rgba(214, 173, 88, 0.055);
        }

        .optimizable-deck-list .deck-list-row.excluded {
          border-color: rgba(239, 99, 99, 0.28);
          background: rgba(239, 99, 99, 0.045);
        }

          .collection-stats-toggle{
          cursor:pointer;
          font-size:1.1rem;
          font-weight:700;
          margin-bottom:18px;
          user-select:none;
        }
        
        .collection-stats:not([open]) .collection-stats-toggle{
          margin-bottom:0;
        }
        
        .collection-stats-toggle::marker{
          color:var(--gold-bright);
        }

        .deck-list-info {
          min-width: 0;
        }

        .deck-list-info > span,
        .deck-list-info > small {
          display: block;
        }

        .deck-card-actions {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 6px;
        }

        .deck-card-actions button {
          padding: 6px 8px;
          font-size: 11px;
          white-space: nowrap;
        }

        .deck-card-actions .active-action {
          border-color: rgba(214, 173, 88, 0.4);
        }

        .card-state {
          margin-top: 4px;
          font-size: 10px;
        }

        .locked-state {
          color: var(--gold-bright) !important;
        }

        .excluded-state {
          color: #f2a7a7 !important;
        }

        @media (max-width: 850px) {
          .result-heading {
            flex-direction: column;
          }

          .optimizable-deck-list .deck-list-row {
            grid-template-columns: 1fr;
          }

          .deck-card-actions {
            justify-content: flex-start;
          }
        }
      `}</style>

      <div className="pagehead">
        <div>
          <h2>
            Deck automatisch bauen
          </h2>

          <p className="muted">
            Der Optimierer baut das Deck direkt aus deiner Sammlung und berücksichtigt Strategie, Rollen, Mana-Kurve und Commander-Synergien bereits bei der Auswahl.
          </p>
        </div>
      </div>

      <div className="builder-grid">
        <div className="panel builder-controls">
          <h3>
            Grundaufbau
          </h3>

          <label>
            Name

            <input
              value={name}
              onChange={e =>
                setName(
                  e.target.value
                )
              }
            />
          </label>

          <label>
            Format

            <select
              value={format}
              onChange={e =>
                changeFormat(
                  e.target
                    .value as Format
                )
              }
            >
              <option value="commander">
                Commander
              </option>

              <option value="standard">
                Standard
              </option>
            </select>
          </label>

          {format ===
          "standard"
            ? (
              <label>
                Deckfarben

                <div className="color-pills">
                  {COLORS.map(
                    color => (
                      <button
                        key={
                          color
                        }
                        type="button"
                        className={
                          colors.includes(
                            color
                          )
                            ? "color active"
                            : "color"
                        }
                        onClick={() =>
                          toggleStandardColor(
                            color
                          )
                        }
                      >
                        {color}

                        <span>
                          {
                            COLOR_NAMES[
                              color
                            ]
                          }
                        </span>
                      </button>
                    )
                  )}
                </div>

                <small className="muted">
                  Die Farbauswahl ist hier ein Filter für den automatischen Builder. Sie ist keine zusätzliche Standard-Legalitätsregel.
                </small>
              </label>
            )
            : (
              <>
                <label>
                  Commander

                  <select
                    value={
                      commanderId
                    }
                    onChange={e =>
                      chooseCommander(
                        e.target
                          .value
                      )
                    }
                  >
                    <option value="">
                      — Commander wählen —
                    </option>

                    {commanders.map(
                      card => (
                        <option
                          key={
                            card.id
                          }
                          value={
                            card.id
                          }
                        >
                          {
                            card.name
                          }
                        </option>
                      )
                    )}
                  </select>
                </label>

                {primaryCommander &&
                  secondCommanderOptions.length >
                    0 && (
                    <label>
                      Zweiter Commander (optional)

                      <select
                        value={
                          secondCommanderId
                        }
                        onChange={e =>
                          chooseSecondCommander(
                            e.target
                              .value
                          )
                        }
                      >
                        <option value="">
                          — kein zweiter Commander —
                        </option>

                        {secondCommanderOptions.map(
                          card => (
                            <option
                              key={
                                card.id
                              }
                              value={
                                card.id
                              }
                            >
                              {
                                card.name
                              }
                            </option>
                          )
                        )}
                      </select>

                      <small className="muted">
                        Unterstützt werden Partner, Partner with, Friends forever, Doctor&apos;s Companion und Background.
                      </small>
                    </label>
                  )}

                {primaryCommander && (
                  <div className="ai-box">
                    <strong>
                      Farbidentität automatisch:
                    </strong>{" "}

                    {activeColors.length
                      ? activeColors
                          .map(
                            color =>
                              COLOR_NAMES[
                                color
                              ] ??
                              color
                          )
                          .join(
                            ", "
                          )
                      : "Farblos"}

                    {secondCommander && (
                      <>
                        <br />

                        <span>
                          Zwei Commander:{" "}
                          {
                            primaryCommander.name
                          }{" "}
                          +{" "}
                          {
                            secondCommander.name
                          }
                        </span>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

          <label>
            <span className="label-with-help">
              Strategie

              <HelpDot text="Bestimmt die grundsätzliche Gewichtung des Builders. Ausgewogen verteilt Rollen breit; Aggressiv priorisiert frühe Bedrohungen; Kontrolle priorisiert Antworten; Value priorisiert Kartenvorteil und Wiederverwendung; Synergie priorisiert zusammenwirkende Karten; Creature- bzw. Spell-Fokus bevorzugen die jeweilige Kartenart." />
            </span>

            <select
              value={strategy}
              onChange={e =>
                setStrategy(
                  e.target
                    .value as DeckStrategy
                )
              }
            >
              <option value="balanced">
                Ausgewogen
              </option>

              <option value="aggressive">
                Aggressiv
              </option>

              <option value="control">
                Kontrolle
              </option>

              <option value="value">
                Value
              </option>

              <option value="synergy">
                Synergie
              </option>

              <option value="creatures">
                Creature-Fokus
              </option>

              <option value="spells">
                Spell-Fokus
              </option>
            </select>
          </label>

          <label>
            <span className="label-with-help">
              Ziel-Mana Value:{" "}
              <strong>
                {target.toFixed(1)}
              </strong>

              <HelpDot text="Der Ziel-Mana-Value ist der Mittelpunkt, um den der Builder die Kosten der Nichtland-Karten bevorzugt verteilt. Er ist kein hartes Maximum; Minimum und Maximum darunter bleiben die harten Grenzen." />
            </span>

            <input
              type="range"
              min="0"
              max="15"
              step="0.1"
              value={target}
              onChange={e =>
                setTarget(
                  Number(
                    e.target.value
                  )
                )
              }
            />
          </label>

          <label>
            <span className="label-with-help">
              Minimum Mana Value:{" "}
              <strong>
                {min.toFixed(1)}
              </strong>

              <HelpDot text="Harte Untergrenze für Nichtland-Karten, die der automatische Builder verwenden darf. Länder sind davon nicht betroffen." />
            </span>

            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={min}
              onChange={e =>
                setMin(
                  Number(
                    e.target.value
                  )
                )
              }
            />
          </label>

          <label>
            <span className="label-with-help">
              Maximum Mana Value:{" "}
              <strong>
                {max.toFixed(1)}
              </strong>

              <HelpDot text="Harte Obergrenze für Nichtland-Karten, die der automatische Builder verwenden darf. Damit kannst du sehr teure Karten bewusst aus dem automatischen Vorschlag heraushalten." />
            </span>

            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={max}
              onChange={e =>
                setMax(
                  Number(
                    e.target.value
                  )
                )
              }
            />
          </label>

          {min > max && (
            <div className="error">
              Minimum Mana Value darf nicht größer als Maximum Mana Value sein.
            </div>
          )}

          <div className="tuning-section">
            <div className="tuning-heading">
              <div>
                <h3>
                  Deck feinabstimmen
                </h3>

                <p className="muted">
                  Diese Einstellungen können auch nach dem ersten Zusammenbau geändert werden. Danach einfach neu optimieren.
                </p>
              </div>
            </div>

            <TuningSlider
              label="Länder"
              value={landsTune}
              onChange={setLandsTune}
              help="Verschiebt die Zielzahl der Länder. Mehr Länder erhöhen die Wahrscheinlichkeit, Landdrops zu treffen; weniger Länder schaffen mehr Platz für Nichtland-Karten, erhöhen aber das Risiko von Mana-Problemen."
            />

            <TuningSlider
              label="Ramp"
              value={rampTune}
              onChange={setRampTune}
              help="Bestimmt, wie stark der Builder Mana-Beschleunigung priorisiert. Mehr Ramp hilft besonders bei höheren Mana-Kurven und teuren Commandern."
            />

            <TuningSlider
              label="Card Draw"
              value={drawTune}
              onChange={setDrawTune}
              help="Bestimmt die Zielmenge an Kartennachschub und Kartenvorteil. Mehr Card Draw verbessert die Chance, auch in längeren Spielen ausreichend Optionen zu haben."
            />

            <TuningSlider
              label="Interaktion"
              value={
                interactionTune
              }
              onChange={
                setInteractionTune
              }
              help="Bestimmt die Zielmenge direkter Antworten wie Removal, Counter oder andere Interaktion mit gegnerischen Karten."
            />

            <TuningSlider
              label="Boardwipes"
              value={
                boardwipeTune
              }
              onChange={
                setBoardwipeTune
              }
              help="Bestimmt, wie stark der Builder breite Antworten priorisiert, die mehrere oder alle Kreaturen beziehungsweise Permanents betreffen."
            />

            <TuningSlider
              label="Schutz"
              value={
                protectionTune
              }
              onChange={
                setProtectionTune
              }
              help="Bestimmt die Zielmenge an Karten, die wichtige Permanents, Kreaturen oder die eigene Strategie schützen können."
            />

            <TuningSlider
              label="Recursion"
              value={
                recursionTune
              }
              onChange={
                setRecursionTune
              }
              help="Bestimmt, wie stark Karten priorisiert werden, die Ressourcen aus dem Friedhof wieder nutzbar machen."
            />

            <TuningSlider
              label="Synergie"
              value={
                synergyTune
              }
              onChange={
                setSynergyTune
              }
              help="Bestimmt, wie stark zusammenwirkende Karten und erkannte Deck- beziehungsweise Commander-Themen gegenüber allgemein starken Einzelkarten gewichtet werden."
            />

            <TuningSlider
              label="Mana-Kurve"
              value={
                curveTune
              }
              onChange={
                setCurveTune
              }
              help="Verschiebt den bevorzugten Kostenbereich des Decks relativ zum Ziel-Mana-Value. Niedriger bevorzugt günstigere Karten, höher erlaubt mehr teure Karten."
              lowLabel="Niedriger"
              highLabel="Höher"
            />

            {format ===
              "commander" && (
              <TuningSlider
                label="Commander-Synergie"
                value={
                  commanderSynergyTune
                }
                onChange={
                  setCommanderSynergyTune
                }
                help="Steuert, wie stark der Builder Karten bevorzugt, deren erkennbare Themen mit dem Oracle-Text des Commanders beziehungsweise der Commander zusammenpassen."
                lowLabel="Locker"
                highLabel="Stärker"
              />
            )}

            <TuningSlider
              label="Spielstil"
              value={
                aggressionTune
              }
              onChange={
                setAggressionTune
              }
              help="Verschiebt die Auswahl zwischen defensiverem, reaktivem Spiel und aggressiverem Druck. Dieser Regler ergänzt die gewählte Grundstrategie, ersetzt sie aber nicht."
              lowLabel="Defensiver"
              highLabel="Aggressiver"
            />

            <div className="profile-preview">
              <strong>
                Aktuelle Zielwerte
              </strong>

              <span>
                Länder{" "}
                {profile.lands}
              </span>

              <span>
                Ramp{" "}
                {profile.ramp}
              </span>

              <span>
                Draw{" "}
                {profile.draw}
              </span>

              <span>
                Interaktion{" "}
                {profile.interaction}
              </span>

              <span>
                Boardwipes{" "}
                {profile.boardwipes}
              </span>

              <span>
                Schutz{" "}
                {profile.protection}
              </span>

              <span>
                Recursion{" "}
                {profile.recursion}
              </span>

              <span>
                Synergie{" "}
                {profile.synergy}
              </span>

              <span>
                Ziel-MV{" "}
                {profile.targetManaValue.toFixed(
                  1
                )}
              </span>
            </div>
          </div>

          <button
            className="primary full"
            onClick={build}
            disabled={
              builderDisabled
            }
          >
            {result
              ? "Deck neu optimieren"
              : "Deck erstellen"}
          </button>

          {result &&
            (
              lockedCards.length >
                0 ||
              excludedCardIds.length >
                0
            ) && (
              <div className="selection-status">
                <span>
                  🔒 Fixiert:{" "}
                  {
                    lockedCards.length
                  }
                </span>

                <span>
                  🚫 Ausgeschlossen:{" "}
                  {
                    excludedCardIds.length
                  }
                </span>
              </div>
            )}

          {pool.length === 0 && (
            <div className="notice">
              Deine Sammlung ist leer. Füge zuerst Karten über die Kartensuche hinzu.
            </div>
          )}

          {format ===
            "commander" &&
            pool.length > 0 &&
            commanders.length ===
              0 && (
              <div className="notice">
                In deiner Sammlung wurde aktuell kein Commander-Kandidat gefunden.
              </div>
            )}

          {format ===
            "commander" &&
            commanders.length >
              0 &&
            !primaryCommander && (
              <div className="notice">
                Wähle zuerst einen Commander. Seine Farbidentität wird automatisch für den Deckbau verwendet.
              </div>
            )}
        </div>

        {result
          ? (
            <div className="panel">
              <div className="result-heading">
                <div>
                  <h3>
                    {result.name}
                  </h3>

                  <p className="muted">
                    Passe links die Regler an, fixiere gewünschte Karten oder schließe Karten aus und klicke anschließend auf „Deck neu optimieren“.
                  </p>
                </div>

                <button
                  className="secondary"
                  onClick={build}
                  disabled={
                    builderDisabled
                  }
                >
                  Deck neu optimieren
                </button>
              </div>

              <div className="stats">
                <div>
                  <strong>
                    {
                      deckStats(
                        result
                      ).total
                    }
                  </strong>

                  <span>
                    Karten gesamt
                  </span>
                </div>

                <div>
                  <strong>
                    {
                      deckStats(
                        result
                      ).lands
                    }
                  </strong>

                  <span>
                    Länder
                  </span>
                </div>

                <div>
                  <strong>
                    {
                      deckStats(
                        result
                      ).nonland
                    }
                  </strong>

                  <span>
                    Nichtländer
                  </span>
                </div>

                <div>
                  <strong>
                    {
                      deckStats(
                        result
                      ).averageManaValue
                    }
                  </strong>

                  <span>
                    Ø Mana Value
                  </span>
                </div>
              </div>

              <p>
                {result.notes}
              </p>

              {result.format ===
                "commander" &&
                result.commanderIds.length >
                  0 && (
                  <div className="commander-card">
                    <strong>
                      Commander
                    </strong>

                    {result.commanderIds.map(
                      id => {
                        const commander =
                          pool.find(
                            card =>
                              card.id ===
                              id
                          );

                        return commander
                          ? (
                            <span
                              key={
                                id
                              }
                            >
                              {
                                commander.name
                              }
                            </span>
                          )
                          : null;
                      }
                    )}
                  </div>
                )}

              <div className="role-list">
                {Object.entries(
                  deckStats(
                    result
                  ).roleCounts
                ).map(
                  ([
                    role,
                    count
                  ]) => (
                    <span
                      key={
                        role
                      }
                    >
                      {role}:{" "}
                      {count}
                    </span>
                  )
                )}
              </div>

              <div className="deck-list optimizable-deck-list">
                {result.cards.map(
                  card => {
                    const locked =
                      lockedIds.has(
                        card.id
                      );

                    const excluded =
                      excludedIds.has(
                        card.id
                      );

                    return (
                      <div
                        key={
                          card.id
                        }
                        className={
                          excluded
                            ? "deck-list-row excluded"
                            : locked
                              ? "deck-list-row locked"
                              : "deck-list-row"
                        }
                      >
                        <div className="deck-list-info">
                          <span>
                            <b>
                              {
                                card.count
                              }
                              ×
                            </b>{" "}
                            {
                              card.name
                            }
                          </span>

                          <small>
                            {
                              card.role
                            }
                            {" · "}
                            {
                              card.reason
                            }
                          </small>

                          {locked && (
                            <small className="card-state locked-state">
                              🔒 Wird bei der nächsten Optimierung beibehalten.
                            </small>
                          )}

                          {excluded && (
                            <small className="card-state excluded-state">
                              🚫 Wird bei der nächsten Optimierung nicht mehr verwendet.
                            </small>
                          )}
                        </div>

                        <div className="deck-card-actions">
                          <button
                            type="button"
                            className={
                              locked
                                ? "secondary active-action"
                                : "ghost"
                            }
                            onClick={() =>
                              toggleLocked(
                                card
                              )
                            }
                            title="Diese Karte beim erneuten Optimieren im Deck behalten."
                          >
                            {locked
                              ? "🔓 Freigeben"
                              : "🔒 Behalten"}
                          </button>

                          <button
                            type="button"
                            className={
                              excluded
                                ? "danger active-action"
                                : "ghost"
                            }
                            onClick={() =>
                              toggleExcluded(
                                card
                              )
                            }
                            title="Diese Karte beim erneuten Optimieren nicht verwenden."
                          >
                            {excluded
                              ? "↩ Wieder zulassen"
                              : "🚫 Ausschließen"}
                          </button>
                        </div>
                      </div>
                    );
                  }
                )}
              </div>

              {!resultHasCards && (
                <div className="notice">
                  Es wurden keine passenden Karten für das Hauptdeck gefunden. Speichern, Export und Analyse sind deshalb deaktiviert.
                </div>
              )}

              <div className="row">
                <button
                  className="primary"
                  onClick={() =>
                    onSave(result)
                  }
                  disabled={
                    !resultHasCards
                  }
                >
                  Deck speichern
                </button>

                <button
                  className="secondary"
                  onClick={() =>
                    download(
                      `${result.name}.txt`,
                      deckText(
                        result,
                        pool
                      )
                    )
                  }
                  disabled={
                    !resultHasCards
                  }
                >
                  Export
                </button>

                <button
                  className="secondary"
                  onClick={explain}
                  disabled={
                    aiBusy ||
                    demoMode ||
                    !resultHasCards
                  }
                  title={
                    demoMode
                      ? "Die generative KI benötigt eine Firebase-Anmeldung."
                      : !resultHasCards
                        ? "Für ein leeres Deck ist keine Analyse sinnvoll."
                        : undefined
                  }
                >
                  {aiBusy
                    ? "KI analysiert…"
                    : "Deck analysieren"}
                </button>
              </div>

              {analysisText && (
                <div className="ai-box analysis-box markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[
                      remarkGfm
                    ]}
                  >
                    {analysisText}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )
          : (
            <div className="panel empty">
              <h3>
                Vorschau
              </h3>

              <p>
                Hier erscheinen Deckgröße, Mana-Kurve, Rollen und Auswahlbegründungen.
              </p>

              <p className="muted">
                Nach dem ersten Vorschlag kannst du die Feinabstimmung ändern, einzelne Karten fixieren oder ausschließen und das Deck erneut optimieren.
              </p>
            </div>
          )}
      </div>
    </section>
  );
}

function Decks({
  decks,
  pool,
  onDelete,
  onSave,
  demoMode
}: {
  decks: DeckRecord[];
  pool: CardRecord[];
  onDelete: (
    id: string
  ) => Promise<void>;
  onSave: (
    d: DeckRecord
  ) => Promise<void>;
  demoMode: boolean;
}) {
  const [
    editing,
    setEditing
  ] =
    useState<
      DeckRecord |
      null
    >(null);

  const [
    importText,
    setImportText
  ] =
    useState("");

  const [
    showImport,
    setShowImport
  ] =
    useState(false);

  const [
    importBusy,
    setImportBusy
  ] =
    useState(false);

  const [
    importPreview,
    setImportPreview
  ] =
    useState<{
      deck: DeckRecord;
      requestedCards: number;
      importedCards: number;
      issues: string[];
      formatDetectedBy: string;
    } | null>(null);

  const [
    showBulkDeck,
    setShowBulkDeck
  ] =
    useState(false);

  const [
    bulkDeckName,
    setBulkDeckName
  ] =
    useState("Bulk-Deck");

  const [
    bulkDeckFormat,
    setBulkDeckFormat
  ] =
    useState<Format>(
      "standard"
    );

  const [
    bulkDeckGroups,
    setBulkDeckGroups
  ] =
    useState<
      Array<{
        id: string;
        setCode: string;
        numbers: string;
      }>
    >(() => [
      {
        id: crypto.randomUUID(),
        setCode: "",
        numbers: ""
      }
    ]);

  const [
    bulkDeckCommanderId,
    setBulkDeckCommanderId
  ] =
    useState("");

  const [
    bulkDeckSets,
    setBulkDeckSets
  ] =
    useState<ScryfallSet[]>([]);

  const [
    bulkDeckSetsBusy,
    setBulkDeckSetsBusy
  ] =
    useState(false);

  const [
    bulkDeckBusy,
    setBulkDeckBusy
  ] =
    useState(false);

  const [
    bulkDeckPreview,
    setBulkDeckPreview
  ] =
    useState<{
      deck: DeckRecord;
      rows: Array<{
        setCode: string;
        collectorNumber: string;
        count: number;
        name?: string;
        errors: string[];
      }>;
      requestedCards: number;
      resolvedCards: number;
      errors: string[];
      warnings: string[];
    } | null>(null);

  const bulkCommanderOptions =
    useMemo(
      () =>
        commanderCandidates(
          pool
        ),
      [pool]
    );

  const newManualDeck =
    () => {
      const now =
        Date.now();

      const deck:
        DeckRecord = {
          id:
            crypto.randomUUID(),
          name:
            "Neues manuelles Deck",
          format:
            "standard",
          commanderIds: [],
          cards: [],
          sideboard: [],
          colors: [],
          createdAt: now,
          updatedAt: now,
          notes:
            "Manuell zusammengestelltes Deck."
        };

      setEditing(deck);
    };

  const resetDeckImport =
    () => {
      setImportText("");
      setImportPreview(null);
    };

  const closeDeckImport =
    () => {
      resetDeckImport();
      setShowImport(false);
    };

  const resetBulkDeck = () => {
    setBulkDeckGroups([
      {
        id: crypto.randomUUID(),
        setCode: "",
        numbers: ""
      }
    ]);
    setBulkDeckPreview(null);
  };

  const closeBulkDeck = () => {
    resetBulkDeck();
    setShowBulkDeck(false);
  };

  const ensureBulkDeckSets =
    async () => {
      if (
        bulkDeckSets.length > 0 ||
        bulkDeckSetsBusy
      ) {
        return;
      }

      setBulkDeckSetsBusy(true);

      try {
        setBulkDeckSets(
          await getSets()
        );
      } catch (error) {
        console.error(
          "Scryfall-Sets konnten nicht geladen werden:",
          error
        );

        alert(
          "Die Set-Liste konnte nicht von Scryfall geladen werden."
        );
      } finally {
        setBulkDeckSetsBusy(false);
      }
    };

  const toggleBulkDeck = () => {
    const next =
      !showBulkDeck;

    if (next) {
      closeDeckImport();
      void ensureBulkDeckSets();
    }

    setShowBulkDeck(next);
  };

  const previewBulkDeck =
    async () => {
      const groups =
        bulkDeckGroups
          .map(group => ({
            ...group,
            numbers:
              parseCollectorNumbers(
                group.numbers
              )
          }))
          .filter(
            group =>
              group.setCode &&
              group.numbers.length > 0
          );

      if (groups.length === 0) {
        return;
      }

      setBulkDeckBusy(true);
      setBulkDeckPreview(null);

      try {
        const commander =
          bulkDeckFormat ===
            "commander"
            ? pool.find(
                card =>
                  card.id ===
                  bulkDeckCommanderId
              )
            : undefined;

        const commanderColors =
          commander
            ? commanderColorIdentity([
                commander
              ])
            : [];

        const rows:
          Array<{
            setCode: string;
            collectorNumber: string;
            count: number;
            name?: string;
            errors: string[];
          }> = [];

        const errors: string[] = [];
        const warnings: string[] = [];
        const mainCards:
          DeckRecord["cards"] = [];
        let resolvedCards = 0;

        const pushError =
          (message: string) => {
            if (!errors.includes(message)) {
              errors.push(message);
            }
          };

        if (
          bulkDeckFormat ===
            "commander" &&
          !commander
        ) {
          pushError(
            "Für ein Commander-Deck muss zuerst ein Commander aus deiner Sammlung gewählt werden."
          );
        }

        for (const group of groups) {
          const counts =
            collectorNumberCounts(
              group.numbers
            );

          const lookup =
            await getCardsBySetAndCollectorNumbers(
              group.setCode,
              Array.from(
                counts.keys()
              )
            );

          const byCollectorNumber =
            new Map(
              lookup.cards.map(
                card => [
                  card.collector_number
                    .toLowerCase(),
                  card
                ] as const
              )
            );

          for (
            const [
              collectorNumber,
              count
            ] of counts
          ) {
            const rowErrors: string[] = [];
            const scryfallCard =
              byCollectorNumber.get(
                collectorNumber
              );

            if (!scryfallCard) {
              const message =
                `${group.setCode.toUpperCase()} #${collectorNumber}: in diesem Set nicht gefunden.`;
              rowErrors.push(message);
              pushError(message);
              rows.push({
                setCode: group.setCode,
                collectorNumber,
                count,
                errors: rowErrors
              });
              continue;
            }

            const source =
              pool.find(
                card =>
                  card.id ===
                    scryfallCard.id ||
                  (
                    card.oracleId ===
                      scryfallCard.oracle_id &&
                    card.set.toLowerCase() ===
                      scryfallCard.set.toLowerCase() &&
                    card.collectorNumber.toLowerCase() ===
                      scryfallCard.collector_number.toLowerCase()
                  )
              );

            if (!source) {
              const message =
                `${group.setCode.toUpperCase()} #${scryfallCard.collector_number} ${scryfallCard.name}: diese Ausgabe ist nicht in deiner Sammlung vorhanden.`;
              rowErrors.push(message);
              pushError(message);
              rows.push({
                setCode: group.setCode,
                collectorNumber:
                  scryfallCard.collector_number,
                count,
                name: scryfallCard.name,
                errors: rowErrors
              });
              continue;
            }

            if (
              commander &&
              source.name.toLowerCase() ===
                commander.name.toLowerCase()
            ) {
              const message =
                `${source.name}: der gewählte Commander darf nicht zusätzlich im Hauptdeck stehen.`;
              rowErrors.push(message);
              pushError(message);
            }

            const legal =
              bulkDeckFormat ===
                "standard"
                ? cardLegalForDeck(
                    source,
                    "standard"
                  )
                : commander
                  ? cardLegalForDeck(
                      source,
                      "commander",
                      commanderColors
                    )
                  : true;

            if (!legal) {
              const message =
                bulkDeckFormat ===
                  "commander"
                  ? `${source.name}: im Commander-Format bzw. mit der Farbidentität des Commanders nicht erlaubt.`
                  : `${source.name}: im Standard-Format nicht erlaubt.`;
              rowErrors.push(message);
              pushError(message);
            }

            const existing =
              mainCards.find(
                card =>
                  card.id === source.id
              );

            if (existing) {
              existing.count += count;
            } else {
              mainCards.push({
                id: source.id,
                name: source.name,
                count,
                manaValue:
                  source.manaValue,
                typeLine:
                  source.typeLine,
                role: "Bulk",
                reason:
                  "Per Set und Collector Number hinzugefügt.",
                available:
                  source.count
              });
            }

            resolvedCards += count;
            rows.push({
              setCode: group.setCode,
              collectorNumber:
                scryfallCard.collector_number,
              count,
              name: source.name,
              errors: rowErrors
            });
          }
        }

        const totalByName =
          mainCards.reduce<
            Record<string, number>
          >(
            (result, card) => {
              const key =
                card.name.toLowerCase();
              result[key] =
                (result[key] ?? 0) +
                card.count;
              return result;
            },
            {}
          );

        for (const card of mainCards) {
          const source =
            pool.find(
              item =>
                item.id === card.id
            );

          if (!source) {
            continue;
          }

          const totalForName =
            totalByName[
              card.name.toLowerCase()
            ] ?? 0;
          const ruleLimit =
            deckCopyLimit(
              source,
              bulkDeckFormat
            );

          if (totalForName > ruleLimit) {
            const limitLabel =
              Number.isFinite(ruleLimit)
                ? String(ruleLimit)
                : "beliebig";
            pushError(
              `${card.name}: insgesamt ${totalForName} Exemplare eingegeben, erlaubt sind höchstens ${limitLabel}.`
            );
          }

          if (card.count > source.count) {
            pushError(
              `${card.name}: ${card.count} Exemplare dieser Ausgabe eingegeben, aber nur ${source.count} in deiner Sammlung vorhanden.`
            );
          }
        }

        const requestedMain =
          groups.reduce(
            (sum, group) =>
              sum + group.numbers.length,
            0
          );

        const requestedTotal =
          requestedMain +
          (
            bulkDeckFormat ===
              "commander" &&
            commander
              ? 1
              : 0
          );

        const targetSize =
          bulkDeckFormat ===
            "commander"
            ? 100
            : 60;

        if (requestedTotal > targetSize) {
          pushError(
            bulkDeckFormat ===
              "commander"
              ? `Das Commander-Deck hätte ${requestedTotal} Karten inklusive Commander. Erlaubt sind genau 100.`
              : `Das Standard-Deck hätte ${requestedTotal} Karten. Für den Bulk-Import sind maximal 60 Karten vorgesehen.`
          );
        } else if (requestedTotal < targetSize) {
          warnings.push(
            bulkDeckFormat ===
              "commander"
              ? `Das Deck ist noch unvollständig: ${targetSize - requestedTotal} Karten fehlen bis 100 inklusive Commander.`
              : `Das Deck ist noch unvollständig: ${targetSize - requestedTotal} Karten fehlen bis 60.`
          );
        }

        const colors =
          bulkDeckFormat ===
            "commander"
            ? commanderColors
            : Array.from(
                new Set(
                  mainCards.flatMap(
                    deckCard =>
                      pool.find(
                        card =>
                          card.id ===
                          deckCard.id
                      )?.colorIdentity ??
                      []
                  )
                )
              );

        const now = Date.now();
        const usedSets =
          Array.from(
            new Set(
              groups.map(
                group =>
                  group.setCode.toUpperCase()
              )
            )
          );

        const deck: DeckRecord = {
          id: crypto.randomUUID(),
          name:
            bulkDeckName.trim() ||
            "Bulk-Deck",
          format: bulkDeckFormat,
          commanderIds:
            commander
              ? [commander.id]
              : [],
          cards: mainCards,
          sideboard: [],
          colors,
          createdAt: now,
          updatedAt: now,
          notes:
            `Bulk-Deck aus ${usedSets.length} Set${usedSets.length === 1 ? "" : "s"} (${usedSets.join(", ")}) über Collector Numbers erstellt.`
        };

        setBulkDeckPreview({
          deck,
          rows,
          requestedCards:
            requestedMain,
          resolvedCards,
          errors,
          warnings
        });
      } catch (error) {
        console.error(
          "Bulk-Deck konnte nicht geprüft werden:",
          error
        );
        alert(
          "Die Collector Numbers konnten nicht vollständig bei Scryfall geprüft werden."
        );
      } finally {
        setBulkDeckBusy(false);
      }
    };

  const applyBulkDeck =
    async () => {
      if (
        !bulkDeckPreview ||
        bulkDeckPreview.errors.length >
          0 ||
        bulkDeckPreview.resolvedCards ===
          0
      ) {
        return;
      }

      setBulkDeckBusy(true);

      try {
        await onSave(
          bulkDeckPreview.deck
        );

        closeBulkDeck();
      } finally {
        setBulkDeckBusy(false);
      }
    };

  const readDeckImportFile =
    async (
      file:
        | File
        | undefined
    ) => {
      if (!file) {
        return;
      }

      try {
        setImportText(
          await file.text()
        );

        setImportPreview(null);
      } catch {
        setImportPreview(null);
      }
    };

  const previewDeckImport =
    () => {
      const parsed =
        parseDeckList(
          importText
        );

      const explicitFormat =
        parsed.find(
          (
            row
          ): row is Extract<
            typeof parsed[number],
            {
              kind:
                "format";
            }
          > =>
            row.kind ===
            "format"
        );

      const cardRows =
        parsed.filter(
          (
            row
          ): row is Extract<
            typeof parsed[number],
            {
              kind:
                "card";
            }
          > =>
            row.kind ===
            "card"
        );

      if (
        cardRows.length ===
        0
      ) {
        setImportPreview(
          null
        );

        return;
      }

      const commanderRows =
        cardRows.filter(
          row =>
            row.section ===
            "commander"
        );

      const format:
        Format =
          explicitFormat
            ?.format ??
          (
            commanderRows.length >
            0
              ? "commander"
              : "standard"
          );

      const formatDetectedBy =
        explicitFormat
          ? "explizite Format-Zeile"
          : commanderRows.length >
              0
            ? "Commander-Sektion"
            : "Standard als sichere Voreinstellung";

      const issues:
        string[] = [];

      const usedById =
        new Map<
          string,
          number
        >();

      const mainCards:
        DeckRecord["cards"] =
          [];

      const sideboard:
        DeckRecord["sideboard"] =
          [];

      const commanderIds:
        string[] = [];

      const exactMatches =
        (
          name:
            string
        ) =>
          pool.filter(
            card =>
              card.name.toLowerCase() ===
              name.toLowerCase()
          );

      const partialMatches =
        (
          name:
            string
        ) => {
          const needle =
            name.toLowerCase();

          return pool.filter(
            card =>
              card.name
                .toLowerCase()
                .includes(
                  needle
                )
          );
        };

      const chooseCandidates =
        (
          row:
            Extract<
              typeof cardRows[number],
              {
                kind:
                  "card";
              }
            >
        ) => {
          let matches =
            exactMatches(
              row.name
            );

          let partial =
            false;

          if (
            matches.length ===
            0
          ) {
            matches =
              partialMatches(
                row.name
              );

            partial =
              matches.length >
              0;
          }

          if (row.set) {
            matches =
              matches.filter(
                card =>
                  card.set.toLowerCase() ===
                  row.set!.toLowerCase()
              );
          }

          if (
            row.collectorNumber
          ) {
            matches =
              matches.filter(
                card =>
                  card.collectorNumber.toLowerCase() ===
                  row.collectorNumber!.toLowerCase()
              );
          }

          return {
            matches,
            partial
          };
        };

      const addToList =
        (
          target:
            DeckRecord["cards"],
          source:
            CardRecord,
          amount:
            number,
          reason:
            string
        ) => {
          const existing =
            target.find(
              card =>
                card.id ===
                source.id
            );

          if (existing) {
            existing.count +=
              amount;

            return;
          }

          target.push({
            id:
              source.id,
            name:
              source.name,
            count:
              amount,
            manaValue:
              source.manaValue,
            typeLine:
              source.typeLine,
            role:
              "Import",
            reason,
            available:
              source.count
          });
        };

      const consumeRow =
        (
          row:
            Extract<
              typeof cardRows[number],
              {
                kind:
                  "card";
              }
            >,
          target:
            DeckRecord["cards"],
          reason:
            string
        ) => {
          const {
            matches,
            partial
          } =
            chooseCandidates(
              row
            );

          if (
            matches.length ===
            0
          ) {
            issues.push(
              `${row.count}× ${row.name}: nicht in deiner Sammlung gefunden.`
            );

            return 0;
          }

          if (partial) {
            issues.push(
              `${row.name}: kein exakter Name in der Sammlung; Teiltreffer ${matches
                .map(
                  card =>
                    `„${card.name}“`
                )
                .slice(
                  0,
                  3
                )
                .join(", ")}.`
            );
          }

          if (
            matches.length >
              1 &&
            !row.set &&
            !row.collectorNumber
          ) {
            issues.push(
              `${row.name}: ${matches.length} Ausgaben in deiner Sammlung gefunden; verfügbare Exemplare werden über die Ausgaben verteilt.`
            );
          }

          let remaining =
            row.count;

          let imported =
            0;

          for (
            const source
            of matches
          ) {
            if (
              remaining <=
              0
            ) {
              break;
            }

            const alreadyUsed =
              usedById.get(
                source.id
              ) ??
              0;

            const free =
              Math.max(
                0,
                source.count -
                alreadyUsed
              );

            const amount =
              Math.min(
                remaining,
                free
              );

            if (
              amount <=
              0
            ) {
              continue;
            }

            addToList(
              target,
              source,
              amount,
              reason
            );

            usedById.set(
              source.id,
              alreadyUsed +
              amount
            );

            remaining -=
              amount;

            imported +=
              amount;
          }

          if (
            remaining >
            0
          ) {
            issues.push(
              `${row.name}: ${row.count} angefordert, aber nur ${imported} Exemplare in deiner Sammlung verfügbar. Es fehlen ${remaining}.`
            );
          }

          return imported;
        };

      if (
        format ===
        "commander"
      ) {
        const rowsForCommander =
          commanderRows.slice(
            0,
            2
          );

        if (
          commanderRows.length >
          2
        ) {
          issues.push(
            `Die Commander-Sektion enthält ${commanderRows.length} Einträge. Arcane Decksmith übernimmt höchstens zwei Commander.`
          );
        }

        for (
          const row
          of rowsForCommander
        ) {
          const {
            matches,
            partial
          } =
            chooseCandidates(
              row
            );

          const source =
            matches[0];

          if (!source) {
            issues.push(
              `Commander „${row.name}“ wurde nicht in deiner Sammlung gefunden.`
            );

            continue;
          }

          if (partial) {
            issues.push(
              `Commander „${row.name}“ wurde nur als Teiltreffer „${source.name}“ gefunden.`
            );
          }

          const used =
            usedById.get(
              source.id
            ) ??
            0;

          if (
            source.count -
              used <
            1
          ) {
            issues.push(
              `Commander „${source.name}“ ist in der Sammlung nicht mehr als freies Exemplar verfügbar.`
            );

            continue;
          }

          commanderIds.push(
            source.id
          );

          usedById.set(
            source.id,
            used + 1
          );
        }

        if (
          commanderIds.length ===
          0
        ) {
          issues.push(
            "Commander-Format erkannt, aber kein Commander konnte aus deiner Sammlung aufgelöst werden. Bitte nach dem Import im Editor einen Commander wählen."
          );
        }

        if (
          commanderIds.length ===
          1
        ) {
          const primary =
            pool.find(
              card =>
                card.id ===
                commanderIds[0]
            );

          if (
            primary &&
            !commanderCandidates(
              pool
            ).some(
              card =>
                card.id ===
                primary.id
            )
          ) {
            issues.push(
              `„${primary.name}“ ist nach den gespeicherten Scryfall-Daten kein zulässiger Commander-Kandidat.`
            );
          }
        }

        if (
          commanderIds.length ===
          2
        ) {
          const primary =
            pool.find(
              card =>
                card.id ===
                commanderIds[0]
            );

          const second =
            pool.find(
              card =>
                card.id ===
                commanderIds[1]
            );

          if (
            primary &&
            second &&
            !commanderPairCandidates(
              pool,
              primary
            ).some(
              card =>
                card.id ===
                second.id
            )
          ) {
            issues.push(
              `Die Commander-Kombination „${primary.name}“ + „${second.name}“ wurde nicht als zulässiges Partner-/Background-/Doctor's-Companion-Paar erkannt.`
            );
          }
        }
      } else if (
        commanderRows.length >
        0
      ) {
        issues.push(
          "Die Liste enthält eine Commander-Sektion, aber das Format ist explizit Standard. Diese Karten werden deshalb dem Hauptdeck zugeordnet."
        );
      }

      const mainRows =
        cardRows.filter(
          row =>
            row.section ===
              "main" ||
            (
              format ===
                "standard" &&
              row.section ===
                "commander"
            )
        );

      const sideRows =
        cardRows.filter(
          row =>
            row.section ===
            "sideboard"
        );

      for (
        const row
        of mainRows
      ) {
        consumeRow(
          row,
          mainCards,
          "Aus Deckliste ins Hauptdeck importiert."
        );
      }

      for (
        const row
        of sideRows
      ) {
        consumeRow(
          row,
          sideboard,
          "Aus Deckliste ins Sideboard importiert."
        );
      }

      const commanders =
        commanderIds
          .map(
            id =>
              pool.find(
                card =>
                  card.id ===
                  id
              )
          )
          .filter(
            (
              card
            ): card is CardRecord =>
              Boolean(card)
          );

      const colors =
        format ===
        "commander"
          ? commanderColorIdentity(
              commanders
            )
          : Array.from(
              new Set(
                mainCards.flatMap(
                  deckCard =>
                    pool.find(
                      card =>
                        card.id ===
                        deckCard.id
                    )
                      ?.colorIdentity ??
                    []
                )
              )
            );

      const requestedCards =
        cardRows.reduce(
          (
            sum,
            row
          ) =>
            sum +
            row.count,
          0
        );

      const importedMain =
        mainCards.reduce(
          (
            sum,
            card
          ) =>
            sum +
            card.count,
          0
        );

      const importedSide =
        sideboard.reduce(
          (
            sum,
            card
          ) =>
            sum +
            card.count,
          0
        );

      const importedCards =
        importedMain +
        importedSide +
        commanderIds.length;

      const now =
        Date.now();

      const deck:
        DeckRecord = {
          id:
            crypto.randomUUID(),
          name:
            "Importiertes Deck",
          format,
          commanderIds,
          cards:
            mainCards,
          sideboard,
          colors,
          createdAt:
            now,
          updatedAt:
            now,
          notes:
            `Importierte Deckliste: ${importedCards} von ${requestedCards} angeforderten Karten aus der Sammlung aufgelöst.`
        };

      setImportPreview({
        deck,
        requestedCards,
        importedCards,
        issues,
        formatDetectedBy
      });
    };

  const applyDeckImport =
    async () => {
      if (
        !importPreview ||
        (
          importPreview.deck.cards.length ===
            0 &&
          importPreview.deck.commanderIds.length ===
            0 &&
          importPreview.deck.sideboard.length ===
            0
        )
      ) {
        return;
      }

      setImportBusy(true);

      try {
        await onSave(
          importPreview.deck
        );

        closeDeckImport();
      } finally {
        setImportBusy(false);
      }
    };

  if (editing) {
    return (
      <DeckEditor
        deck={editing}
        pool={pool}
        demoMode={demoMode}
        onBack={() =>
          setEditing(null)
        }
        onSave={async d => {
          await onSave(d);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>
            Gespeicherte Decks
          </h2>

          <p className="muted">
            {decks.length} Decks
          </p>
        </div>

        <div className="row">
          <button
            className="primary"
            onClick={
              newManualDeck
            }
          >
            + Deck manuell erstellen
          </button>

          <button
            className="secondary"
            onClick={toggleBulkDeck}
          >
            Bulk-Deck erstellen
          </button>

          <button
            className="secondary"
            onClick={() => {
              if (showImport) {
                closeDeckImport();
              } else {
                closeBulkDeck();
                setShowImport(
                  true
                );
              }
            }}
          >
            Deckliste importieren
          </button>
        </div>
      </div>

      {showBulkDeck && (
        <div className="panel">
          <h3>
            Bulk-Deck erstellen
          </h3>

          <p className="muted">
            Wähle Format und Set und gib anschließend nur die Collector Numbers ein. Doppelte Nummern zählen als mehrere Exemplare. Das Deck wird vor dem Speichern gegen deine Sammlung und die Formatregeln geprüft.
          </p>

          <div className="two">
            <label>
              Deckname

              <input
                value={bulkDeckName}
                onChange={e => {
                  setBulkDeckName(
                    e.target.value
                  );
                  setBulkDeckPreview(
                    null
                  );
                }}
                placeholder="Bulk-Deck"
              />
            </label>

            <label>
              Format

              <select
                value={bulkDeckFormat}
                onChange={e => {
                  const format =
                    e.target
                      .value as Format;

                  setBulkDeckFormat(
                    format
                  );

                  if (
                    format ===
                    "standard"
                  ) {
                    setBulkDeckCommanderId(
                      ""
                    );
                  }

                  setBulkDeckPreview(
                    null
                  );
                }}
              >
                <option value="standard">
                  Standard
                </option>
                <option value="commander">
                  Commander
                </option>
              </select>
            </label>
          </div>

          {bulkDeckFormat ===
            "commander" && (
            <label>
              Commander
              <select
                value={bulkDeckCommanderId}
                onChange={e => {
                  setBulkDeckCommanderId(
                    e.target.value
                  );
                  setBulkDeckPreview(null);
                }}
              >
                <option value="">
                  — Commander wählen —
                </option>
                {bulkCommanderOptions.map(
                  card => (
                    <option
                      key={card.id}
                      value={card.id}
                    >
                      {card.name}
                    </option>
                  )
                )}
              </select>
            </label>
          )}

          <div className="deck-list">
            {bulkDeckGroups.map(
              (group, index) => (
                <div
                  className="panel"
                  key={group.id}
                >
                  <div className="two">
                    <label>
                      Set {index + 1}
                      <select
                        value={group.setCode}
                        onChange={e => {
                          const value =
                            e.target.value;
                          setBulkDeckGroups(
                            current =>
                              current.map(
                                item =>
                                  item.id ===
                                  group.id
                                    ? {
                                        ...item,
                                        setCode:
                                          value
                                      }
                                    : item
                              )
                          );
                          setBulkDeckPreview(null);
                        }}
                        disabled={bulkDeckSetsBusy}
                      >
                        <option value="">
                          {bulkDeckSetsBusy
                            ? "Sets werden geladen…"
                            : "— Set auswählen —"}
                        </option>
                        {bulkDeckSets.map(
                          set => (
                            <option
                              key={set.id}
                              value={set.code}
                            >
                              {set.name} ({set.code.toUpperCase()})
                            </option>
                          )
                        )}
                      </select>
                    </label>

                    <label>
                      Collector Numbers
                      <textarea
                        value={group.numbers}
                        onChange={e => {
                          const value =
                            e.target.value;
                          setBulkDeckGroups(
                            current =>
                              current.map(
                                item =>
                                  item.id ===
                                  group.id
                                    ? {
                                        ...item,
                                        numbers:
                                          value
                                      }
                                    : item
                              )
                          );
                          setBulkDeckPreview(null);
                        }}
                        rows={4}
                        placeholder="z. B. 12, 18, 23, 56"
                      />
                    </label>
                  </div>

                  {bulkDeckGroups.length > 1 && (
                    <button
                      className="danger ghost"
                      onClick={() => {
                        setBulkDeckGroups(
                          current =>
                            current.filter(
                              item =>
                                item.id !==
                                group.id
                            )
                        );
                        setBulkDeckPreview(null);
                      }}
                    >
                      Set-Block entfernen
                    </button>
                  )}
                </div>
              )
            )}
          </div>

          <button
            className="secondary"
            onClick={() => {
              setBulkDeckGroups(
                current => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    setCode: "",
                    numbers: ""
                  }
                ]
              );
              setBulkDeckPreview(null);
            }}
          >
            + weiteres Set
          </button>

          {bulkDeckFormat ===
            "commander" && (
            <p className="muted">
              Der Commander wird separat gewählt und zählt nicht zu den eingegebenen Collector Numbers. Doppelte Karten, die das Commander-Copy-Limit überschreiten, werden als Fehler markiert.
            </p>
          )}

          <div className="row">
            <button
              className="primary"
              onClick={() =>
                void previewBulkDeck()
              }
              disabled={
                bulkDeckBusy ||
                !bulkDeckGroups.some(
                  group =>
                    group.setCode &&
                    parseCollectorNumbers(
                      group.numbers
                    ).length > 0
                ) ||
                (
                  bulkDeckFormat ===
                    "commander" &&
                  !bulkDeckCommanderId
                )
              }
            >
              {bulkDeckBusy
                ? "Deck wird geprüft…"
                : "Bulk-Deck prüfen"}
            </button>

            <button
              className="secondary"
              onClick={closeBulkDeck}
              disabled={bulkDeckBusy}
            >
              Abbrechen
            </button>
          </div>

          {bulkDeckPreview && (
            <div className="ai-box">
              <h3>
                Bulk-Deck-Prüfung
              </h3>

              <p>
                Format: {" "}
                <strong>
                  {bulkDeckPreview.deck.format ===
                  "commander"
                    ? "Commander"
                    : "Standard"}
                </strong>
                <br />
                Eingegebene Karten: {" "}
                <strong>
                  {bulkDeckPreview.requestedCards}
                </strong>
                <br />
                Aus der Sammlung aufgelöst: {" "}
                <strong>
                  {bulkDeckPreview.resolvedCards}
                </strong>
                <br />
                Deckgröße inklusive Commander: {" "}
                <strong>
                  {bulkDeckPreview.requestedCards +
                    bulkDeckPreview.deck.commanderIds.length}
                </strong>
              </p>

              <div className="deck-list">
                {bulkDeckPreview.rows.map(
                  row => (
                    <div
                      key={`${row.setCode}-${row.collectorNumber}`}
                    >
                      <span>
                        {row.setCode.toUpperCase()} #{row.collectorNumber}
                        {row.name
                          ? ` · ${row.name}`
                          : " · nicht gefunden"}
                        {row.errors.length >
                          0
                          ? " · ✕"
                          : " · ✓"}
                      </span>

                      <strong>
                        {row.count}×
                      </strong>
                    </div>
                  )
                )}
              </div>

              {bulkDeckPreview.errors.length >
                0 && (
                <div className="error">
                  <strong>
                    Fehler – Speichern ist noch nicht möglich:
                  </strong>

                  <div className="deck-list">
                    {bulkDeckPreview.errors.map(
                      (
                        error,
                        index
                      ) => (
                        <div
                          key={`${error}-${index}`}
                        >
                          <span>
                            {error}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              {bulkDeckPreview.warnings.length >
                0 && (
                <div className="notice">
                  <strong>
                    Hinweise:
                  </strong>

                  <div className="deck-list">
                    {bulkDeckPreview.warnings.map(
                      (
                        warning,
                        index
                      ) => (
                        <div
                          key={`${warning}-${index}`}
                        >
                          <span>
                            {warning}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              <div className="row">
                <button
                  className="primary"
                  onClick={() =>
                    void applyBulkDeck()
                  }
                  disabled={
                    bulkDeckBusy ||
                    bulkDeckPreview.resolvedCards ===
                      0 ||
                    bulkDeckPreview.errors.length >
                      0
                  }
                >
                  Bulk-Deck speichern
                </button>

                <button
                  className="secondary"
                  onClick={() =>
                    setBulkDeckPreview(
                      null
                    )
                  }
                  disabled={bulkDeckBusy}
                >
                  Eingabe bearbeiten
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {showImport && (
        <div className="panel">
          <h3>
            Deckliste importieren
          </h3>

          <p className="muted">
            Unterstützt werden Format-Zeilen sowie die Bereiche Commander, Deck/Mainboard und Sideboard. Vor dem Speichern siehst du fehlende Karten, Fehlmengen und mehrdeutige Ausgaben.
          </p>

          <label>
            Textdatei auswählen

            <input
              type="file"
              accept=".txt,text/plain"
              onChange={e =>
                void readDeckImportFile(
                  e.target.files?.[0]
                )
              }
            />
          </label>

          <textarea
            value={importText}
            onChange={e => {
              setImportText(
                e.target.value
              );

              setImportPreview(
                null
              );
            }}
            rows={12}
            placeholder={
              "Format: Commander\n\nCommander\n1 Cloud, Midgar Mercenary\n\nDeck\n1 Sol Ring\n1 Command Tower\n\nSideboard\n1 Example Card"
            }
          />

          <div className="row">
            <button
              className="primary"
              onClick={
                previewDeckImport
              }
              disabled={
                !importText.trim() ||
                importBusy
              }
            >
              Import prüfen
            </button>

            <button
              className="secondary"
              onClick={
                closeDeckImport
              }
              disabled={
                importBusy
              }
            >
              Abbrechen
            </button>
          </div>

          {importPreview && (
            <div className="ai-box">
              <h3>
                Import-Vorschau
              </h3>

              <p>
                Format:{" "}
                <strong>
                  {importPreview.deck.format ===
                  "commander"
                    ? "Commander"
                    : "Standard"}
                </strong>
                <br />

                Erkannt durch:{" "}
                <strong>
                  {
                    importPreview.formatDetectedBy
                  }
                </strong>
                <br />

                Angefordert:{" "}
                <strong>
                  {
                    importPreview.requestedCards
                  }
                </strong>
                {" "}Karten
                <br />

                Aus deiner Sammlung aufgelöst:{" "}
                <strong>
                  {
                    importPreview.importedCards
                  }
                </strong>
                {" "}Karten
                <br />

                Hauptdeck:{" "}
                <strong>
                  {importPreview.deck.cards.reduce(
                    (
                      sum,
                      card
                    ) =>
                      sum +
                      card.count,
                    0
                  )}
                </strong>
                <br />

                Commander:{" "}
                <strong>
                  {
                    importPreview.deck.commanderIds.length
                  }
                </strong>
                <br />

                Sideboard:{" "}
                <strong>
                  {importPreview.deck.sideboard.reduce(
                    (
                      sum,
                      card
                    ) =>
                      sum +
                      card.count,
                    0
                  )}
                </strong>
              </p>

              {importPreview.deck.commanderIds.length >
                0 && (
                <div className="commander-card">
                  <strong>
                    Commander
                  </strong>

                  {importPreview.deck.commanderIds.map(
                    id => {
                      const commander =
                        pool.find(
                          card =>
                            card.id ===
                            id
                        );

                      return commander
                        ? (
                          <span
                            key={
                              id
                            }
                          >
                            {
                              commander.name
                            }
                          </span>
                        )
                        : null;
                    }
                  )}
                </div>
              )}

              {importPreview.issues.length >
                0 && (
                <div className="notice">
                  <strong>
                    Hinweise vor dem Speichern:
                  </strong>

                  <div className="deck-list">
                    {importPreview.issues.map(
                      (
                        issue,
                        index
                      ) => (
                        <div
                          key={`${issue}-${index}`}
                        >
                          <span>
                            {issue}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}

              {importPreview.importedCards ===
                0 && (
                <div className="error">
                  Keine Karte aus der Liste konnte gegen deine Sammlung aufgelöst werden.
                </div>
              )}

              <div className="row">
                <button
                  className="primary"
                  onClick={() =>
                    void applyDeckImport()
                  }
                  disabled={
                    importBusy ||
                    importPreview.importedCards ===
                      0
                  }
                >
                  {importBusy
                    ? "Wird gespeichert…"
                    : "Import übernehmen"}
                </button>

                <button
                  className="secondary"
                  onClick={() =>
                    setImportPreview(
                      null
                    )
                  }
                  disabled={
                    importBusy
                  }
                >
                  Liste bearbeiten
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="deck-grid">
  {decks.map(d=>{
    const stats=
      deckStats(d);

    const totalMain=
      d.cards.reduce(
        (sum,card)=>sum+card.count,
        0
      );

    const totalWithCommanders=
      totalMain+
      (
        d.format==="commander"
          ?d.commanderIds.length
          :0
      );

    const commanders=
      d.commanderIds
        .map(
          id=>
            pool.find(
              card=>card.id===id
            )
        )
        .filter(
          (card):card is CardRecord=>
            Boolean(card)
        );

    const roleCounts=
      d.cards.reduce<
        Record<string,number>
      >(
        (counts,deckCard)=>{
          const source=
            pool.find(
              card=>card.id===deckCard.id
            );

          const role=
            deckCard.role &&
            deckCard.role!=="Manuell"
              ?deckCard.role
              :source
                ?roleOf(source)
                :"Sonstiges";

          counts[role]=
            (counts[role]??0)+
            deckCard.count;

          return counts;
        },
        {}
      );

    const roles=
      Object.entries(
        roleCounts
      )
        .sort(
          (a,b)=>
            b[1]-a[1]
        );

    const curve=
      deckManaCurve(d);

    const maxCurve=
      Math.max(
        1,
        ...curve.map(
          item=>item.count
        )
      );

    const bracketEstimate =
      commanderBracketEstimate(
        d,
        pool
      );

    return (
      <article
        className="panel saved-deck-card"
        key={d.id}
      >
        <style>{`
          .saved-deck-card{
            display:flex;
            flex-direction:column;
            gap:14px;
          }

          .saved-deck-head{
            display:flex;
            justify-content:space-between;
            align-items:flex-start;
            gap:12px;
          }

          .saved-deck-head h3{
            margin:0 0 4px;
          }

          .saved-commander{
            padding:10px 12px;
            border:1px solid rgba(214,173,88,.3);
            border-radius:10px;
            background:rgba(214,173,88,.055);
          }

          .saved-commander strong{
            display:block;
            margin-bottom:5px;
          }

          .saved-role-list{
            display:flex;
            flex-wrap:wrap;
            gap:6px;
          }

          .saved-role-list span{
            padding:5px 8px;
            border:1px solid rgba(85,215,229,.16);
            border-radius:999px;
            background:rgba(85,215,229,.05);
            font-size:11px;
          }

          .mini-curve{
            display:grid;
            grid-template-columns:repeat(8,1fr);
            gap:5px;
            align-items:end;
            min-height:95px;
          }

          .mini-curve-column{
            display:grid;
            grid-template-rows:1fr auto auto;
            align-items:end;
            text-align:center;
            min-width:0;
          }

          .mini-curve-bar-wrap{
            height:58px;
            display:flex;
            align-items:flex-end;
            justify-content:center;
          }

          .mini-curve-bar{
            width:70%;
            min-height:2px;
            border-radius:4px 4px 0 0;
            background:currentColor;
            opacity:.72;
          }

          .mini-curve-count{
            font-size:10px;
            font-weight:700;
          }

          .mini-curve-label{
            font-size:10px;
            color:var(--muted);
          }
        `}</style>

        <div className="saved-deck-head">
          <div>
            <h3>{d.name}</h3>

            <div className="meta">
              {d.format==="commander"
                ?"Commander"
                :"Standard"
              }
              {" · "}
              {totalWithCommanders} Karten
              {bracketEstimate && (
                <>
                  {" · "}
                  {bracketEstimate.label}
                </>
              )}
            </div>
          </div>

          {typeof d.score==="number"&&
            <strong>
              Score {d.score}
            </strong>
          }
        </div>

        {commanders.length>0&&
          <div className="saved-commander">
            <strong>
              {commanders.length===1
                ?"Commander"
                :"Commander"
              }
            </strong>

            {commanders
              .map(card=>card.name)
              .join(" + ")
            }
          </div>
        }

        <div className="stats">
          <div>
            <strong>
              {totalWithCommanders}
            </strong>

            <span>
              Karten gesamt
            </span>
          </div>

          <div>
            <strong>
              {stats.lands}
            </strong>

            <span>
              Länder
            </span>
          </div>

          <div>
            <strong>
              {stats.nonland}
            </strong>

            <span>
              Nichtländer
            </span>
          </div>

          <div>
            <strong>
              {stats.averageManaValue}
            </strong>

            <span>
              Ø Mana Value
            </span>
          </div>
        </div>

        {roles.length>0&&
          <div>
            <strong>
              Kartenrollen
            </strong>

            <div className="saved-role-list">
              {roles.map(
                ([role,count])=>
                  <span key={role}>
                    {role}: {count}
                  </span>
              )}
            </div>
          </div>
        }

        <div>
          <strong>
            Mana-Kurve
          </strong>

          <div className="mini-curve">
            {curve.map(item=>{
              const height=
                item.count===0
                  ?2
                  :Math.max(
                      6,
                      item.count/maxCurve*100
                    );

              return (
                <div
                  className="mini-curve-column"
                  key={item.label}
                >
                  <div className="mini-curve-bar-wrap">
                    <div
                      className="mini-curve-bar"
                      style={{
                        height:`${height}%`
                      }}
                    />
                  </div>

                  <span className="mini-curve-count">
                    {item.count}
                  </span>

                  <span className="mini-curve-label">
                    {item.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="row">
          <button
            className="primary"
            onClick={()=>setEditing(d)}
          >
            Bearbeiten
          </button>

          <button
            className="secondary"
            onClick={()=>download(
              `${d.name}.txt`,
              deckText(d,pool)
            )}
          >
            Export
          </button>

          <button
            className="danger ghost"
            onClick={()=>onDelete(d.id)}
          >
            Löschen
          </button>
        </div>
      </article>
    );
  })}
</div>
    </section>
  );
}

function DeckEditor({
  deck,
  pool,
  demoMode,
  onBack,
  onSave
}: {
  deck: DeckRecord;
  pool: CardRecord[];
  demoMode: boolean;
  onBack: () => void;
  onSave: (
    d: DeckRecord
  ) => Promise<void>;
}) {
  const [
    d,
    setD
  ] =
    useState(deck);

  const [
    analysisText,
    setAnalysisText
  ] =
    useState("");

  const [
    aiBusy,
    setAiBusy
  ] =
    useState(false);

  const [
    previewCardId,
    setPreviewCardId
  ] =
    useState<string | null>(
      null
    );

  const previewCard =
    previewCardId
      ? pool.find(
          card =>
            card.id ===
            previewCardId
        ) ?? null
      : null;

  const all = [
    ...d.cards
  ];

  const availableCommanders =
    useMemo(
      () =>
        commanderCandidates(
          pool
        ),
      [pool]
    );

  const selectedCommanders =
    useMemo(
      () =>
        d.format ===
        "commander"
          ? d.commanderIds
              .map(
                id =>
                  pool.find(
                    card =>
                      card.id ===
                      id
                  )
              )
              .filter(
                (
                  card
                ): card is CardRecord =>
                  Boolean(card)
              )
              .slice(
                0,
                2
              )
          : [],
      [
        d.commanderIds,
        d.format,
        pool
      ]
    );

  const primaryCommander =
    selectedCommanders[0];

  const secondCommander =
    selectedCommanders[1];

  const secondCommanderOptions =
    useMemo(
      () =>
        primaryCommander
          ? commanderPairCandidates(
              pool,
              primaryCommander
            )
          : [],
      [
        pool,
        primaryCommander
      ]
    );

  const commanderColors =
    commanderColorIdentity(
      selectedCommanders
    );

  const mainDeckCount =
    all.reduce(
      (
        sum,
        card
      ) =>
        sum +
        card.count,
      0
    );

  const commanderCount =
    d.format ===
    "commander"
      ? selectedCommanders.length
      : 0;

  const totalCards =
    mainDeckCount +
    commanderCount;

  const bracketEstimate =
    commanderBracketEstimate(
      d,
      pool
    );

  const commanderMainTarget =
    100 -
    Math.max(
      1,
      commanderCount
    );

  const isSourceLegal =
    (
      card:
        CardRecord
    ) => {
      if (
        d.format ===
        "standard"
      ) {
        return cardLegalForDeck(
          card,
          "standard"
        );
      }

      if (
        selectedCommanders.length ===
        0
      ) {
        return false;
      }

      return (
        !d.commanderIds.includes(
          card.id
        ) &&
        cardLegalForDeck(
          card,
          "commander",
          commanderColors
        )
      );
    };

  const legalPool =
    pool.filter(
      isSourceLegal
    );

  const illegalCards =
    all.filter(
      deckCard => {
        const source =
          pool.find(
            card =>
              card.id ===
              deckCard.id
          );

        return source
          ? !isSourceLegal(
              source
            )
          : true;
      }
    );

  const deckCountByName =
    all.reduce<
      Record<
        string,
        number
      >
    >(
      (
        counts,
        card
      ) => {
        const key =
          card.name.toLowerCase();

        counts[key] =
          (
            counts[key] ??
            0
          ) +
          card.count;

        return counts;
      },
      {}
    );

  const copyViolationNames =
    Array.from(
      new Set(
        all
          .filter(
            deckCard => {
              const source =
                pool.find(
                  card =>
                    card.id ===
                    deckCard.id
                );

              if (!source) {
                return false;
              }

              const ruleLimit =
                deckCopyLimit(
                  source,
                  d.format
                );

              const totalByName =
                deckCountByName[
                  deckCard.name.toLowerCase()
                ] ??
                0;

              return (
                totalByName >
                  ruleLimit ||
                deckCard.count >
                  source.count
              );
            }
          )
          .map(
            card =>
              card.name
          )
      )
    );

  const pairInvalid =
    d.format ===
      "commander" &&
    Boolean(
      secondCommander
    ) &&
    !secondCommanderOptions.some(
      card =>
        card.id ===
        secondCommander?.id
    );

  const commanderTooLarge =
    d.format ===
      "commander" &&
    totalCards >
      100;

  const hasBlockingError =
    illegalCards.length >
      0 ||
    copyViolationNames.length >
      0 ||
    Boolean(
      pairInvalid
    ) ||
    commanderTooLarge;

  const canAnalyze =
    !demoMode &&
    !hasBlockingError &&
    d.cards.length >
      0 &&
    (
      d.format !==
        "commander" ||
      selectedCommanders.length >
        0
    );

  const analyzeManualDeck =
    async () => {
      if (!canAnalyze) {
        return;
      }

      setAiBusy(true);
      setAnalysisText("");

      try {
        const deckForAnalysis:
          DeckRecord = {
            ...d,

            cards:
              d.cards.map(
                deckCard => {
                  const source =
                    pool.find(
                      card =>
                        card.id ===
                        deckCard.id
                    );

                  if (!source) {
                    return deckCard;
                  }

                  const detectedRole =
                    roleOf(
                      source
                    );

                  return {
                    ...deckCard,
                    role:
                      detectedRole,
                    reason:
                      `Für die KI-Analyse automatisch als „${detectedRole}“ erkannt.`
                  };
                }
              ),

           colors:
  d.format === "commander"
    ? commanderColors
    : Array.from(
        new Set(
          d.cards.flatMap(deckCard =>
            pool.find(
              card => card.id === deckCard.id
            )?.colorIdentity ?? []
          )
        )
      ),

            updatedAt:
              Date.now()
          };

        const text =
          await generateAiDeckExplanation(
            deckForAnalysis
          );

        setAnalysisText(
          text
        );
      } catch (error) {
        console.error(
          "KI-Analyse fehlgeschlagen:",
          error
        );

        const fallback =
          generateDeckExplanation(
            d
          );

        const errorMessage =
          error instanceof Error
            ? error.message
            : "Unbekannter Fehler bei der KI-Analyse.";

        setAnalysisText(
          fallback +
          "\n\n---\n\n" +
          "### ⚠️ Generative KI nicht verfügbar\n\n" +
          errorMessage +
          "\n\nDie lokale Deckanalyse wird deshalb als Fallback angezeigt."
        );
      } finally {
        setAiBusy(false);
      }
    };

  const add =
    (
      card:
        CardRecord
    ) => {
      if (
        !isSourceLegal(
          card
        )
      ) {
        return;
      }

      setD(current => {
        const existing =
          current.cards.find(
            item =>
              item.id ===
              card.id
          );

        const currentCount =
          existing?.count ??
          0;

        const currentByName =
          current.cards
            .filter(
              item =>
                item.name.toLowerCase() ===
                card.name.toLowerCase()
            )
            .reduce(
              (
                sum,
                item
              ) =>
                sum +
                item.count,
              0
            );

        const ruleLimit =
          deckCopyLimit(
            card,
            current.format
          );

        if (
          currentCount >=
            card.count ||
          currentByName >=
            ruleLimit
        ) {
          return current;
        }

        const currentCommanderCount =
          current.format ===
          "commander"
            ? current.commanderIds.length
            : 0;

        const currentMainCount =
          current.cards.reduce(
            (
              sum,
              item
            ) =>
              sum +
              item.count,
            0
          );

        const maxMain =
          current.format ===
          "commander"
            ? 100 -
              Math.max(
                1,
                currentCommanderCount
              )
            : Infinity;

        if (
          currentMainCount >=
          maxMain
        ) {
          return current;
        }

        if (existing) {
          return {
            ...current,
            cards:
              current.cards.map(
                item =>
                  item.id ===
                  card.id
                    ? {
                        ...item,
                        count:
                          item.count +
                          1,
                        available:
                          card.count
                      }
                    : item
              )
          };
        }

        return {
          ...current,
          cards: [
            ...current.cards,
            {
              id:
                card.id,
              name:
                card.name,
              count:
                1,
              manaValue:
                card.manaValue,
              typeLine:
                card.typeLine,
              role:
                "Manuell",
              reason:
                "Manuell hinzugefügt",
              available:
                card.count
            }
          ]
        };
      });
    };

  const choosePrimaryCommander =
    (
      id:
        string
    ) => {
      if (!id) {
        setD(current => ({
          ...current,
          commanderIds: [],
          colors: []
        }));

        return;
      }

      const commander =
        pool.find(
          card =>
            card.id ===
            id
        );

      if (!commander) {
        return;
      }

      setD(current => ({
        ...current,
        commanderIds: [
          commander.id
        ],
        colors:
          commander.colorIdentity ??
          []
      }));
    };

  const chooseSecondCommander =
    (
      id:
        string
    ) => {
      if (
        !primaryCommander
      ) {
        return;
      }

      if (!id) {
        setD(current => ({
          ...current,
          commanderIds: [
            primaryCommander.id
          ],
          colors:
            primaryCommander.colorIdentity ??
            []
        }));

        return;
      }

      const second =
        secondCommanderOptions.find(
          card =>
            card.id ===
            id
        );

      if (!second) {
        return;
      }

      const commanders = [
        primaryCommander,
        second
      ];

      setD(current => ({
        ...current,
        commanderIds:
          commanders.map(
            card =>
              card.id
          ),
        colors:
          commanderColorIdentity(
            commanders
          )
      }));
    };

  const changeFormat =
    (
      format:
        Format
    ) => {
      setD(current => ({
        ...current,
        format,
        commanderIds:
          format ===
          "commander"
            ? current.commanderIds.slice(
                0,
                2
              )
            : [],
        colors:
          format ===
          "commander"
            ? current.colors
            : [],
        cedh:
          format ===
          "commander"
            ? current.cedh
            : false
      }));

      setAnalysisText("");
    };

  return (
    <section>
      <div className="pagehead">
        <button
          className="secondary"
          onClick={onBack}
        >
          ← Zurück
        </button>

        <div>
          <h2>
            {d.name}
          </h2>

          <p className="muted">
            Manueller Deck-Editor · {totalCards} Karten
          </p>
        </div>

        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              void analyzeManualDeck()
            }
            disabled={
              aiBusy ||
              !canAnalyze
            }
            title={
              demoMode
                ? "Die generative KI benötigt eine Firebase-Anmeldung."
                : hasBlockingError
                  ? "Behebe zuerst die Regelverstöße im Deck."
                  : d.cards.length ===
                      0
                    ? "Für ein leeres Deck ist keine Analyse sinnvoll."
                    : d.format ===
                        "commander" &&
                      selectedCommanders.length ===
                        0
                      ? "Wähle zuerst einen Commander."
                      : undefined
            }
          >
            {aiBusy
              ? "KI analysiert…"
              : "Deck analysieren"}
          </button>

          <button
            className="primary"
            disabled={
              hasBlockingError
            }
            title={
              hasBlockingError
                ? "Behebe zuerst die Regelverstöße im Deck."
                : undefined
            }
            onClick={() =>
              onSave({
                ...d,
                colors:
                  d.format ===
                  "commander"
                    ? commanderColors
                    : d.colors,
                updatedAt:
                  Date.now()
              })
            }
          >
            Speichern
          </button>
        </div>
      </div>

      <div className="panel">
        <h3>
          Deck-Einstellungen
        </h3>

        <div className="two">
          <label>
            Deckname

            <input
              value={d.name}
              onChange={e => {
                setD(current => ({
                  ...current,
                  name:
                    e.target.value
                }));

                setAnalysisText("");
              }}
              placeholder="Name des Decks"
            />
          </label>

          <label>
            Format

            <select
              value={d.format}
              onChange={e =>
                changeFormat(
                  e.target
                    .value as Format
                )
              }
            >
              <option value="standard">
                Standard
              </option>

              <option value="commander">
                Commander
              </option>
            </select>
          </label>
        </div>

        {d.format ===
          "commander" && (
          <label>
            Commander

            <select
              value={
                primaryCommander?.id ??
                ""
              }
              onChange={e => {
                choosePrimaryCommander(
                  e.target.value
                );

                setAnalysisText("");
              }}
            >
              <option value="">
                — Commander wählen —
              </option>

              {availableCommanders.map(
                card => (
                  <option
                    key={
                      card.id
                    }
                    value={
                      card.id
                    }
                  >
                    {
                      card.name
                    }
                  </option>
                )
              )}
            </select>
          </label>
        )}

        {d.format ===
          "commander" &&
          primaryCommander &&
          secondCommanderOptions.length >
            0 && (
            <label>
              Zweiter Commander (optional)

              <select
                value={
                  secondCommander?.id ??
                  ""
                }
                onChange={e => {
                  chooseSecondCommander(
                    e.target.value
                  );

                  setAnalysisText(
                    ""
                  );
                }}
              >
                <option value="">
                  — kein zweiter Commander —
                </option>

                {secondCommanderOptions.map(
                  card => (
                    <option
                      key={
                        card.id
                      }
                      value={
                        card.id
                      }
                    >
                      {
                        card.name
                      }
                    </option>
                  )
                )}
              </select>
            </label>
          )}

        {d.format ===
          "commander" &&
          availableCommanders.length ===
            0 && (
            <div className="notice">
              In deiner Sammlung wurde aktuell keine Karte gefunden, die als Commander verwendet werden kann.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length >
            0 && (
            <div className="ai-box">
              <strong>
                Commander:
              </strong>{" "}

              {selectedCommanders
                .map(
                  card =>
                    card.name
                )
                .join(" + ")}

              <br />

              <span>
                Farbidentität:{" "}
                {commanderColors.length
                  ? commanderColors
                      .map(
                        color =>
                          COLOR_NAMES[
                            color
                          ] ??
                          color
                      )
                      .join(", ")
                  : "Farblos"}
              </span>
            </div>
          )}

        {d.format ===
          "commander" && (
          <label className="row">
            <input
              type="checkbox"
              checked={Boolean(d.cedh)}
              onChange={e => {
                setD(current => ({
                  ...current,
                  cedh:
                    e.target.checked
                }));
                setAnalysisText("");
              }}
            />
            Dieses Deck ist gezielt für cEDH gebaut (Bracket 5)
          </label>
        )}

        {bracketEstimate && (
          <div className="ai-box">
            <strong>
              {bracketEstimate.label}
            </strong>
            <div className="muted">
              Schätzung nach den Wizards-Commander-Bracket-Leitlinien. Spielabsicht und Zwei-Karten-Kombos lassen sich nicht vollständig automatisch aus der Deckliste bestimmen.
            </div>
            <div className="deck-list">
              {bracketEstimate.reasons.map(
                reason => (
                  <div key={reason}>
                    <span>{reason}</span>
                  </div>
                )
              )}
            </div>
          </div>
        )}

        <div className="stats">
          <div>
            <strong>
              {totalCards}
            </strong>

            <span>
              Karten aktuell
            </span>
          </div>

          <div>
            <strong>
              {d.format ===
              "commander"
                ? "100"
                : "60+"}
            </strong>

            <span>
              {d.format ===
              "commander"
                ? "Deckgröße"
                : "Mindestgröße"}
            </span>
          </div>

          {d.format ===
            "commander" && (
            <div>
              <strong>
                {mainDeckCount}/
                {commanderMainTarget}
              </strong>

              <span>
                Karten ohne Commander
              </span>
            </div>
          )}
        </div>

        {d.format ===
          "standard" &&
          totalCards < 60 && (
            <div className="notice">
              Für ein Standard-Deck fehlen aktuell noch{" "}
              {60 - totalCards} Karten bis zur Mindestgröße.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length ===
            0 && (
            <div className="notice">
              Wähle zuerst einen Commander. Danach werden nur Commander-legale Karten seiner Farbidentität angezeigt.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length >
            0 &&
          totalCards < 100 && (
            <div className="notice">
              Für das Commander-Deck fehlen aktuell noch{" "}
              {100 - totalCards} Karten.
            </div>
          )}

        {d.format ===
          "standard" &&
          totalCards >= 60 && (
            <div className="ai-box">
              Die Standard-Mindestgröße von 60 Karten ist erreicht.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommanders.length >
            0 &&
          totalCards === 100 && (
            <div className="ai-box">
              Die Commander-Deckgröße von 100 Karten ist erreicht.
            </div>
          )}

        {commanderTooLarge && (
          <div className="error">
            Das Deck enthält {totalCards} Karten. Ein Commander-Deck darf insgesamt nur 100 Karten enthalten.
          </div>
        )}

        {pairInvalid && (
          <div className="error">
            Die beiden ausgewählten Commander dürfen nach den unterstützten Partner-Regeln nicht gemeinsam als Commander verwendet werden.
          </div>
        )}

        {illegalCards.length >
          0 && (
          <div className="error">
            <strong>
              {illegalCards.length} Karten sind im gewählten Format bzw. mit der Commander-Farbidentität nicht erlaubt:
            </strong>

            <div>
              {illegalCards
                .map(
                  card =>
                    card.name
                )
                .join(", ")}
            </div>
          </div>
        )}

        {copyViolationNames.length >
          0 && (
          <div className="error">
            <strong>
              Bei diesen Karten ist die erlaubte bzw. vorhandene Anzahl überschritten:
            </strong>

            <div>
              {copyViolationNames.join(
                ", "
              )}
            </div>
          </div>
        )}
      </div>

      <div className="editor-grid">
        <div className="panel">
          <h3>
            {d.format ===
            "commander"
              ? `Deck · ${mainDeckCount}/${commanderMainTarget} Karten`
              : `Deck · ${totalCards} Karten`}
          </h3>

          {d.format ===
            "commander" &&
            selectedCommanders.map(
              (
                commander,
                index
              ) => (
                <div
                  className="commander-card"
                  key={
                    commander.id
                  }
                >
                  <strong>
                    {index ===
                    0
                      ? "Commander"
                      : "Zweiter Commander"}
                  </strong>

                  <span>
                    {
                      commander.name
                    }
                  </span>

                  <small>
                    {
                      commander.typeLine
                    }
                  </small>
                </div>
              )
            )}

          {all.length ===
            0 && (
            <p className="muted">
              Das Deck ist noch leer. Füge rechts Karten aus deiner Sammlung hinzu.
            </p>
          )}

          {all.map(card => {
            const source =
              pool.find(
                item =>
                  item.id ===
                  card.id
              );

            const illegal =
              illegalCards.some(
                item =>
                  item.id ===
                  card.id
              );

            const copyViolation =
              copyViolationNames.includes(
                card.name
              );

            const ruleLimit =
              source
                ? deckCopyLimit(
                    source,
                    d.format
                  )
                : 0;

            const allowedLabel =
              Number.isFinite(
                ruleLimit
              )
                ? String(
                    ruleLimit
                  )
                : "beliebig";

            return (
              <div
                className="edit-row"
                key={card.id}
              >
                <span>
                  {card.count}×{" "}
                  {card.name}

                  {illegal && (
                    <small className="illegal-card">
                      {" "}· nicht erlaubt
                    </small>
                  )}

                  {copyViolation && (
                    <small className="illegal-card">
                      {" "}· Maximum{" "}
                      {allowedLabel}
                    </small>
                  )}
                </span>

                <div>
                  <button
                    onClick={() => {
                      setD(current => ({
                        ...current,
                        cards:
                          current.cards
                            .map(
                              item =>
                                item.id ===
                                card.id
                                  ? {
                                      ...item,
                                      count:
                                        Math.max(
                                          0,
                                          item.count -
                                            1
                                        )
                                    }
                                  : item
                            )
                            .filter(
                              item =>
                                item.count >
                                0
                            )
                      }));

                      setAnalysisText("");
                    }}
                  >
                    −
                  </button>

                  <button
                    disabled={
                      !source ||
                      card.count >=
                        source.count ||
                      (
                        (
                          deckCountByName[
                            card.name.toLowerCase()
                          ] ??
                          0
                        ) >=
                        (
                          source
                            ? deckCopyLimit(
                                source,
                                d.format
                              )
                            : 0
                        )
                      ) ||
                      (
                        d.format ===
                          "commander" &&
                        mainDeckCount >=
                          commanderMainTarget
                      )
                    }
                    onClick={() => {
                      if (source) {
                        add(source);
                        setAnalysisText(
                          ""
                        );
                      }
                    }}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="panel">
          <h3>
            Karten hinzufügen
          </h3>

          <style>{`
            .manual-card-preview{
              margin-bottom:14px;
              padding:12px;
              border:1px solid rgba(214,173,88,.24);
              border-radius:12px;
              background:rgba(6,13,24,.72);
            }

            .manual-card-preview-grid{
              display:grid;
              grid-template-columns:120px minmax(0,1fr);
              gap:14px;
              align-items:start;
            }

            .manual-card-preview img{
              width:100%;
              border-radius:9px;
              display:block;
            }

            .manual-card-preview h4{
              margin:0 0 5px;
            }

            .manual-card-preview-oracle{
              white-space:pre-wrap;
              font-size:12px;
              line-height:1.45;
            }

            .manual-add-row{
              display:grid;
              grid-template-columns:minmax(0,1fr) auto;
              gap:8px;
              align-items:center;
            }

            .manual-card-preview-trigger{
              display:block;
              width:100%;
              padding:7px 4px;
              border:0;
              background:none;
              color:inherit;
              text-align:left;
              cursor:pointer;
            }

            .manual-card-preview-trigger:hover,
            .manual-card-preview-trigger:focus{
              color:var(--gold-bright);
              outline:none;
            }

            @media (max-width:650px){
              .manual-card-preview-grid{
                grid-template-columns:90px minmax(0,1fr);
              }
            }
          `}</style>

          {previewCard && (
            <div className="manual-card-preview">
              <div className="manual-card-preview-grid">
                <div>
                  {(previewCard.imageUri ||
                    previewCard.imageUris?.normal ||
                    previewCard.imageUris?.large ||
                    previewCard.imageUris?.small) && (
                    <img
                      src={
                        previewCard.imageUri ??
                        previewCard.imageUris?.normal ??
                        previewCard.imageUris?.large ??
                        previewCard.imageUris?.small
                      }
                      alt={previewCard.name}
                    />
                  )}
                </div>

                <div>
                  <h4>
                    {previewCard.name}
                  </h4>

                  <div className="meta">
                    {previewCard.manaCost ?? "—"} · MV{" "}
                    {previewCard.manaValue}
                  </div>

                  <p>
                    {previewCard.typeLine}
                  </p>

                  {previewCard.oracleText && (
                    <p className="manual-card-preview-oracle">
                      {previewCard.oracleText}
                    </p>
                  )}

                  <button
                    className="secondary"
                    onClick={() =>
                      setPreviewCardId(
                        null
                      )
                    }
                  >
                    Vorschau schließen
                  </button>
                </div>
              </div>
            </div>
          )}

          {d.format ===
            "commander" &&
          selectedCommanders.length ===
            0
            ? (
              <p className="muted">
                Wähle zuerst einen Commander.
              </p>
            )
            : (
              <>
                <input
                  placeholder="Karte filtern…"
                  onChange={e => {
                    const value =
                      e.target.value.toLowerCase();

                    document
                      .querySelectorAll<HTMLElement>(
                        "[data-card]"
                      )
                      .forEach(
                        element => {
                          element.hidden =
                            !element.dataset.card!.includes(
                              value
                            );
                        }
                      );
                  }}
                />

                <div className="add-list">
                  {legalPool
                    .slice(
                      0,
                      200
                    )
                    .map(
                      card => {
                        const current =
                          all.find(
                            item =>
                              item.id ===
                              card.id
                          )
                            ?.count ??
                          0;

                        const currentByName =
                          deckCountByName[
                            card.name.toLowerCase()
                          ] ??
                          0;

                        const ruleLimit =
                          deckCopyLimit(
                            card,
                            d.format
                          );

                        const ruleLimitLabel =
                          Number.isFinite(
                            ruleLimit
                          )
                            ? String(
                                ruleLimit
                              )
                            : "beliebig";

                        const commanderFull =
                          d.format ===
                            "commander" &&
                          mainDeckCount >=
                            commanderMainTarget;

                        return (
                          <div
                            className="manual-add-row"
                            data-card={
                              card.name.toLowerCase()
                            }
                            key={
                              card.id
                            }
                        onPointerEnter={event => {
                            if (
                              event.pointerType ===
                              "mouse"
                            ) {
                              setPreviewCardId(
                                card.id
                              );
                            }
                          }}
                          >
                            <button
                              type="button"
                              className="manual-card-preview-trigger"
                              onClick={() =>
                                setPreviewCardId(
                                  current =>
                                    current ===
                                    card.id
                                      ? null
                                      : card.id
                                )
                              }
                              title="Karte anzeigen"
                            >
                              <span>
                                {card.name}

                                <small className="muted">
                                  {" "}(
                                  {currentByName}
                                  /
                                  {ruleLimitLabel}
                                  )
                                </small>
                              </span>
                            </button>

                            <button
                              disabled={
                                current >=
                                  card.count ||
                                currentByName >=
                                  ruleLimit ||
                                commanderFull
                              }
                              onClick={() => {
                                add(card);
                                setAnalysisText(
                                  ""
                                );
                              }}
                            >
                              +1
                            </button>
                          </div>
                        );
                      }
                    )}
                </div>

                {legalPool.length ===
                  0 && (
                  <div className="notice">
                    Für die aktuelle Auswahl sind keine legalen Karten aus deiner Sammlung verfügbar.
                  </div>
                )}
              </>
            )}
        </div>
      </div>

      {analysisText && (
        <div className="ai-box analysis-box markdown-content">
          <ReactMarkdown
            remarkPlugins={[
              remarkGfm
            ]}
          >
            {analysisText}
          </ReactMarkdown>
        </div>
      )}
    </section>
  );
}

export default App;
