import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import { subscribeAuth, login, logout, authMessage } from "./auth";
import { firebaseConfigured } from "./firebase";
import { loadCollection, loadDecks, removeCard, removeDeck, saveCard, saveDeck, uidFromEmail } from "./db";
import { autocomplete, getCard, getPrintings, imageFor, searchCards, scryfallUrl, normalizeCard, type ScryfallCard } from "./scryfall";
import { buildDeck, commanderCandidates, deckStats } from "./deckBuilder";
import { deckText, download, parseList, toCsv } from "./importExport";
import { generateLocalExplanation } from "./ai";
import type { CardRecord, DeckRecord, Format, GroupBy, ViewMode } from "./types";
import "./styles.css";

const COLORS = ["W","U","B","R","G"];
const COLOR_NAMES: Record<string,string> = {W:"Weiß",U:"Blau",B:"Schwarz",R:"Rot",G:"Grün"};

function App() {
  const [auth, setAuth] = useState<{user: User|null; loading: boolean}>({user:null,loading:true});
  const [demoEmail, setDemoEmail] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  useEffect(() => subscribeAuth(setAuth), []);
  if (auth.loading) return <div className="splash">Arcane Decksmith wird geladen…</div>;
  if (!auth.user && !demoMode) return <Auth onDemo={(email)=>{setDemoEmail(email);setDemoMode(true)}} />;
  const uid = auth.user?.uid ?? uidFromEmail(demoEmail);
  return <Main user={auth.user} uid={uid} demoMode={demoMode} onExitDemo={()=>setDemoMode(false)} />;
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

  return <div className="auth-shell"><div className="auth-card">
   <img
  className="brand-logo"
  src="./ad_logo.png"
  alt="Arcane Decksmith Logo"
/>
    <h1>Arcane Decksmith</h1>
    <p className="muted">Deine Sammlung. Deine Karten. Dein Deck.</p>

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
  </div></div>;
}

function Main({user,uid,demoMode,onExitDemo}:{user:User|null;uid:string;demoMode:boolean;onExitDemo:()=>void}) {
  const [collection,setCollection]=useState<CardRecord[]>([]); const [decks,setDecks]=useState<DeckRecord[]>([]);
  const [page,setPage]=useState<"collection"|"search"|"builder"|"decks">("collection"); const [busy,setBusy]=useState(true); const [toast,setToast]=useState("");
  useEffect(()=>{(async()=>{setBusy(true);try{setCollection(await loadCollection(uid));setDecks(await loadDecks(uid))}finally{setBusy(false)}})()},[uid]);
  const persistCard=async(c:CardRecord)=>{await saveCard(uid,c);setCollection(await loadCollection(uid));};
  const persistDeck=async(d:DeckRecord)=>{await saveDeck(uid,d);setDecks(await loadDecks(uid));setPage("decks");setToast("Deck gespeichert.");setTimeout(()=>setToast(""),2200)};
  const delCard=async(id:string)=>{await removeCard(uid,id);setCollection(await loadCollection(uid))};
  const delDeck=async(id:string)=>{await removeDeck(uid,id);setDecks(await loadDecks(uid))};
  return <div className="app">
    <header className="topbar"><button className="logo" onClick={()=>setPage("collection")}>
      <img src="./ad_logo.png" alt="Arcane Decksmith Logo" /> 
      Arcane Decksmith
    </button>
      <nav>{(["collection","search","builder","decks"] as const).map(p=><button key={p} className={page===p?"nav active":"nav"} onClick={()=>setPage(p)}>{p==="collection"?"Sammlung":p==="search"?"Kartensuche":p==="builder"?"Deck bauen":"Decks"}</button>)}</nav>
      <div className="userbox"><span>{demoMode?"Demo":user?.email}</span><button onClick={demoMode?onExitDemo:logout}>Abmelden</button></div>
    </header>
    {toast&&<div className="toast">{toast}</div>}
    <main>{busy?<div className="loading">Daten werden geladen…</div>:
      page==="collection"?<Collection cards={collection} onChange={persistCard} onDelete={delCard} onImport={async(next)=>{for(const c of next)await saveCard(uid,c);setCollection(await loadCollection(uid));}} />:
      page==="search"?<Search onAdd={async(c)=>{
  const existing=collection.find(x=>x.id===c.id);

  await persistCard(
    existing
      ? {...existing,count:existing.count+1,updatedAt:Date.now()}
      : {...normalizeCard(c),count:1}
  );

  setToast(
    existing
      ? `${c.name}: Anzahl auf ${existing.count+1} erhöht.`
      : `${c.name} wurde zur Sammlung hinzugefügt.`
  );

  setTimeout(()=>setToast(""),2200);
}}/>:
      page==="builder"?<Builder pool={collection} onSave={persistDeck}/>:
      <Decks decks={decks} pool={collection} onDelete={delDeck} onSave={persistDeck}/>
    }</main>
    <footer>Scryfall-Daten & Bilder werden direkt von Scryfall geladen. Keine Kaufentscheidung aufgrund von Preisen.</footer>
  </div>
}

