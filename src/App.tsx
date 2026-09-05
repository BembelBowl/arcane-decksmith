import { useEffect, useMemo, useState } from "react";
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
  getPrintings,
  imageFor,
  searchCards,
  scryfallUrl,
  normalizeCard,
  type ScryfallCard
} from "./scryfall";
import {
  buildDeck,
  commanderCandidates,
  deckStats
} from "./deckBuilder";
import {
  deckText,
  download,
  parseList,
  toCsv
} from "./importExport";
import {
  generateAiDeckExplanation,
  generateDeckExplanation
} from "./ai";
import type {
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
        onDemo={(email) => {
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
            Firebase ist noch nicht konfiguriert.
            Du kannst den lokalen Demo-Modus verwenden.
          </div>
        )}

        <label>
          E-Mail

          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
          />
        </label>

        <label>
          Passwort

          <input
            value={pw}
            onChange={(e) => setPw(e.target.value)}
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

  const [page, setPage] =
    useState<
      "collection" |
      "search" |
      "builder" |
      "decks"
    >("collection");

  const [busy, setBusy] =
    useState(true);

  const [toast, setToast] =
    useState("");

  useEffect(() => {
    void (async () => {
      setBusy(true);

      try {
        setCollection(
          await loadCollection(uid)
        );

        setDecks(
          await loadDecks(uid)
        );
      } finally {
        setBusy(false);
      }
    })();
  }, [uid]);

  const persistCard =
    async (card: CardRecord) => {
      await saveCard(uid, card);

      setCollection(
        await loadCollection(uid)
      );
    };

  const persistDeck =
    async (deck: DeckRecord) => {
      await saveDeck(uid, deck);

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
          ).map((p) => (
            <button
              key={p}
              className={
                page === p
                  ? "nav active"
                  : "nav"
              }
              onClick={() => setPage(p)}
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
        {busy ? (
          <div className="loading">
            Daten werden geladen…
          </div>
        ) : page === "collection" ? (
          <Collection
            cards={collection}
            onChange={persistCard}
            onDelete={delCard}
            onImport={async (next) => {
              for (const card of next) {
                await saveCard(uid, card);
              }

              setCollection(
                await loadCollection(uid)
              );
            }}
          />
        ) : page === "search" ? (
          <Search
            onAdd={async (card) => {
              const existing =
                collection.find(
                  (item) =>
                    item.id === card.id
                );

              await persistCard(
                existing
                  ? {
                      ...existing,
                      count:
                        existing.count + 1,
                      updatedAt:
                        Date.now()
                    }
                  : {
                      ...normalizeCard(card),
                      count: 1
                    }
              );

              setToast(
                existing
                  ? `${card.name}: Anzahl auf ${existing.count + 1} erhöht.`
                  : `${card.name} wurde zur Sammlung hinzugefügt.`
              );

              setTimeout(
                () => setToast(""),
                2200
              );
            }}
          />
        ) : page === "builder" ? (
          <Builder
            pool={collection}
            onSave={persistDeck}
            demoMode={demoMode}
          />
        ) : (
          <Decks
            decks={decks}
            pool={collection}
            onDelete={delDeck}
            onSave={persistDeck}
          />
        )}
      </main>

      <footer>
        Scryfall-Daten & Bilder werden
        direkt von Scryfall geladen.
        Keine Kaufentscheidung aufgrund
        von Preisen.
      </footer>
    </div>
  );
}

function Search({
  onAdd
}: {
  onAdd:
    (card: ScryfallCard) =>
      Promise<void>;
}) {
  const [q, setQ] =
    useState("");

  const [results, setResults] =
    useState<ScryfallCard[]>([]);

  const [suggestions, setSuggestions] =
    useState<string[]>([]);

  const [busy, setBusy] =
    useState(false);

  useEffect(() => {
    const timer =
      setTimeout(() => {
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
      clearTimeout(timer);
  }, [q]);

  const go = async () => {
    setBusy(true);

    try {
      setResults(
        await searchCards(q)
      );
    } catch (error: any) {
      alert(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Kartensuche</h2>

          <p className="muted">
            Scryfall-Suche mit lokalem
            Sitzungscache.
          </p>
        </div>
      </div>

      <div className="searchbar">
        <input
          value={q}
          onChange={(e) =>
            setQ(e.target.value)
          }
          onKeyDown={(e) =>
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

      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map(
            (suggestion) => (
              <button
                key={suggestion}
                onClick={() => {
                  setQ(suggestion);
                  setSuggestions([]);
                }}
              >
                {suggestion}
              </button>
            )
          )}
        </div>
      )}

      {busy ? (
        <div className="loading">
          Scryfall fragt Karten ab…
        </div>
      ) : (
        <div className="card-grid">
          {results.map((card) => (
            <SearchCard
              key={card.id}
              card={card}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SearchCard({
  card,
  onAdd
}: {
  card: ScryfallCard;
  onAdd:
    (card: ScryfallCard) =>
      void | Promise<void>;
}) {
  const [
    selectedCard,
    setSelectedCard
  ] = useState<ScryfallCard>(card);

  const [
    printings,
    setPrintings
  ] = useState<ScryfallCard[]>([]);

  const [
    showPrintings,
    setShowPrintings
  ] = useState(false);

  const [
    loadingPrintings,
    setLoadingPrintings
  ] = useState(false);

  const [
    printingError,
    setPrintingError
  ] = useState("");

  useEffect(() => {
    setSelectedCard(card);
    setPrintings([]);
    setShowPrintings(false);
    setPrintingError("");
  }, [card.id]);

  const loadPrintings =
    async () => {
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
        src={imageFor(selectedCard)}
        alt={selectedCard.name}
        loading="lazy"
      />

      <div className="card-body">
        <h3>
          {selectedCard.name}
        </h3>

        <div className="meta">
          {selectedCard.mana_cost ??
            "—"}{" "}
          · MV{" "}
          {selectedCard.cmc ?? 0} ·{" "}
          {selectedCard.set.toUpperCase()}{" "}
          #
          {
            selectedCard.collector_number
          }
        </div>

        {selectedCard.set_name && (
          <div className="meta">
            {selectedCard.set_name}
          </div>
        )}

        <p>
          {selectedCard.type_line}
        </p>

        <p className="oracle">
          {selectedCard.oracle_text ??
            selectedCard.card_faces
              ?.map(
                (face) =>
                  face.oracle_text
              )
              .filter(Boolean)
              .join(" / ")}
        </p>

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
                  Scryfall lädt
                  verfügbare Drucke…
                </div>
              )}

            {!loadingPrintings &&
              printings.length >
                0 && (
                <>
                  <label>
                    Ausgabe auswählen

                    <select
                      className="variant-select"
                      value={
                        selectedCard.id
                      }
                      onChange={(e) => {
                        const chosen =
                          printings.find(
                            (printing) =>
                              printing.id ===
                              e.target
                                .value
                          );

                        if (chosen) {
                          setSelectedCard(
                            chosen
                          );
                        }
                      }}
                    >
                      {printings.map(
                        (printing) => (
                          <option
                            key={
                              printing.id
                            }
                            value={
                              printing.id
                            }
                          >
                            {printing.set_name ??
                              printing.set}
                            {" · "}
                            {printing.set.toUpperCase()}
                            {" #"}
                            {
                              printing.collector_number
                            }
                            {printing.lang &&
                            printing.lang !==
                              "en"
                              ? ` · ${printing.lang.toUpperCase()}`
                              : ""}
                          </option>
                        )
                      )}
                    </select>
                  </label>

                  <div className="variant-info">
                    <strong>
                      Gewählte Ausgabe:
                    </strong>

                    <span>
                      {selectedCard.set_name ??
                        selectedCard.set.toUpperCase()}
                    </span>

                    <span>
                      Set:{" "}
                      {selectedCard.set.toUpperCase()}
                    </span>

                    <span>
                      Collector Nr.:{" "}
                      {
                        selectedCard.collector_number
                      }
                    </span>

                    {selectedCard.rarity && (
                      <span>
                        Seltenheit:{" "}
                        {
                          selectedCard.rarity
                        }
                      </span>
                    )}
                  </div>
                </>
              )}
          </div>
        )}

        <div className="row search-card-actions">
          <button
            className="primary"
            onClick={() =>
              onAdd(selectedCard)
            }
          >
            + Sammlung
          </button>

          <a
            href={scryfallUrl(
              selectedCard.id
            )}
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
  onDelete,
  onImport
}: {
  cards: CardRecord[];
  onChange:
    (card: CardRecord) =>
      Promise<void>;
  onDelete:
    (id: string) =>
      Promise<void>;
  onImport:
    (cards: CardRecord[]) =>
      Promise<void>;
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

  const [
    importText,
    setImportText
  ] = useState("");

  const [
    showImport,
    setShowImport
  ] = useState(false);

  const filtered =
    useMemo(
      () =>
        cards
          .filter((card) =>
            `${card.name} ${card.set} ${card.typeLine} ${card.oracleText}`
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
                : a.name.localeCompare(
                    b.name
                  )
          ),
      [cards, query, sort]
    );

  const total =
    cards.reduce(
      (sum, card) =>
        sum + card.count,
      0
    );

  const groups =
    group === "none"
      ? {
          Alle: filtered
        }
      : filtered.reduce<
          Record<
            string,
            CardRecord[]
          >
        >((result, card) => {
          const key =
            group === "color"
              ? card.colors.join("") ||
                "Farblos"
              : group === "type"
                ? card.typeLine?.split(
                    "—"
                  )[0] ??
                  "Unbekannt"
                : group === "set"
                  ? card.set.toUpperCase()
                  : `MV ${card.manaValue}`;

          (
            result[key] ??= []
          ).push(card);

          return result;
        }, {});

  const importList =
    async () => {
      const rows =
        parseList(importText);

      const output =
        [...cards];

      for (const row of rows) {
        try {
          const matches =
            await searchCards(
              row.name
            );

          const hit =
            matches[0];

          if (!hit) {
            continue;
          }

          const normalized =
            normalizeCard(
              hit,
              row.count
            );

          const old =
            output.find(
              (card) =>
                card.id ===
                normalized.id
            );

          if (old) {
            old.count +=
              row.count;
          } else {
            output.push(
              normalized
            );
          }
        } catch {
          // Ungültige oder nicht
          // gefundene Karten werden
          // übersprungen.
        }
      }

      await onImport(output);

      setImportText("");
      setShowImport(false);
    };

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Sammlung</h2>

          <p className="muted">
            {cards.length}{" "}
            unterschiedliche Karten ·{" "}
            {total} physische Karten
          </p>
        </div>

        <div className="row">
          <button
            className="secondary"
            onClick={() =>
              download(
                "collection.json",
                JSON.stringify(
                  cards,
                  null,
                  2
                ),
                "application/json"
              )
            }
          >
            JSON export
          </button>

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

          <button
            className="primary"
            onClick={() =>
              setShowImport(
                !showImport
              )
            }
          >
            Import
          </button>
        </div>
      </div>

      {showImport && (
        <div className="panel">
          <h3>Textimport</h3>

          <textarea
            value={importText}
            onChange={(e) =>
              setImportText(
                e.target.value
              )
            }
            placeholder={
              "4 Lightning Bolt\n2x Counterspell\n1 Sol Ring"
            }
            rows={6}
          />

          <div className="row">
            <button
              className="primary"
              onClick={importList}
            >
              Import prüfen &
              übernehmen
            </button>

            <button
              className="secondary"
              onClick={() =>
                setShowImport(false)
              }
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <input
          value={query}
          onChange={(e) =>
            setQuery(e.target.value)
          }
          placeholder="Sammlung durchsuchen…"
        />

        <select
          value={sort}
          onChange={(e) =>
            setSort(e.target.value)
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
        </select>

        <select
          value={group}
          onChange={(e) =>
            setGroup(
              e.target.value as GroupBy
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

      {Object.entries(groups).map(
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
              {list.map((card) => (
                <CollectionCard
                  key={card.id}
                  card={card}
                  selected={
                    selected.has(
                      card.id
                    )
                  }
                  toggle={() =>
                    setSelected(
                      (current) => {
                        const next =
                          new Set(
                            current
                          );

                        if (
                          next.has(
                            card.id
                          )
                        ) {
                          next.delete(
                            card.id
                          );
                        } else {
                          next.add(
                            card.id
                          );
                        }

                        return next;
                      }
                    )
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
                const id of selected
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
  onChange:
    (card: CardRecord) =>
      Promise<void>;
  onDelete:
    (id: string) =>
      Promise<void>;
}) {
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
        <h3>{card.name}</h3>

        <div className="meta">
          {card.set.toUpperCase()} #
          {card.collectorNumber} · MV{" "}
          {card.manaValue}
        </div>

        <p>{card.typeLine}</p>

        <div className="quantity">
          <button
            onClick={() =>
              onChange({
                ...card,
                count:
                  Math.max(
                    1,
                    card.count - 1
                  ),
                updatedAt:
                  Date.now()
              })
            }
          >
            −
          </button>

          <strong>
            {card.count}
          </strong>

          <button
            onClick={() =>
              onChange({
                ...card,
                count:
                  card.count + 1,
                updatedAt:
                  Date.now()
              })
            }
          >
            +
          </button>

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

function Builder({
  pool,
  onSave,
  demoMode
}: {
  pool: CardRecord[];
  onSave:
    (deck: DeckRecord) =>
      Promise<void>;
  demoMode: boolean;
}) {
  const [format, setFormat] =
    useState<Format>(
      "commander"
    );

  const [colors, setColors] =
    useState<string[]>(["G"]);

  const [
    commanderId,
    setCommanderId
  ] = useState("");

  const [target, setTarget] =
    useState(3);

  const [min, setMin] =
    useState("");

  const [max, setMax] =
    useState("");

  const [name, setName] =
    useState("Neues Deck");

  const [result, setResult] =
    useState<DeckRecord | null>(
      null
    );

  const [
    analysisText,
    setAnalysisText
  ] = useState("");

  const [aiBusy, setAiBusy] =
    useState(false);

  const commanders =
    useMemo(
      () =>
        commanderCandidates(
          pool,
          colors
        ),
      [pool, colors]
    );

  useEffect(() => {
    if (
      !commanders.some(
        (card) =>
          card.id ===
          commanderId
      )
    ) {
      setCommanderId(
        commanders[0]?.id ?? ""
      );
    }
  }, [
    commanders,
    commanderId
  ]);

  const build = () => {
    const commander =
      commanders.find(
        (card) =>
          card.id ===
          commanderId
      );

    const deck =
      buildDeck(pool, {
        name,
        format,
        colors,
        commander:
          format === "commander"
            ? commander
            : undefined,
        targetManaValue:
          target,
        minManaValue:
          min === ""
            ? undefined
            : Number(min),
        maxManaValue:
          max === ""
            ? undefined
            : Number(max)
      });

    setResult(deck);
    setAnalysisText("");
  };

  const explain =
    async () => {
      if (!result) {
        return;
      }

      setAiBusy(true);
      setAnalysisText("");

      try {
        const text =
          await generateAiDeckExplanation(
            result
          );

        setAnalysisText(text);
      } catch (error) {
        console.error(
          "KI-Analyse fehlgeschlagen:",
          error
        );

        const fallback =
          generateDeckExplanation(
            result
          );

        setAnalysisText(
          fallback +
            "\n\nHinweis: Die generative KI war gerade nicht erreichbar. Deshalb wird die lokale Deckanalyse angezeigt."
        );
      } finally {
        setAiBusy(false);
      }
    };

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>
            Deck automatisch bauen
          </h2>

          <p className="muted">
            Der Optimierer verwendet
            ausschließlich Karten aus
            deiner Sammlung und erklärt
            jede Auswahl.
          </p>
        </div>
      </div>

      <div className="builder-grid">
        <div className="panel">
          <label>
            Name

            <input
              value={name}
              onChange={(e) =>
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
              onChange={(e) =>
                setFormat(
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

          <label>
            Deckfarben

            <div className="color-pills">
              {COLORS.map(
                (color) => (
                  <button
                    type="button"
                    key={color}
                    className={
                      colors.includes(
                        color
                      )
                        ? "color active"
                        : "color"
                    }
                    onClick={() =>
                      setColors(
                        (
                          current
                        ) =>
                          current.includes(
                            color
                          )
                            ? current.filter(
                                (
                                  item
                                ) =>
                                  item !==
                                  color
                              )
                            : [
                                ...current,
                                color
                              ]
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
          </label>

          {format ===
            "commander" && (
            <label>
              Commander

              <select
                value={
                  commanderId
                }
                onChange={(e) =>
                  setCommanderId(
                    e.target.value
                  )
                }
              >
                <option value="">
                  — wählen —
                </option>

                {commanders.map(
                  (card) => (
                    <option
                      key={
                        card.id
                      }
                      value={
                        card.id
                      }
                    >
                      {card.name}
                    </option>
                  )
                )}
              </select>
            </label>
          )}

          {format ===
            "commander" &&
            commanders.length ===
              0 && (
              <div className="notice">
                Für die aktuell
                gewählten Farben wurde
                in deiner Sammlung kein
                geeigneter Commander
                gefunden.
              </div>
            )}

          <label>
            Ziel-Mana Value

            <input
              type="number"
              min="0"
              max="15"
              step="0.1"
              value={target}
              onChange={(e) =>
                setTarget(
                  Number(
                    e.target.value
                  )
                )
              }
            />
          </label>

          <div className="two">
            <label>
              Min. MV

              <input
                type="number"
                min="0"
                value={min}
                onChange={(e) =>
                  setMin(
                    e.target.value
                  )
                }
              />
            </label>

            <label>
              Max. MV

              <input
                type="number"
                min="0"
                value={max}
                onChange={(e) =>
                  setMax(
                    e.target.value
                  )
                }
              />
            </label>
          </div>

          <button
            className="primary full"
            onClick={build}
            disabled={
              !colors.length ||
              pool.length === 0 ||
              (
                format ===
                  "commander" &&
                !commanderId
              )
            }
          >
            Deck erstellen
          </button>

          {pool.length === 0 && (
            <div className="notice">
              Deine Sammlung ist leer.
              Füge zuerst Karten über
              die Kartensuche hinzu.
            </div>
          )}
        </div>

        {result ? (
          <div className="panel">
            <h3>{result.name}</h3>

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
                    )
                      .averageManaValue
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

            <div className="role-list">
              {Object.entries(
                deckStats(result)
                  .roleCounts
              ).map(
                ([role, count]) => (
                  <span key={role}>
                    {role}: {count}
                  </span>
                )
              )}
            </div>

            <div className="deck-list">
              {result.cards.map(
                (card) => (
                  <div
                    key={card.id}
                  >
                    <span>
                      <b>
                        {card.count}×
                      </b>{" "}
                      {card.name}
                    </span>

                    <small>
                      {card.role} ·{" "}
                      {card.reason}
                    </small>
                  </div>
                )
              )}
            </div>

            <div className="row">
              <button
                className="primary"
                onClick={() =>
                  onSave(result)
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
                      result
                    )
                  )
                }
              >
                Export
              </button>

              <button
                className="secondary"
                onClick={explain}
                disabled={
                  aiBusy ||
                  demoMode
                }
                title={
                  demoMode
                    ? "Die generative KI benötigt eine Firebase-Anmeldung."
                    : undefined
                }
              >
                {aiBusy
                  ? "KI analysiert…"
                  : "Deck analysieren"}
              </button>
            </div>

            {demoMode && (
              <div className="notice">
                Die generative
                KI-Analyse steht im
                lokalen Demo-Modus
                nicht zur Verfügung.
                Melde dich mit deinem
                Arcane-Decksmith-Konto
                an, um sie zu
                verwenden.
              </div>
            )}

            {analysisText && (
              <div className="ai-box analysis-box">
                {analysisText}
              </div>
            )}
          </div>
        ) : (
          <div className="panel empty">
            <h3>Vorschau</h3>

            <p>
              Hier erscheinen
              Deckgröße, Mana-Kurve,
              Rollen und
              Auswahlbegründungen.
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
  onSave
}: {
  decks: DeckRecord[];
  pool: CardRecord[];
  onDelete:
    (id: string) =>
      Promise<void>;
  onSave:
    (deck: DeckRecord) =>
      Promise<void>;
}) {
  const [editing, setEditing] =
    useState<DeckRecord | null>(
      null
    );

  const [
    importText,
    setImportText
  ] = useState("");

  const [
    showImport,
    setShowImport
  ] = useState(false);

  const newManualDeck =
    () => {
      const now =
        Date.now();

      const deck: DeckRecord =
        {
          id:
            crypto.randomUUID(),
          name:
            "Neues manuelles Deck",
          format: "standard",
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

  const importDeck =
    async () => {
      const rows =
        parseList(importText);

      const cards:
        DeckRecord["cards"] =
          [];

      for (const row of rows) {
        const hit =
          pool.find(
            (card) =>
              card.name.toLowerCase() ===
              row.name.toLowerCase()
          ) ??
          pool.find((card) =>
            card.name
              .toLowerCase()
              .includes(
                row.name.toLowerCase()
              )
          );

        if (hit) {
          cards.push({
            id: hit.id,
            name: hit.name,
            count:
              Math.min(
                row.count,
                hit.count
              ),
            manaValue:
              hit.manaValue,
            typeLine:
              hit.typeLine,
            role: "Import",
            reason:
              "Aus Deckliste importiert.",
            available:
              hit.count
          });
        }
      }

      const deck:
        DeckRecord = {
          id:
            crypto.randomUUID(),
          name:
            "Importiertes Deck",
          format: "standard",
          commanderIds: [],
          cards,
          sideboard: [],
          colors: [],
          createdAt:
            Date.now(),
          updatedAt:
            Date.now(),
          notes:
            "Importierte Deckliste; bitte Format und Legalität im Editor prüfen."
        };

      if (cards.length) {
        await onSave(deck);
      }

      setImportText("");
      setShowImport(false);
    };

  if (editing) {
    return (
      <DeckEditor
        deck={editing}
        pool={pool}
        onBack={() =>
          setEditing(null)
        }
        onSave={async (
          deck
        ) => {
          await onSave(deck);
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
            + Deck manuell
            erstellen
          </button>

          <button
            className="secondary"
            onClick={() =>
              setShowImport(
                !showImport
              )
            }
          >
            Deckliste importieren
          </button>
        </div>
      </div>

      {showImport && (
        <div className="panel">
          <h3>
            Deckliste importieren
          </h3>

          <p className="muted">
            Format: „4 Lightning
            Bolt“. Die Karten werden
            gegen deine Sammlung
            aufgelöst.
          </p>

          <textarea
            value={importText}
            onChange={(e) =>
              setImportText(
                e.target.value
              )
            }
            rows={8}
            placeholder={
              "4 Lightning Bolt\n4 Counterspell\n20 Island"
            }
          />

          <div className="row">
            <button
              className="primary"
              onClick={importDeck}
            >
              Importieren
            </button>

            <button
              className="secondary"
              onClick={() =>
                setShowImport(false)
              }
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      <div className="deck-grid">
        {decks.map((deck) => (
          <article
            className="panel"
            key={deck.id}
          >
            <h3>
              {deck.name}
            </h3>

            <div className="meta">
              {deck.format} ·
              Score{" "}
              {deck.score ?? "—"} ·{" "}
              {
                deckStats(deck)
                  .total
              }{" "}
              Karten
            </div>

            <p>
              MV{" "}
              {
                deckStats(deck)
                  .averageManaValue
              }{" "}
              · Länder{" "}
              {
                deckStats(deck)
                  .lands
              }
            </p>

            <div className="row">
              <button
                className="primary"
                onClick={() =>
                  setEditing(deck)
                }
              >
                Bearbeiten
              </button>

              <button
                className="secondary"
                onClick={() =>
                  download(
                    `${deck.name}.txt`,
                    deckText(deck)
                  )
                }
              >
                Export
              </button>

              <button
                className="danger ghost"
                onClick={() =>
                  onDelete(deck.id)
                }
              >
                Löschen
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function DeckEditor({
  deck,
  pool,
  onBack,
  onSave
}: {
  deck: DeckRecord;
  pool: CardRecord[];
  onBack: () => void;
  onSave:
    (deck: DeckRecord) =>
      Promise<void>;
}) {
  const [d, setD] =
    useState(deck);

  const all =
    [...d.cards];

  const availableCommanders =
    useMemo(
      () =>
        commanderCandidates(
          pool,
          COLORS
        ),
      [pool]
    );

  const selectedCommander =
    d.format === "commander"
      ? pool.find((card) =>
          d.commanderIds?.includes(
            card.id
          )
        )
      : undefined;

  const mainDeckCount =
    all.reduce(
      (sum, card) =>
        sum + card.count,
      0
    );

  const totalCards =
    mainDeckCount +
    (
      d.format === "commander" &&
      selectedCommander
        ? 1
        : 0
    );

  const commanderColorIdentity =
    selectedCommander
      ?.colorIdentity ?? [];

  const isCommanderColorLegal =
    (card: CardRecord) => {
      if (!selectedCommander) {
        return false;
      }

      return (
        card.colorIdentity ??
        []
      ).every((color) =>
        commanderColorIdentity.includes(
          color
        )
      );
    };

  const commanderLegalPool =
    d.format === "commander"
      ? pool.filter(
          (card) =>
            card.id !==
              selectedCommander?.id &&
            card.legalities
              ?.commander !==
              "banned" &&
            isCommanderColorLegal(
              card
            )
        )
      : pool;

  const illegalCommanderCards =
    d.format === "commander" &&
    selectedCommander
      ? all.filter(
          (deckCard) => {
            const source =
              pool.find(
                (card) =>
                  card.id ===
                  deckCard.id
              );

            if (!source) {
              return false;
            }

            return (
              source.legalities
                ?.commander ===
                "banned" ||
              !isCommanderColorLegal(
                source
              )
            );
          }
        )
      : [];

  const add =
    (card: CardRecord) => {
      setD((current) => ({
        ...current,

        cards:
          current.cards.some(
            (item) =>
              item.id ===
              card.id
          )
            ? current.cards.map(
                (item) =>
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
            : [
                ...current.cards,
                {
                  id: card.id,
                  name: card.name,
                  count: 1,
                  manaValue:
                    card.manaValue,
                  typeLine:
                    card.typeLine,
                  role: "Manuell",
                  reason:
                    "Manuell hinzugefügt",
                  available:
                    card.count
                }
              ]
      }));
    };

  const chooseCommander =
    (id: string) => {
      if (!id) {
        setD((current) => ({
          ...current,
          commanderIds: [],
          colors: []
        }));

        return;
      }

      const commander =
        pool.find(
          (card) =>
            card.id === id
        );

      if (!commander) {
        return;
      }

      setD((current) => ({
        ...current,
        commanderIds: [
          commander.id
        ],
        colors:
          commander.colorIdentity ??
          []
      }));
    };

  const changeFormat =
    (format: Format) => {
      setD((current) => ({
        ...current,
        format,
        commanderIds:
          format === "commander"
            ? current.commanderIds
            : []
      }));
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
          <h2>{d.name}</h2>

          <p className="muted">
            Manueller Deck-Editor ·{" "}
            {totalCards} Karten
          </p>
        </div>

        <button
          className="primary"
          onClick={() =>
            onSave({
              ...d,
              updatedAt:
                Date.now()
            })
          }
        >
          Speichern
        </button>
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
              onChange={(e) =>
                setD(
                  (current) => ({
                    ...current,
                    name:
                      e.target
                        .value
                  })
                )
              }
              placeholder="Name des Decks"
            />
          </label>

          <label>
            Format

            <select
              value={d.format}
              onChange={(e) =>
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
                selectedCommander
                  ?.id ?? ""
              }
              onChange={(e) =>
                chooseCommander(
                  e.target.value
                )
              }
            >
              <option value="">
                — Commander wählen —
              </option>

              {availableCommanders.map(
                (card) => (
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

        {d.format ===
          "commander" &&
          availableCommanders.length ===
            0 && (
            <div className="notice">
              In deiner Sammlung wurde
              aktuell keine Karte
              gefunden, die als
              Commander verwendet
              werden kann.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommander && (
            <div className="ai-box">
              <strong>
                Commander:
              </strong>{" "}
              {
                selectedCommander.name
              }

              <br />

              <span>
                Farbidentität:{" "}
                {commanderColorIdentity.length
                  ? commanderColorIdentity
                      .map(
                        (color) =>
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
                : "60"}
            </strong>

            <span>
              Deckgröße
            </span>
          </div>

          {d.format ===
            "commander" && (
            <div>
              <strong>
                {mainDeckCount}
              </strong>

              <span>
                Karten ohne
                Commander
              </span>
            </div>
          )}
        </div>

        {d.format ===
          "standard" &&
          totalCards < 60 && (
            <div className="notice">
              Für ein Standard-Deck
              fehlen aktuell noch{" "}
              {60 - totalCards}{" "}
              Karten.
            </div>
          )}

        {d.format ===
          "commander" &&
          !selectedCommander && (
            <div className="notice">
              Wähle zuerst einen
              Commander. Danach werden
              nur Karten angezeigt, die
              zu seiner Farbidentität
              passen.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommander &&
          totalCards < 100 && (
            <div className="notice">
              Für das Commander-Deck
              fehlen aktuell noch{" "}
              {100 - totalCards}{" "}
              Karten.
            </div>
          )}

        {d.format ===
          "standard" &&
          totalCards >= 60 && (
            <div className="ai-box">
              Die Mindestgröße von 60
              Karten ist erreicht.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommander &&
          totalCards === 100 && (
            <div className="ai-box">
              Die Deckgröße von 100
              Karten ist erreicht.
            </div>
          )}

        {d.format ===
          "commander" &&
          selectedCommander &&
          totalCards > 100 && (
            <div className="error">
              Das Deck enthält{" "}
              {totalCards} Karten. Ein
              Commander-Deck darf
              insgesamt nur 100 Karten
              enthalten.
            </div>
          )}

        {illegalCommanderCards.length >
          0 && (
          <div className="error">
            <strong>
              {
                illegalCommanderCards.length
              }{" "}
              Karten passen nicht zum
              ausgewählten Commander:
            </strong>

            <div>
              {illegalCommanderCards
                .map(
                  (card) =>
                    card.name
                )
                .join(", ")}
            </div>
          </div>
        )}
      </div>

      <div className="editor-grid">
        <div className="panel">
          <h3>
            {d.format ===
            "commander"
              ? `Deck · ${mainDeckCount}/99 Karten`
              : `Deck · ${totalCards} Karten`}
          </h3>

          {d.format ===
            "commander" &&
            selectedCommander && (
              <div className="commander-card">
                <strong>
                  Commander
                </strong>

                <span>
                  {
                    selectedCommander.name
                  }
                </span>

                <small>
                  {
                    selectedCommander.typeLine
                  }
                </small>
              </div>
            )}

          {all.length === 0 && (
            <p className="muted">
              Das Deck ist noch leer.
              Füge rechts Karten aus
              deiner Sammlung hinzu.
            </p>
          )}

          {all.map((card) => {
            const illegal =
              illegalCommanderCards.some(
                (item) =>
                  item.id ===
                  card.id
              );

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
                      {" "}
                      · nicht erlaubt
                    </small>
                  )}
                </span>

                <div>
                  <button
                    onClick={() =>
                      setD(
                        (current) => ({
                          ...current,

                          cards:
                            current.cards
                              .map(
                                (
                                  item
                                ) =>
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
                                (
                                  item
                                ) =>
                                  item.count >
                                  0
                              )
                        })
                      )
                    }
                  >
                    −
                  </button>

                  <button
                    onClick={() => {
                      const source =
                        pool.find(
                          (
                            item
                          ) =>
                            item.id ===
                            card.id
                        );

                      if (
                        source &&
                        card.count <
                          source.count
                      ) {
                        add(source);
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

          {d.format ===
            "commander" &&
          !selectedCommander ? (
            <p className="muted">
              Wähle zuerst einen
              Commander.
            </p>
          ) : (
            <>
              <input
                placeholder="Karte filtern…"
                onChange={(e) => {
                  const value =
                    e.target.value.toLowerCase();

                  document
                    .querySelectorAll<HTMLElement>(
                      "[data-card]"
                    )
                    .forEach(
                      (element) => {
                        element.hidden =
                          !element.dataset.card!.includes(
                            value
                          );
                      }
                    );
                }}
              />

              <div className="add-list">
                {commanderLegalPool
                  .slice(0, 200)
                  .map((card) => (
                    <div
                      data-card={card.name.toLowerCase()}
                      key={card.id}
                    >
                      <span>
                        {card.name}
                      </span>

                      <button
                        onClick={() =>
                          add(card)
                        }
                      >
                        +1
                      </button>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export default App;
