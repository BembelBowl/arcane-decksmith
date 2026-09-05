import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { User } from "firebase/auth";
import { subscribeAuth, login, logout, authMessage } from "./auth";
import { firebaseConfigured } from "./firebase";
import { loadCollection, loadDecks, removeCard, removeDeck, saveCard, saveDeck, uidFromEmail } from "./db";
import { autocomplete, getCard, getPrintings, imageFor, searchCards, scryfallUrl, normalizeCard, type ScryfallCard } from "./scryfall";
import { buildDeck, cardLegalForDeck, commanderCandidates, commanderColorIdentity, commanderPairCandidates, deckCopyLimit, deckStats } from "./deckBuilder";
import { deckText, download, parseList, toCsv } from "./importExport";
import { generateAiDeckExplanation, generateDeckExplanation } from "./ai";
import type { CardRecord, DeckRecord, Format, GroupBy, ViewMode } from "./types";
import "./styles.css";

const COLORS = ["W","U","B","R","G"];
const COLOR_NAMES: Record<string,string> = {W:"Weiß",U:"Blau",B:"Schwarz",R:"Rot",G:"Grün"};
const COLOR_ORDER = ["W","U","B","R","G"];
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

function colorGroupName(colors:string[]):string {
  if(!colors.length) {
    return "Farblos";
  }

  const ordered=COLOR_ORDER.filter(color=>colors.includes(color));

  return ordered
    .map(color=>COLOR_NAMES[color]??color)
    .join(" / ");
}

function primaryTypeGroup(typeLine:string|undefined):string {
  const type=(typeLine??"").toLowerCase();

  if(type.includes("land")) return "Land";
  if(type.includes("creature")) return "Kreatur";
  if(type.includes("planeswalker")) return "Planeswalker";
  if(type.includes("instant")) return "Spontanzauber";
  if(type.includes("sorcery")) return "Hexerei";
  if(type.includes("enchantment")) return "Verzauberung";
  if(type.includes("artifact")) return "Artefakt";
  if(type.includes("battle")) return "Schlacht";

  return "Sonstiges";
}

function compareGroupNames(a:string,b:string,group:GroupBy):number {
  if(group==="manaValue") {
    const av=Number(a.replace("MV ",""));
    const bv=Number(b.replace("MV ",""));

    return av-bv;
  }

  if(group==="type") {
    const ai=TYPE_ORDER.indexOf(a);
    const bi=TYPE_ORDER.indexOf(b);

    return (ai===-1?999:ai)-(bi===-1?999:bi);
  }

  if(group==="color") {
    if(a==="Farblos"&&b!=="Farblos") return -1;
    if(b==="Farblos"&&a!=="Farblos") return 1;

    const ac=a.split(" / ").length;
    const bc=b.split(" / ").length;

    if(ac!==bc) return ac-bc;
  }

  return a.localeCompare(b,"de",{numeric:true,sensitivity:"base"});
}

function App() {
  const [auth, setAuth] = useState<{user: User|null; loading: boolean}>({user:null,loading:true});
  const [demoEmail, setDemoEmail] = useState("");
  const [demoMode, setDemoMode] = useState(false);

  useEffect(() => subscribeAuth(setAuth), []);

  if (auth.loading) {
    return <div className="splash">Arcane Decksmith wird geladen…</div>;
  }

  if (!auth.user && !demoMode) {
    return (
      <Auth
        onDemo={(email)=>{
          setDemoEmail(email);
          setDemoMode(true);
        }}
      />
    );
  }

  const uid = auth.user?.uid ?? uidFromEmail(demoEmail);

  return (
    <Main
      user={auth.user}
      uid={uid}
      demoMode={demoMode}
      onExitDemo={()=>setDemoMode(false)}
    />
  );
}