function Search({onAdd}:{onAdd:(c:ScryfallCard)=>Promise<void>}) {
  const [q,setQ]=useState("");const [results,setResults]=useState<ScryfallCard[]>([]);const [suggestions,setSuggestions]=useState<string[]>([]);const [busy,setBusy]=useState(false);
  useEffect(()=>{const t=setTimeout(()=>{if(q.length>=2) void autocomplete(q).then(setSuggestions).catch(()=>setSuggestions([]));else setSuggestions([])},300);return()=>clearTimeout(t)},[q]);
  const go=async()=>{setBusy(true);try{setResults(await searchCards(q))}catch(e:any){alert(e.message)}finally{setBusy(false)}};
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
        onKeyDown={e=>e.key==="Enter"&&go()}
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

    if(printings.length>0) return;

    setLoadingPrintings(true);
    setPrintingError("");

    try{
      const variants=await getPrintings(card);
      setPrintings(variants);
    }catch{
      setPrintingError("Die Varianten konnten nicht von Scryfall geladen werden.");
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
                :"Varianten / Drucke"}
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

            {!loadingPrintings&&printings.length>0&&<>
              <label>
                Ausgabe auswählen

                <select
                  className="variant-select"
                  value={selectedCard.id}
                  onChange={e=>{
                    const chosen=printings.find(
                      p=>p.id===e.target.value
                    );

                    if(chosen) setSelectedCard(chosen);
                  }}
                >
                  {printings.map(p=>
                    <option key={p.id} value={p.id}>
                      {(p.set_name??p.set)}
                      {" · "}
                      {p.set.toUpperCase()}
                      {" #"}
                      {p.collector_number}
                      {p.lang&&p.lang!=="en"
                        ?` · ${p.lang.toUpperCase()}`
                        :""
                      }
                    </option>
                  )}
                </select>
              </label>

              <div className="variant-info">
                <strong>Gewählte Ausgabe:</strong>

                <span>
                  {selectedCard.set_name??selectedCard.set.toUpperCase()}
                </span>

                <span>
                  Set: {selectedCard.set.toUpperCase()}
                </span>

                <span>
                  Collector Nr.: {selectedCard.collector_number}
                </span>

                {selectedCard.rarity&&
                  <span>
                    Seltenheit: {selectedCard.rarity}
                  </span>
                }
              </div>
            </>}
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
function Collection({cards,onChange,onDelete,onImport}:{cards:CardRecord[];onChange:(c:CardRecord)=>Promise<void>;onDelete:(id:string)=>Promise<void>;onImport:(c:CardRecord[])=>Promise<void>}) {
  const [query,setQuery]=useState("");const [group,setGroup]=useState<GroupBy>("none");const [view,setView]=useState<ViewMode>("grid");const [sort,setSort]=useState("name");const [selected,setSelected]=useState<Set<string>>(new Set());
  const [importText,setImportText]=useState("");const [showImport,setShowImport]=useState(false);
  const filtered=useMemo(()=>cards.filter(c=>`${c.name} ${c.set} ${c.typeLine} ${c.oracleText}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sort==="mv"?a.manaValue-b.manaValue:sort==="count"?b.count-a.count:a.name.localeCompare(b.name)),[cards,query,sort]);
  const total=cards.reduce((n,c)=>n+c.count,0);
  const groups=group==="none"?{Alle:filtered}:filtered.reduce<Record<string,CardRecord[]>>((a,c)=>{const k=group==="color"?(c.colors.join("")||"Farblos"):group==="type"?(c.typeLine?.split("—")[0]??"Unbekannt"):group==="set"?c.set.toUpperCase():`MV ${c.manaValue}`;(a[k]??=[]).push(c);return a}, {});
  const importList=async()=>{const rows=parseList(importText);const out=[...cards];for(const r of rows){try{const matches=await searchCards(r.name);const c=matches[0];if(!c)continue;const n=normalizeCard(c,r.count);const old=out.find(x=>x.id===n.id);if(old)old.count+=r.count;else out.push(n)}catch{}}await onImport(out);setImportText("");setShowImport(false)};
  return <section><div className="pagehead"><div><h2>Sammlung</h2><p className="muted">{cards.length} unterschiedliche Karten · {total} physische Karten</p></div><div className="row"><button className="secondary" onClick={()=>download("collection.json",JSON.stringify(cards,null,2),"application/json")}>JSON export</button><button className="secondary" onClick={()=>download("collection.csv",toCsv(cards),"text/csv;charset=utf-8")}>CSV export</button><button className="primary" onClick={()=>setShowImport(!showImport)}>Import</button></div></div>
    {showImport&&<div className="panel"><h3>Textimport</h3><textarea value={importText} onChange={e=>setImportText(e.target.value)} placeholder={"4 Lightning Bolt\n2x Counterspell\n1 Sol Ring"} rows={6}/><div className="row"><button className="primary" onClick={importList}>Import prüfen & übernehmen</button><button className="secondary" onClick={()=>setShowImport(false)}>Abbrechen</button></div></div>}
    <div className="toolbar"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Sammlung durchsuchen…"/><select value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="mv">Mana Value</option><option value="count">Anzahl</option></select><select value={group} onChange={e=>setGroup(e.target.value as GroupBy)}><option value="none">Keine Gruppierung</option><option value="color">Farbe</option><option value="type">Typ</option><option value="set">Set</option><option value="manaValue">Mana Value</option></select><button className="secondary" onClick={()=>setView(view==="grid"?"list":"grid")}>{view==="grid"?"Listenansicht":"Kartenansicht"}</button></div>
    {Object.entries(groups).map(([name,list])=><div key={name}><h3 className="group-title">{name}</h3><div className={view==="grid"?"card-grid":"list-view"}>{list.map(c=><CollectionCard key={c.id} card={c} selected={selected.has(c.id)} toggle={()=>setSelected(s=>{const n=new Set(s);n.has(c.id)?n.delete(c.id):n.add(c.id);return n})} onChange={onChange} onDelete={onDelete}/>)}</div></div>)}
    {selected.size>0&&<div className="bulkbar">{selected.size} ausgewählt <button onClick={async()=>{for(const id of selected)await onDelete(id);setSelected(new Set())}}>Ausgewählte löschen</button></div>}
  </section>
}
function CollectionCard({card,selected,toggle,onChange,onDelete}:{card:CardRecord;selected:boolean;toggle:()=>void;onChange:(c:CardRecord)=>Promise<void>;onDelete:(id:string)=>Promise<void>}) {
  return <article className="collection-card"><div className="select"><input type="checkbox" checked={selected} onChange={toggle}/></div>{card.imageUri&&<img src={card.imageUri} alt="" loading="lazy"/>}<div className="card-body"><h3>{card.name}</h3><div className="meta">{card.set.toUpperCase()} #{card.collectorNumber} · MV {card.manaValue}</div><p>{card.typeLine}</p><div className="quantity"><button onClick={()=>onChange({...card,count:Math.max(1,card.count-1),updatedAt:Date.now()})}>−</button><strong>{card.count}</strong><button onClick={()=>onChange({...card,count:card.count+1,updatedAt:Date.now()})}>+</button><button className="danger ghost" onClick={()=>onDelete(card.id)}>Löschen</button></div></div></article>
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
          <p className="muted">{decks.length} Decks</p>
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

function Decks({decks,pool,onDelete,onSave}:{decks:DeckRecord[];pool:CardRecord[];onDelete:(id:string)=>Promise<void>;onSave:(d:DeckRecord)=>Promise<void>}) {
  const [editing,setEditing]=useState<DeckRecord|null>(null);
  const [importText,setImportText]=useState("");
  const [showImport,setShowImport]=useState(false);
  const importDeck=async()=>{
    const rows=parseList(importText);
    const cards: DeckRecord["cards"]=[];
    for(const r of rows){
      const hit=pool.find(c=>c.name.toLowerCase()===r.name.toLowerCase()) ?? pool.find(c=>c.name.toLowerCase().includes(r.name.toLowerCase()));
      if(hit) cards.push({id:hit.id,name:hit.name,count:Math.min(r.count,hit.count),manaValue:hit.manaValue,typeLine:hit.typeLine,role:"Import",reason:"Aus Deckliste importiert.",available:hit.count});
    }
    const d:DeckRecord={id:crypto.randomUUID(),name:"Importiertes Deck",format:"standard",commanderIds:[],cards,sideboard:[],colors:[],createdAt:Date.now(),updatedAt:Date.now(),notes:"Importierte Deckliste; bitte Format und Legalität im Editor prüfen."};
    if(cards.length) await onSave(d);
    setImportText("");setShowImport(false);
  };
  if(editing)return <DeckEditor deck={editing} pool={pool} onBack={()=>setEditing(null)} onSave={async d=>{await onSave(d);setEditing(null)}}/>;
  return <section><div className="pagehead"><div><h2>Gespeicherte Decks</h2><p className="muted">{decks.length} Decks</p></div><div className="row"><button className="secondary" onClick={()=>setShowImport(!showImport)}>Deckliste importieren</button></div></div>
    {showImport&&<div className="panel"><h3>Deckliste importieren</h3><p className="muted">Format: „4 Lightning Bolt“. Die Karten werden gegen deine Sammlung aufgelöst.</p><textarea value={importText} onChange={e=>setImportText(e.target.value)} rows={8} placeholder={"4 Lightning Bolt\n4 Counterspell\n20 Island"}/><div className="row"><button className="primary" onClick={importDeck}>Importieren</button><button className="secondary" onClick={()=>setShowImport(false)}>Abbrechen</button></div></div>}
    <div className="deck-grid">{decks.map(d=><article className="panel" key={d.id}><h3>{d.name}</h3><div className="meta">{d.format} · Score {d.score??"—"} · {deckStats(d).total} Karten</div><p>MV {deckStats(d).averageManaValue} · Länder {deckStats(d).lands}</p><div className="row"><button className="primary" onClick={()=>setEditing(d)}>Bearbeiten</button><button className="secondary" onClick={()=>download(`${d.name}.txt`,deckText(d))}>Export</button><button className="danger ghost" onClick={()=>onDelete(d.id)}>Löschen</button></div></article>)}</div>
  </section>
}

function DeckEditor({deck,pool,onBack,onSave}:{deck:DeckRecord;pool:CardRecord[];onBack:()=>void;onSave:(d:DeckRecord)=>Promise<void>}) {
  const [d,setD]=useState(deck);
  const all=[...d.cards];
  const add=(c:CardRecord)=>setD(x=>({...x,cards:x.cards.some(y=>y.id===c.id)?x.cards.map(y=>y.id===c.id?{...y,count:y.count+1,available:c.count}:y):[...x.cards,{id:c.id,name:c.name,count:1,manaValue:c.manaValue,typeLine:c.typeLine,role:"Manuell",reason:"Manuell hinzugefügt",available:c.count}]}));
  return <section><div className="pagehead"><button className="secondary" onClick={onBack}>← Zurück</button><div><h2>{d.name}</h2><p className="muted">Manueller Deck-Editor</p></div><button className="primary" onClick={()=>onSave({...d,updatedAt:Date.now()})}>Speichern</button></div>
    <div className="editor-grid"><div className="panel"><h3>Deck</h3>{all.map(c=><div className="edit-row" key={c.id}><span>{c.count}× {c.name}</span><div><button onClick={()=>setD(x=>({...x,cards:x.cards.map(y=>y.id===c.id?{...y,count:Math.max(0,y.count-1)}:y).filter(y=>y.count>0)}))}>−</button><button onClick={()=>{const src=pool.find(x=>x.id===c.id);if(src&&c.count<src.count)add(src)}}>+</button></div></div>)}</div><div className="panel"><h3>Karten hinzufügen</h3><input placeholder="Karte filtern…" onChange={e=>{const v=e.target.value.toLowerCase();document.querySelectorAll<HTMLElement>("[data-card]").forEach(x=>x.hidden=!x.dataset.card!.includes(v))}}/><div className="add-list">{pool.slice(0,200).map(c=><div data-card={c.name.toLowerCase()} key={c.id}><span>{c.name}</span><button onClick={()=>add(c)}>+1</button></div>)}</div></div></div>
  </section>
}

export default App;