function Auth({onDemo}:{onDemo:(email:string)=>void}) {
  const [email,setEmail]=useState("");
  const [pw,setPw]=useState("");
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState("");

  const submit=async()=>{
    setBusy(true);
    setMsg("");

    try {
      await login(email,pw);
    } catch(e:any) {
      setMsg(authMessage(e?.code??""));
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

        {!firebaseConfigured &&
          <div className="notice">
            Firebase ist noch nicht konfiguriert. Du kannst den lokalen Demo-Modus verwenden.
          </div>
        }

        <label>
          E-Mail
          <input
            value={email}
            onChange={e=>setEmail(e.target.value)}
            type="email"
            autoComplete="email"
          />
        </label>

        <label>
          Passwort
          <input
            value={pw}
            onChange={e=>setPw(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </label>

        {msg&&<div className="error">{msg}</div>}

        <button
          className="primary full"
          disabled={busy||!email||!pw}
          onClick={submit}
        >
          {busy?"…":"Anmelden"}
        </button>

        <div className="divider">oder</div>

        <button
          className="secondary full"
          onClick={()=>onDemo(email||"demo@example.com")}
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
}:{
  user:User|null;
  uid:string;
  demoMode:boolean;
  onExitDemo:()=>void;
}) {
  const [collection,setCollection]=useState<CardRecord[]>([]);
  const [decks,setDecks]=useState<DeckRecord[]>([]);
  const [page,setPage]=useState<"collection"|"search"|"builder"|"decks">("collection");
  const [busy,setBusy]=useState(true);
  const [toast,setToast]=useState("");

  useEffect(()=>{
    void (async()=>{
      setBusy(true);

      try {
        const loadedCollection=await loadCollection(uid);
        const loadedDecks=await loadDecks(uid);

        setCollection(loadedCollection);
        setDecks(loadedDecks);

        const cardsWithoutSetName=loadedCollection.filter(card=>!card.setName);

        if(cardsWithoutSetName.length>0){
          void (async()=>{
            const refreshed=[...loadedCollection];
            let changed=false;

            for(const card of cardsWithoutSetName){
              try{
                const fresh=await getCard(card.id);
                const index=refreshed.findIndex(item=>item.id===card.id);

                if(index!==-1&&fresh.setName){
                  refreshed[index]={
                    ...refreshed[index],
                    setName:fresh.setName
                  };

                  await saveCard(uid,refreshed[index]);
                  changed=true;
                }
              }catch{
                // Fehlende Setnamen werden beim nächsten Laden erneut versucht.
              }
            }

            if(changed){
              setCollection(refreshed);
            }
          })();
        }
      } finally {
        setBusy(false);
      }
    })();
  },[uid]);

  const persistCard=async(c:CardRecord)=>{
    await saveCard(uid,c);
    setCollection(await loadCollection(uid));
  };

  const persistDeck=async(d:DeckRecord)=>{
    await saveDeck(uid,d);
    setDecks(await loadDecks(uid));
    setPage("decks");
    setToast("Deck gespeichert.");
    setTimeout(()=>setToast(""),2200);
  };

  const delCard=async(id:string)=>{
    await removeCard(uid,id);
    setCollection(await loadCollection(uid));
  };

  const delDeck=async(id:string)=>{
    await removeDeck(uid,id);
    setDecks(await loadDecks(uid));
  };

  return (
    <div className="app">
      <header className="topbar">
        <button
          className="logo"
          onClick={()=>setPage("collection")}
        >
          <img
            src="./ad_logo.png"
            alt="Arcane Decksmith Logo"
          />
          Arcane Decksmith
        </button>

        <nav>
          {(["collection","search","builder","decks"] as const).map(p=>
            <button
              key={p}
              className={page===p?"nav active":"nav"}
              onClick={()=>setPage(p)}
            >
              {p==="collection"
                ?"Sammlung"
                :p==="search"
                  ?"Kartensuche"
                  :p==="builder"
                    ?"Deck bauen"
                    :"Decks"
              }
            </button>
          )}
        </nav>

        <div className="userbox">
          <span>{demoMode?"Demo":user?.email}</span>

          <button onClick={demoMode?onExitDemo:logout}>
            Abmelden
          </button>
        </div>
      </header>

      {toast&&<div className="toast">{toast}</div>}

      <main>
        {busy
          ? <div className="loading">Daten werden geladen…</div>

          : page==="collection"
            ? <Collection
                cards={collection}
                onChange={persistCard}
                onDelete={delCard}
                onImport={async(next)=>{
                  for(const c of next){
                    await saveCard(uid,c);
                  }

                  setCollection(await loadCollection(uid));
                }}
              />

          : page==="search"
            ? <Search
                onAdd={async(c)=>{
                  const existing=collection.find(x=>x.id===c.id);

                  await persistCard(
                    existing
                      ? {
                          ...existing,
                          count:existing.count+1,
                          updatedAt:Date.now()
                        }
                      : {
                          ...normalizeCard(c),
                          count:1
                        }
                  );

                  setToast(
                    existing
                      ? `${c.name}: Anzahl auf ${existing.count+1} erhöht.`
                      : `${c.name} wurde zur Sammlung hinzugefügt.`
                  );

                  setTimeout(()=>setToast(""),2200);
                }}
              />

          : page==="builder"
            ? <Builder
                pool={collection}
                onSave={persistDeck}
                demoMode={demoMode}
              />

            : <Decks
                decks={decks}
                pool={collection}
                onDelete={delDeck}
                onSave={persistDeck}
              />
        }
      </main>

      <footer>
        Scryfall-Daten & Bilder werden direkt von Scryfall geladen.
        Keine Kaufentscheidung aufgrund von Preisen.
      </footer>
    </div>
  );
}

function Search({onAdd}:{onAdd:(c:ScryfallCard)=>Promise<void>}) {
  const [q,setQ]=useState("");
  const [results,setResults]=useState<ScryfallCard[]>([]);
  const [suggestions,setSuggestions]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{
    const t=setTimeout(()=>{
      if(q.length>=2) {
        void autocomplete(q)
          .then(setSuggestions)
          .catch(()=>setSuggestions([]));
      } else {
        setSuggestions([]);
      }
    },300);

    return()=>clearTimeout(t);
  },[q]);

  const go=async()=>{
    setBusy(true);

    try {
      setResults(await searchCards(q));
    } catch(e:any) {
      alert(e.message);
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
            Scryfall-Suche mit lokalem Sitzungscache.
          </p>
        </div>
      </div>

      <div className="searchbar">
        <input
          value={q}
          onChange={e=>setQ(e.target.value)}
          onKeyDown={e=>e.key==="Enter"&&void go()}
          placeholder="z. B. Lightning Bolt"
        />

        <button
          className="primary"
          onClick={go}
        >
          Suchen
        </button>
      </div>

      {suggestions.length>0&&
        <div className="suggestions">
          {suggestions.map(s=>
            <button
              key={s}
              onClick={()=>{
                setQ(s);
                setSuggestions([]);
              }}
            >
              {s}
            </button>
          )}
        </div>
      }

      {busy
        ? <div className="loading">
            Scryfall fragt Karten ab…
          </div>

        : <div className="card-grid">
            {results.map(c=>
              <SearchCard
                key={c.id}
                card={c}
                onAdd={onAdd}
              />
            )}
          </div>
      }
    </section>
  );
}

function SearchCard({
  card,
  onAdd
}:{
  card:ScryfallCard;
  onAdd:(card:ScryfallCard)=>void|Promise<void>;
}) {
  const [selectedCard,setSelectedCard]=useState<ScryfallCard>(card);
  const [printings,setPrintings]=useState<ScryfallCard[]>([]);
  const [showPrintings,setShowPrintings]=useState(false);
  const [loadingPrintings,setLoadingPrintings]=useState(false);
  const [printingError,setPrintingError]=useState("");

  useEffect(()=>{
    setSelectedCard(card);
    setPrintings([]);
    setShowPrintings(false);
    setPrintingError("");
  },[card.id]);

  const loadPrintings=async()=>{
    if(showPrintings){
      setShowPrintings(false);
      return;
    }

    setShowPrintings(true);

    if(printings.length>0) {
      return;
    }

    setLoadingPrintings(true);
    setPrintingError("");

    try{
      const variants=await getPrintings(card);
      setPrintings(variants);
    }catch{
      setPrintingError(
        "Die Varianten konnten nicht von Scryfall geladen werden."
      );
    }finally{
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
        <h3>{selectedCard.name}</h3>

        <div className="meta">
          {selectedCard.mana_cost??"—"} · MV {selectedCard.cmc??0} ·{" "}
          {selectedCard.set.toUpperCase()} #{selectedCard.collector_number}
        </div>

        {selectedCard.set_name&&
          <div className="meta">
            {selectedCard.set_name}
          </div>
        }

        <p>{selectedCard.type_line}</p>

        <p className="oracle">
          {selectedCard.oracle_text??
            selectedCard.card_faces
              ?.map(f=>f.oracle_text)
              .filter(Boolean)
              .join(" / ")
          }
        </p>

        <div className="variant-actions">
          <button
            className="secondary"
            onClick={loadPrintings}
            disabled={loadingPrintings}
          >
            {loadingPrintings
              ?"Varianten werden geladen…"
              :showPrintings
                ?"Varianten schließen"
                :"Varianten / Drucke"
            }
          </button>
        </div>

        {showPrintings&&
          <div className="variant-box">
            {printingError&&
              <div className="error">{printingError}</div>
            }

            {!printingError&&loadingPrintings&&
              <div className="muted">
                Scryfall lädt verfügbare Drucke…
              </div>
            }

            {!loadingPrintings&&printings.length>0&&
              <>
                <div className="variant-field">
                  <label htmlFor={`variant-${card.id}`}>
                    Ausgabe auswählen
                  </label>

                  <select
                    id={`variant-${card.id}`}
                    className="variant-select"
                    value={selectedCard.id}
                    onChange={e=>{
                      const chosen=printings.find(
                        p=>p.id===e.target.value
                      );

                      if(chosen) {
                        setSelectedCard(chosen);
                      }
                    }}
                  >
                    {printings.map(p=>
                      <option
                        key={p.id}
                        value={p.id}
                      >
                        {(p.set_name??p.set)}
                        {" · #"}
                        {p.collector_number}
                        {p.lang&&p.lang!=="en"
                          ?` · ${p.lang.toUpperCase()}`
                          :""
                        }
                      </option>
                    )}
                  </select>
                </div>

                <div className="variant-info">
                  <div className="variant-info-title">
                    Gewählte Ausgabe
                  </div>

                  <div className="variant-info-row">
                    <span>Set</span>
                    <strong>
                      {selectedCard.set_name??selectedCard.set.toUpperCase()}
                    </strong>
                  </div>

                  <div className="variant-info-row">
                    <span>Collector-Nr.</span>
                    <strong>{selectedCard.collector_number}</strong>
                  </div>

                  {selectedCard.lang&&
                    <div className="variant-info-row">
                      <span>Sprache</span>
                      <strong>{selectedCard.lang.toUpperCase()}</strong>
                    </div>
                  }

                  {selectedCard.rarity&&
                    <div className="variant-info-row">
                      <span>Seltenheit</span>
                      <strong>{selectedCard.rarity}</strong>
                    </div>
                  }
                </div>
              </>
            }
          </div>
        }

        <div className="row search-card-actions">
          <button
            className="primary"
            onClick={()=>onAdd(selectedCard)}
          >
            + Sammlung
          </button>

          <a
            href={scryfallUrl(selectedCard.id)}
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
}:{
  cards:CardRecord[];
  onChange:(c:CardRecord)=>Promise<void>;
  onDelete:(id:string)=>Promise<void>;
  onImport:(c:CardRecord[])=>Promise<void>;
}) {
  const [query,setQuery]=useState("");
  const [group,setGroup]=useState<GroupBy>("none");
  const [view,setView]=useState<ViewMode>("grid");
  const [sort,setSort]=useState("name");
  const [selected,setSelected]=useState<Set<string>>(new Set());
  const [importText,setImportText]=useState("");
  const [showImport,setShowImport]=useState(false);

  const filtered=useMemo(
    ()=>cards
      .filter(c=>
        `${c.name} ${c.set} ${c.setName??""} ${c.typeLine} ${c.oracleText}`
          .toLowerCase()
          .includes(query.toLowerCase())
      )
      .sort((a,b)=>
        sort==="mv"
          ?a.manaValue-b.manaValue
          :sort==="count"
            ?b.count-a.count
            :a.name.localeCompare(b.name)
      ),
    [cards,query,sort]
  );

  const total=cards.reduce((n,c)=>n+c.count,0);

  const groups=useMemo(()=>{
    if(group==="none") {
      return [["Alle",filtered]] as Array<[string,CardRecord[]]>;
    }

    const grouped=filtered.reduce<Record<string,CardRecord[]>>((acc,card)=>{
      const key=
        group==="color"
          ?colorGroupName(card.colors)
          :group==="type"
            ?primaryTypeGroup(card.typeLine)
            :group==="set"
              ?(card.setName??card.set.toUpperCase())
              :`MV ${card.manaValue}`;

      (acc[key]??=[]).push(card);
      return acc;
    },{});

    return Object.entries(grouped).sort(([a],[b])=>
      compareGroupNames(a,b,group)
    );
  },[filtered,group]);

  const importList=async()=>{
    const rows=parseList(importText);
    const out=[...cards];

    for(const r of rows){
      try{
        const matches=await searchCards(r.name);
        const c=matches[0];

        if(!c) {
          continue;
        }

        const n=normalizeCard(c,r.count);
        const old=out.find(x=>x.id===n.id);

        if(old) {
          old.count+=r.count;
        } else {
          out.push(n);
        }
      }catch{
        // Fehlerhafte Importzeile überspringen.
      }
    }

    await onImport(out);

    setImportText("");
    setShowImport(false);
  };

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
            onClick={()=>download(
              "collection.json",
              JSON.stringify(cards,null,2),
              "application/json"
            )}
          >
            JSON export
          </button>

          <button
            className="secondary"
            onClick={()=>download(
              "collection.csv",
              toCsv(cards),
              "text/csv;charset=utf-8"
            )}
          >
            CSV export
          </button>

          <button
            className="primary"
            onClick={()=>setShowImport(!showImport)}
          >
            Import
          </button>
        </div>
      </div>

      {showImport&&
        <div className="panel">
          <h3>Textimport</h3>

          <textarea
            value={importText}
            onChange={e=>setImportText(e.target.value)}
            placeholder={"4 Lightning Bolt\n2x Counterspell\n1 Sol Ring"}
            rows={6}
          />

          <div className="row">
            <button
              className="primary"
              onClick={importList}
            >
              Import prüfen & übernehmen
            </button>

            <button
              className="secondary"
              onClick={()=>setShowImport(false)}
            >
              Abbrechen
            </button>
          </div>
        </div>
      }

      <div className="toolbar">
        <input
          value={query}
          onChange={e=>setQuery(e.target.value)}
          placeholder="Sammlung durchsuchen…"
        />

        <select
          value={sort}
          onChange={e=>setSort(e.target.value)}
        >
          <option value="name">Name</option>
          <option value="mv">Mana Value</option>
          <option value="count">Anzahl</option>
        </select>

        <select
          value={group}
          onChange={e=>setGroup(e.target.value as GroupBy)}
        >
          <option value="none">Keine Gruppierung</option>
          <option value="color">Farbe</option>
          <option value="type">Typ</option>
          <option value="set">Set</option>
          <option value="manaValue">Mana Value</option>
        </select>

        <button
          className="secondary"
          onClick={()=>setView(view==="grid"?"list":"grid")}
        >
          {view==="grid"?"Listenansicht":"Kartenansicht"}
        </button>
      </div>

      {groups.map(([name,list])=>
        <div key={name}>
          <h3 className="group-title">{name}</h3>

          <div className={view==="grid"?"card-grid":"list-view"}>
            {list.map(c=>
              <CollectionCard
                key={c.id}
                card={c}
                selected={selected.has(c.id)}
                toggle={()=>
                  setSelected(s=>{
                    const n=new Set(s);

                    if(n.has(c.id)){
                      n.delete(c.id);
                    }else{
                      n.add(c.id);
                    }

                    return n;
                  })
                }
                onChange={onChange}
                onDelete={onDelete}
              />
            )}
          </div>
        </div>
      )}

      {selected.size>0&&
        <div className="bulkbar">
          {selected.size} ausgewählt

          <button
            onClick={async()=>{
              for(const id of selected){
                await onDelete(id);
              }

              setSelected(new Set());
            }}
          >
            Ausgewählte löschen
          </button>
        </div>
      }
    </section>
  );
}

function CollectionCard({
  card,
  selected,
  toggle,
  onChange,
  onDelete
}:{
  card:CardRecord;
  selected:boolean;
  toggle:()=>void;
  onChange:(c:CardRecord)=>Promise<void>;
  onDelete:(id:string)=>Promise<void>;
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

      {card.imageUri&&
        <img
          src={card.imageUri}
          alt=""
          loading="lazy"
        />
      }

      <div className="card-body">
        <h3>{card.name}</h3>

        <div className="meta">
          {card.setName??card.set.toUpperCase()} · #{card.collectorNumber} · MV {card.manaValue}
        </div>

        <p>{card.typeLine}</p>

        <div className="quantity">
          <button
            onClick={()=>onChange({
              ...card,
              count:Math.max(1,card.count-1),
              updatedAt:Date.now()
            })}
          >
            −
          </button>

          <strong>{card.count}</strong>

          <button
            onClick={()=>onChange({
              ...card,
              count:card.count+1,
              updatedAt:Date.now()
            })}
          >
            +
          </button>

          <button
            className="danger ghost"
            onClick={()=>onDelete(card.id)}
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
}:{
  pool:CardRecord[];
  onSave:(d:DeckRecord)=>Promise<void>;
  demoMode:boolean;
}) {
  const [format,setFormat]=useState<Format>("commander");
  const [colors,setColors]=useState<string[]>([...COLORS]);
  const [commanderId,setCommanderId]=useState("");
  const [secondCommanderId,setSecondCommanderId]=useState("");
  const [target,setTarget]=useState(3);
  const [min,setMin]=useState(0);
  const [max,setMax]=useState(15);
  const [name,setName]=useState("Neues Deck");
  const [result,setResult]=useState<DeckRecord|null>(null);
  const [analysisText,setAnalysisText]=useState("");
  const [aiBusy,setAiBusy]=useState(false);

  const commanders=useMemo(
    ()=>commanderCandidates(pool),
    [pool]
  );

  const primaryCommander=useMemo(
    ()=>commanders.find(card=>card.id===commanderId),
    [commanders,commanderId]
  );

  const secondCommanderOptions=useMemo(
    ()=>primaryCommander
      ?commanderPairCandidates(pool,primaryCommander)
      :[],
    [pool,primaryCommander]
  );

  const secondCommander=useMemo(
    ()=>secondCommanderOptions.find(
      card=>card.id===secondCommanderId
    ),
    [secondCommanderOptions,secondCommanderId]
  );

  const selectedCommanders=useMemo(
    ()=>[
      primaryCommander,
      secondCommander
    ].filter(
      (card):card is CardRecord=>Boolean(card)
    ),
    [primaryCommander,secondCommander]
  );

  const activeColors=
    format==="commander"
      ?commanderColorIdentity(selectedCommanders)
      :colors;

  useEffect(()=>{
    if(
      secondCommanderId &&
      !secondCommanderOptions.some(
        card=>card.id===secondCommanderId
      )
    ){
      setSecondCommanderId("");
    }
  },[
    secondCommanderId,
    secondCommanderOptions
  ]);

  const changeFormat=(next:Format)=>{
    setFormat(next);
    setResult(null);
    setAnalysisText("");

    if(next==="standard"){
      setCommanderId("");
      setSecondCommanderId("");
    }
  };

  const chooseCommander=(id:string)=>{
    setCommanderId(id);
    setSecondCommanderId("");
    setResult(null);
    setAnalysisText("");
  };

  const chooseSecondCommander=(id:string)=>{
    setSecondCommanderId(id);
    setResult(null);
    setAnalysisText("");
  };

  const build=()=>{
    const deck=buildDeck(pool,{
      name,
      format,
      colors:activeColors,
      commanders:
        format==="commander"
          ?selectedCommanders
          :undefined,
      targetManaValue:target,
      minManaValue:min,
      maxManaValue:max
    });

    setResult(deck);
    setAnalysisText("");
  };

  const explain=async()=>{
    if(
      !result ||
      result.cards.length===0
    ) {
      return;
    }

    setAiBusy(true);
    setAnalysisText("");

    try {
      const text=await generateAiDeckExplanation(result);
      setAnalysisText(text);
    } catch(error) {
      console.error(
        "KI-Analyse fehlgeschlagen:",
        error
      );

      const fallback=generateDeckExplanation(result);

      const errorMessage=
        error instanceof Error
          ?error.message
          :"Unbekannter Fehler bei der KI-Analyse.";

      setAnalysisText(
        fallback+
        "\n\n---\n\n"+
        "### ⚠️ Generative KI nicht verfügbar\n\n"+
        errorMessage+
        "\n\nDie lokale Deckanalyse wird deshalb als Fallback angezeigt."
      );
    } finally {
      setAiBusy(false);
    }
  };

  const resultHasCards=
    (result?.cards.reduce(
      (sum,card)=>sum+card.count,
      0
    )??0)>0;

  const builderDisabled=
    pool.length===0 ||
    (
      format==="commander"
        ?selectedCommanders.length===0
        :colors.length===0
    ) ||
    min>max;

  return (
    <section>
      <div className="pagehead">
        <div>
          <h2>Deck automatisch bauen</h2>

          <p className="muted">
            Der Optimierer verwendet ausschließlich Karten aus deiner Sammlung und erklärt jede Auswahl.
          </p>
        </div>
      </div>

      <div className="builder-grid">
        <div className="panel">
          <label>
            Name

            <input
              value={name}
              onChange={e=>setName(e.target.value)}
            />
          </label>

          <label>
            Format

            <select
              value={format}
              onChange={e=>changeFormat(e.target.value as Format)}
            >
              <option value="commander">Commander</option>
              <option value="standard">Standard</option>
            </select>
          </label>

          {format==="standard"
            ? <label>
                Deckfarben

                <div className="color-pills">
                  {COLORS.map(color=>
                    <button
                      key={color}
                      type="button"
                      className={
                        colors.includes(color)
                          ?"color active"
                          :"color"
                      }
                      onClick={()=>setColors(current=>
                        current.includes(color)
                          ?current.filter(value=>value!==color)
                          :[
                              ...current,
                              color
                            ]
                      )}
                    >
                      {color}
                      <span>{COLOR_NAMES[color]}</span>
                    </button>
                  )}
                </div>

                <small className="muted">
                  Die Farbauswahl ist hier ein Filter für den automatischen Builder.
                  Sie ist keine zusätzliche Standard-Legalitätsregel.
                </small>
              </label>

            : <>
                <label>
                  Commander

                  <select
                    value={commanderId}
                    onChange={e=>chooseCommander(e.target.value)}
                  >
                    <option value="">
                      — Commander wählen —
                    </option>

                    {commanders.map(card=>
                      <option
                        key={card.id}
                        value={card.id}
                      >
                        {card.name}
                      </option>
                    )}
                  </select>
                </label>

                {primaryCommander&&
                  secondCommanderOptions.length>0&&
                  <label>
                    Zweiter Commander (optional)

                    <select
                      value={secondCommanderId}
                      onChange={e=>chooseSecondCommander(e.target.value)}
                    >
                      <option value="">
                        — kein zweiter Commander —
                      </option>

                      {secondCommanderOptions.map(card=>
                        <option
                          key={card.id}
                          value={card.id}
                        >
                          {card.name}
                        </option>
                      )}
                    </select>

                    <small className="muted">
                      Unterstützt werden Partner, Partner with,
                      Friends forever, Doctor&apos;s Companion und Background.
                    </small>
                  </label>
                }

                {primaryCommander&&
                  <div className="ai-box">
                    <strong>
                      Farbidentität automatisch:
                    </strong>{" "}

                    {activeColors.length
                      ?activeColors
                          .map(color=>COLOR_NAMES[color]??color)
                          .join(", ")
                      :"Farblos"
                    }

                    {secondCommander&&
                      <>
                        <br />
                        <span>
                          Zwei Commander: {primaryCommander.name} + {secondCommander.name}
                        </span>
                      </>
                    }
                  </div>
                }
              </>
          }

          <label>
            Ziel-Mana Value: <strong>{target.toFixed(1)}</strong>

            <input
              type="range"
              min="0"
              max="15"
              step="0.1"
              value={target}
              onChange={e=>setTarget(Number(e.target.value))}
            />
          </label>

          <label>
            Minimum Mana Value: <strong>{min.toFixed(1)}</strong>

            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={min}
              onChange={e=>setMin(Number(e.target.value))}
            />
          </label>

          <label>
            Maximum Mana Value: <strong>{max.toFixed(1)}</strong>

            <input
              type="range"
              min="0"
              max="15"
              step="0.5"
              value={max}
              onChange={e=>setMax(Number(e.target.value))}
            />
          </label>

          {min>max&&
            <div className="error">
              Minimum Mana Value darf nicht größer als Maximum Mana Value sein.
            </div>
          }

          <button
            className="primary full"
            onClick={build}
            disabled={builderDisabled}
          >
            Deck erstellen
          </button>

          {pool.length===0&&
            <div className="notice">
              Deine Sammlung ist leer. Füge zuerst Karten über die Kartensuche hinzu.
            </div>
          }

          {format==="commander"&&
            pool.length>0&&
            commanders.length===0&&
            <div className="notice">
              In deiner Sammlung wurde aktuell kein Commander-Kandidat gefunden.
            </div>
          }

          {format==="commander"&&
            commanders.length>0&&
            !primaryCommander&&
            <div className="notice">
              Wähle zuerst einen Commander. Seine Farbidentität wird automatisch für den Deckbau verwendet.
            </div>
          }
        </div>

        {result
          ? <div className="panel">
              <h3>{result.name}</h3>

              <div className="stats">
                <div>
                  <strong>{deckStats(result).total}</strong>
                  <span>Karten gesamt</span>
                </div>

                <div>
                  <strong>{deckStats(result).lands}</strong>
                  <span>Länder</span>
                </div>

                <div>
                  <strong>{deckStats(result).nonland}</strong>
                  <span>Nichtländer</span>
                </div>

                <div>
                  <strong>{deckStats(result).averageManaValue}</strong>
                  <span>Ø Mana Value</span>
                </div>
              </div>

              <p>{result.notes}</p>

              {result.format==="commander"&&
                result.commanderIds.length>0&&
                <div className="commander-card">
                  <strong>
                    {result.commanderIds.length===1
                      ?"Commander"
                      :"Commander"
                    }
                  </strong>

                  {result.commanderIds.map(id=>{
                    const commander=pool.find(card=>card.id===id);

                    return commander
                      ? <span key={id}>
                          {commander.name}
                        </span>
                      : null;
                  })}
                </div>
              }

              <div className="role-list">
                {Object.entries(deckStats(result).roleCounts).map(([role,count])=>
                  <span key={role}>
                    {role}: {count}
                  </span>
                )}
              </div>

              <div className="deck-list">
                {result.cards.map(card=>
                  <div key={card.id}>
                    <span>
                      <b>{card.count}×</b> {card.name}
                    </span>

                    <small>
                      {card.role} · {card.reason}
                    </small>
                  </div>
                )}
              </div>

              {!resultHasCards&&
                <div className="notice">
                  Es wurden keine passenden Karten für das Hauptdeck gefunden.
                  Speichern, Export und Analyse sind deshalb deaktiviert.
                </div>
              }

              <div className="row">
                <button
                  className="primary"
                  onClick={()=>onSave(result)}
                  disabled={!resultHasCards}
                >
                  Deck speichern
                </button>

                <button
                  className="secondary"
                  onClick={()=>download(
                    `${result.name}.txt`,
                    deckText(result)
                  )}
                  disabled={!resultHasCards}
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
                      ?"Die generative KI benötigt eine Firebase-Anmeldung."
                      :!resultHasCards
                        ?"Für ein leeres Deck ist keine Analyse sinnvoll."
                        :undefined
                  }
                >
                  {aiBusy
                    ?"KI analysiert…"
                    :"Deck analysieren"
                  }
                </button>
              </div>

              {analysisText&&
                <div className="ai-box analysis-box markdown-content">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                  >
                    {analysisText}
                  </ReactMarkdown>
                </div>
              }
            </div>

          : <div className="panel empty">
              <h3>Vorschau</h3>

              <p>
                Hier erscheinen Deckgröße, Mana-Kurve, Rollen und Auswahlbegründungen.
              </p>
            </div>
        }
      </div>
    </section>
  );
}

function Decks({
  decks,
  pool,
  onDelete,
  onSave
}:{
  decks:DeckRecord[];
  pool:CardRecord[];
  onDelete:(id:string)=>Promise<void>;
  onSave:(d:DeckRecord)=>Promise<void>;
}) {
  const [editing,setEditing]=useState<DeckRecord|null>(null);
  const [importText,setImportText]=useState("");
  const [showImport,setShowImport]=useState(false);

  const newManualDeck=()=>{
    const now=Date.now();

    const deck:DeckRecord={
      id:crypto.randomUUID(),
      name:"Neues manuelles Deck",
      format:"standard",
      commanderIds:[],
      cards:[],
      sideboard:[],
      colors:[],
      createdAt:now,
      updatedAt:now,
      notes:"Manuell zusammengestelltes Deck."
    };

    setEditing(deck);
  };

  const importDeck=async()=>{
    const rows=parseList(importText);
    const cards:DeckRecord["cards"]=[];

    for(const r of rows){
      const hit=
        pool.find(
          c=>c.name.toLowerCase()===r.name.toLowerCase()
        ) ??
        pool.find(
          c=>c.name.toLowerCase().includes(r.name.toLowerCase())
        );

      if(hit){
        cards.push({
          id:hit.id,
          name:hit.name,
          count:Math.min(r.count,hit.count),
          manaValue:hit.manaValue,
          typeLine:hit.typeLine,
          role:"Import",
          reason:"Aus Deckliste importiert.",
          available:hit.count
        });
      }
    }

    const d:DeckRecord={
      id:crypto.randomUUID(),
      name:"Importiertes Deck",
      format:"standard",
      commanderIds:[],
      cards,
      sideboard:[],
      colors:[],
      createdAt:Date.now(),
      updatedAt:Date.now(),
      notes:"Importierte Deckliste; bitte Format und Legalität im Editor prüfen."
    };

    if(cards.length){
      await onSave(d);
    }

    setImportText("");
    setShowImport(false);
  };

  if(editing){
    return (
      <DeckEditor
        deck={editing}
        pool={pool}
        onBack={()=>setEditing(null)}
        onSave={async d=>{
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
          <h2>Gespeicherte Decks</h2>

          <p className="muted">
            {decks.length} Decks
          </p>
        </div>

        <div className="row">
          <button
            className="primary"
            onClick={newManualDeck}
          >
            + Deck manuell erstellen
          </button>

          <button
            className="secondary"
            onClick={()=>setShowImport(!showImport)}
          >
            Deckliste importieren
          </button>
        </div>
      </div>

      {showImport&&
        <div className="panel">
          <h3>Deckliste importieren</h3>

          <p className="muted">
            Format: „4 Lightning Bolt“. Die Karten werden gegen deine Sammlung aufgelöst.
          </p>

          <textarea
            value={importText}
            onChange={e=>setImportText(e.target.value)}
            rows={8}
            placeholder={"4 Lightning Bolt\n4 Counterspell\n20 Island"}
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
              onClick={()=>setShowImport(false)}
            >
              Abbrechen
            </button>
          </div>
        </div>
      }

      <div className="deck-grid">
        {decks.map(d=>
          <article
            className="panel"
            key={d.id}
          >
            <h3>{d.name}</h3>

            <div className="meta">
              {d.format} · Score {d.score??"—"} · {deckStats(d).total} Karten
            </div>

            <p>
              MV {deckStats(d).averageManaValue} · Länder {deckStats(d).lands}
            </p>

            <div className="row">
              <button
                className="primary"
                onClick={()=>setEditing(d)}
              >
                Bearbeiten
              </button>

              <button
                className="secondary"
                onClick={()=>download(`${d.name}.txt`,deckText(d))}
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
        )}
      </div>
    </section>
  );
}

function DeckEditor({
  deck,
  pool,
  onBack,
  onSave
}:{
  deck:DeckRecord;
  pool:CardRecord[];
  onBack:()=>void;
  onSave:(d:DeckRecord)=>Promise<void>;
}) {
  const [d,setD]=useState(deck);

  const all=[...d.cards];

  const availableCommanders=useMemo(
    ()=>commanderCandidates(pool),
    [pool]
  );

  const selectedCommanders=useMemo(
    ()=>d.format==="commander"
      ?d.commanderIds
          .map(id=>pool.find(card=>card.id===id))
          .filter(
            (card):card is CardRecord=>Boolean(card)
          )
          .slice(0,2)
      :[],
    [d.commanderIds,d.format,pool]
  );

  const primaryCommander=
    selectedCommanders[0];

  const secondCommander=
    selectedCommanders[1];

  const secondCommanderOptions=useMemo(
    ()=>primaryCommander
      ?commanderPairCandidates(pool,primaryCommander)
      :[],
    [pool,primaryCommander]
  );

  const commanderColors=
    commanderColorIdentity(selectedCommanders);

  const mainDeckCount=
    all.reduce(
      (sum,card)=>sum+card.count,
      0
    );

  const commanderCount=
    d.format==="commander"
      ?selectedCommanders.length
      :0;

  const totalCards=
    mainDeckCount+commanderCount;

  const commanderMainTarget=
    100-Math.max(1,commanderCount);

  const isSourceLegal=(card:CardRecord)=>{
    if(d.format==="standard"){
      return cardLegalForDeck(
        card,
        "standard"
      );
    }

    if(selectedCommanders.length===0){
      return false;
    }

    return (
      !d.commanderIds.includes(card.id) &&
      cardLegalForDeck(
        card,
        "commander",
        commanderColors
      )
    );
  };

  const legalPool=
    pool.filter(isSourceLegal);

  const illegalCards=
    all.filter(deckCard=>{
      const source=pool.find(
        card=>card.id===deckCard.id
      );

      return source
        ?!isSourceLegal(source)
        :true;
    });

  const deckCountByName=
    all.reduce<Record<string,number>>(
      (counts,card)=>{
        const key=card.name.toLowerCase();

        counts[key]=
          (counts[key]??0)+
          card.count;

        return counts;
      },
      {}
    );

  const copyViolationNames=
    Array.from(
      new Set(
        all
          .filter(deckCard=>{
            const source=pool.find(
              card=>card.id===deckCard.id
            );

            if(!source){
              return false;
            }

            const ruleLimit=
              deckCopyLimit(
                source,
                d.format
              );

            const totalByName=
              deckCountByName[
                deckCard.name.toLowerCase()
              ]??0;

            return (
              totalByName>ruleLimit ||
              deckCard.count>source.count
            );
          })
          .map(card=>card.name)
      )
    );

  const pairInvalid=
    d.format==="commander" &&
    secondCommander &&
    !secondCommanderOptions.some(
      card=>card.id===secondCommander.id
    );

  const commanderTooLarge=
    d.format==="commander" &&
    totalCards>100;

  const hasBlockingError=
    illegalCards.length>0 ||
    copyViolationNames.length>0 ||
    Boolean(pairInvalid) ||
    commanderTooLarge;

  const add=(card:CardRecord)=>{
    if(!isSourceLegal(card)){
      return;
    }

    setD(current=>{
      const existing=
        current.cards.find(
          item=>item.id===card.id
        );

      const currentCount=
        existing?.count??0;

      const currentByName=
        current.cards
          .filter(
            item=>
              item.name.toLowerCase()===
              card.name.toLowerCase()
          )
          .reduce(
            (sum,item)=>sum+item.count,
            0
          );

      const ruleLimit=
        deckCopyLimit(
          card,
          current.format
        );

      if(
        currentCount>=card.count ||
        currentByName>=ruleLimit
      ){
        return current;
      }

      const currentCommanderCount=
        current.format==="commander"
          ?current.commanderIds.length
          :0;

      const currentMainCount=
        current.cards.reduce(
          (sum,item)=>sum+item.count,
          0
        );

      const maxMain=
        current.format==="commander"
          ?100-Math.max(1,currentCommanderCount)
          :Infinity;

      if(currentMainCount>=maxMain){
        return current;
      }

      if(existing){
        return {
          ...current,
          cards:current.cards.map(item=>
            item.id===card.id
              ?{
                  ...item,
                  count:item.count+1,
                  available:card.count
                }
              :item
          )
        };
      }

      return {
        ...current,
        cards:[
          ...current.cards,
          {
            id:card.id,
            name:card.name,
            count:1,
            manaValue:card.manaValue,
            typeLine:card.typeLine,
            role:"Manuell",
            reason:"Manuell hinzugefügt",
            available:card.count
          }
        ]
      };
    });
  };

  const choosePrimaryCommander=(id:string)=>{
    if(!id){
      setD(current=>({
        ...current,
        commanderIds:[],
        colors:[]
      }));

      return;
    }

    const commander=pool.find(
      card=>card.id===id
    );

    if(!commander){
      return;
    }

    setD(current=>({
      ...current,
      commanderIds:[commander.id],
      colors:commander.colorIdentity??[]
    }));
  };

  const chooseSecondCommander=(id:string)=>{
    if(!primaryCommander){
      return;
    }

    if(!id){
      setD(current=>({
        ...current,
        commanderIds:[primaryCommander.id],
        colors:primaryCommander.colorIdentity??[]
      }));

      return;
    }

    const second=
      secondCommanderOptions.find(
        card=>card.id===id
      );

    if(!second){
      return;
    }

    const commanders=[
      primaryCommander,
      second
    ];

    setD(current=>({
      ...current,
      commanderIds:commanders.map(
        card=>card.id
      ),
      colors:commanderColorIdentity(commanders)
    }));
  };

  const changeFormat=(format:Format)=>{
    setD(current=>({
      ...current,
      format,
      commanderIds:
        format==="commander"
          ?current.commanderIds.slice(0,2)
          :[],
      colors:
        format==="commander"
          ?current.colors
          :[]
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
            Manueller Deck-Editor · {totalCards} Karten
          </p>
        </div>

        <button
          className="primary"
          disabled={hasBlockingError}
          title={
            hasBlockingError
              ?"Behebe zuerst die Regelverstöße im Deck."
              :undefined
          }
          onClick={()=>onSave({
            ...d,
            colors:
              d.format==="commander"
                ?commanderColors
                :d.colors,
            updatedAt:Date.now()
          })}
        >
          Speichern
        </button>
      </div>

      <div className="panel">
        <h3>Deck-Einstellungen</h3>

        <div className="two">
          <label>
            Deckname

            <input
              value={d.name}
              onChange={e=>
                setD(current=>({
                  ...current,
                  name:e.target.value
                }))
              }
              placeholder="Name des Decks"
            />
          </label>

          <label>
            Format

            <select
              value={d.format}
              onChange={e=>
                changeFormat(
                  e.target.value as Format
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

        {d.format==="commander"&&
          <label>
            Commander

            <select
              value={primaryCommander?.id??""}
              onChange={e=>choosePrimaryCommander(e.target.value)}
            >
              <option value="">
                — Commander wählen —
              </option>

              {availableCommanders.map(card=>
                <option
                  key={card.id}
                  value={card.id}
                >
                  {card.name}
                </option>
              )}
            </select>
          </label>
        }

        {d.format==="commander"&&
          primaryCommander&&
          secondCommanderOptions.length>0&&
          <label>
            Zweiter Commander (optional)

            <select
              value={secondCommander?.id??""}
              onChange={e=>chooseSecondCommander(e.target.value)}
            >
              <option value="">
                — kein zweiter Commander —
              </option>

              {secondCommanderOptions.map(card=>
                <option
                  key={card.id}
                  value={card.id}
                >
                  {card.name}
                </option>
              )}
            </select>
          </label>
        }

        {d.format==="commander"&&
          availableCommanders.length===0&&
          <div className="notice">
            In deiner Sammlung wurde aktuell keine Karte gefunden,
            die als Commander verwendet werden kann.
          </div>
        }

        {d.format==="commander"&&
          selectedCommanders.length>0&&
          <div className="ai-box">
            <strong>
              {selectedCommanders.length===1
                ?"Commander:"
                :"Commander:"
              }
            </strong>{" "}

            {selectedCommanders
              .map(card=>card.name)
              .join(" + ")
            }

            <br />

            <span>
              Farbidentität:{" "}
              {commanderColors.length
                ?commanderColors
                    .map(color=>COLOR_NAMES[color]??color)
                    .join(", ")
                :"Farblos"
              }
            </span>
          </div>
        }

        <div className="stats">
          <div>
            <strong>{totalCards}</strong>
            <span>Karten aktuell</span>
          </div>

          <div>
            <strong>
              {d.format==="commander"
                ?"100"
                :"60+"
              }
            </strong>
            <span>
              {d.format==="commander"
                ?"Deckgröße"
                :"Mindestgröße"
              }
            </span>
          </div>

          {d.format==="commander"&&
            <div>
              <strong>
                {mainDeckCount}/{commanderMainTarget}
              </strong>
              <span>Karten ohne Commander</span>
            </div>
          }
        </div>

        {d.format==="standard"&&
          totalCards<60&&
          <div className="notice">
            Für ein Standard-Deck fehlen aktuell noch{" "}
            {60-totalCards} Karten bis zur Mindestgröße.
          </div>
        }

        {d.format==="commander"&&
          selectedCommanders.length===0&&
          <div className="notice">
            Wähle zuerst einen Commander. Danach werden nur Commander-legale Karten seiner Farbidentität angezeigt.
          </div>
        }

        {d.format==="commander"&&
          selectedCommanders.length>0&&
          totalCards<100&&
          <div className="notice">
            Für das Commander-Deck fehlen aktuell noch{" "}
            {100-totalCards} Karten.
          </div>
        }

        {d.format==="standard"&&
          totalCards>=60&&
          <div className="ai-box">
            Die Standard-Mindestgröße von 60 Karten ist erreicht.
          </div>
        }

        {d.format==="commander"&&
          selectedCommanders.length>0&&
          totalCards===100&&
          <div className="ai-box">
            Die Commander-Deckgröße von 100 Karten ist erreicht.
          </div>
        }

        {commanderTooLarge&&
          <div className="error">
            Das Deck enthält {totalCards} Karten.
            Ein Commander-Deck darf insgesamt nur 100 Karten enthalten.
          </div>
        }

        {pairInvalid&&
          <div className="error">
            Die beiden ausgewählten Commander dürfen nach den unterstützten Partner-Regeln nicht gemeinsam als Commander verwendet werden.
          </div>
        }

        {illegalCards.length>0&&
          <div className="error">
            <strong>
              {illegalCards.length} Karten sind im gewählten Format bzw. mit der Commander-Farbidentität nicht erlaubt:
            </strong>

            <div>
              {illegalCards
                .map(card=>card.name)
                .join(", ")
              }
            </div>
          </div>
        }

        {copyViolationNames.length>0&&
          <div className="error">
            <strong>
              Bei diesen Karten ist die erlaubte bzw. vorhandene Anzahl überschritten:
            </strong>

            <div>
              {copyViolationNames.join(", ")}
            </div>
          </div>
        }
      </div>

      <div className="editor-grid">
        <div className="panel">
          <h3>
            {d.format==="commander"
              ?`Deck · ${mainDeckCount}/${commanderMainTarget} Karten`
              :`Deck · ${totalCards} Karten`
            }
          </h3>

          {d.format==="commander"&&
            selectedCommanders.map((commander,index)=>
              <div
                className="commander-card"
                key={commander.id}
              >
                <strong>
                  {index===0
                    ?"Commander"
                    :"Zweiter Commander"
                  }
                </strong>

                <span>
                  {commander.name}
                </span>

                <small>
                  {commander.typeLine}
                </small>
              </div>
            )
          }

          {all.length===0&&
            <p className="muted">
              Das Deck ist noch leer. Füge rechts Karten aus deiner Sammlung hinzu.
            </p>
          }

          {all.map(card=>{
            const source=pool.find(
              item=>item.id===card.id
            );

            const illegal=
              illegalCards.some(
                item=>item.id===card.id
              );

            const copyViolation=
              copyViolationNames.includes(
                card.name
              );

            const ruleLimit=
              source
                ?deckCopyLimit(
                    source,
                    d.format
                  )
                :0;

            const allowedLabel=
              Number.isFinite(ruleLimit)
                ?String(ruleLimit)
                :"beliebig";

            return (
              <div
                className="edit-row"
                key={card.id}
              >
                <span>
                  {card.count}× {card.name}

                  {illegal&&
                    <small className="illegal-card">
                      {" "}· nicht erlaubt
                    </small>
                  }

                  {copyViolation&&
                    <small className="illegal-card">
                      {" "}· Maximum {allowedLabel}
                    </small>
                  }
                </span>

                <div>
                  <button
                    onClick={()=>
                      setD(current=>({
                        ...current,
                        cards:current.cards
                          .map(item=>
                            item.id===card.id
                              ?{
                                  ...item,
                                  count:Math.max(
                                    0,
                                    item.count-1
                                  )
                                }
                              :item
                          )
                          .filter(item=>item.count>0)
                      }))
                    }
                  >
                    −
                  </button>

                  <button
                    disabled={
                      !source ||
                      card.count>=source.count ||
                      (
                        (
                          deckCountByName[
                            card.name.toLowerCase()
                          ]??0
                        )>=
                        (
                          source
                            ?deckCopyLimit(
                                source,
                                d.format
                              )
                            :0
                        )
                      ) ||
                      (
                        d.format==="commander" &&
                        mainDeckCount>=commanderMainTarget
                      )
                    }
                    onClick={()=>{
                      if(source){
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
          <h3>Karten hinzufügen</h3>

          {d.format==="commander"&&
            selectedCommanders.length===0
            ? <p className="muted">
                Wähle zuerst einen Commander.
              </p>

            : <>
                <input
                  placeholder="Karte filtern…"
                  onChange={e=>{
                    const value=e.target.value.toLowerCase();

                    document
                      .querySelectorAll<HTMLElement>("[data-card]")
                      .forEach(element=>{
                        element.hidden=
                          !element.dataset.card!.includes(value);
                      });
                  }}
                />

                <div className="add-list">
                  {legalPool
                    .slice(0,200)
                    .map(card=>{
                      const current=
                        all.find(
                          item=>item.id===card.id
                        )?.count??0;

                      const currentByName=
                        deckCountByName[
                          card.name.toLowerCase()
                        ]??0;

                      const ruleLimit=
                        deckCopyLimit(
                          card,
                          d.format
                        );

                      const ruleLimitLabel=
                        Number.isFinite(ruleLimit)
                          ?String(ruleLimit)
                          :"beliebig";

                      const commanderFull=
                        d.format==="commander" &&
                        mainDeckCount>=commanderMainTarget;

                      return (
                        <div
                          data-card={card.name.toLowerCase()}
                          key={card.id}
                        >
                          <span>
                            {card.name}
                            <small className="muted">
                              {" "}({currentByName}/{ruleLimitLabel})
                            </small>
                          </span>

                          <button
                            disabled={
                              current>=card.count ||
                              currentByName>=ruleLimit ||
                              commanderFull
                            }
                            onClick={()=>add(card)}
                          >
                            +1
                          </button>
                        </div>
                      );
                    })
                  }
                </div>

                {legalPool.length===0&&
                  <div className="notice">
                    Für die aktuelle Auswahl sind keine legalen Karten aus deiner Sammlung verfügbar.
                  </div>
                }
              </>
          }
        </div>
      </div>
    </section>
  );
}

export default App;
