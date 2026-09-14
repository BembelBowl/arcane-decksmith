import { describe, expect, it } from "vitest";
import { buildDeck, commanderCandidates, deckStats } from "./deckBuilder";
import type { CardRecord } from "./types";

const c=(id:string,name:string,typeLine:string,oracleText:string,count=4):CardRecord=>({
  id,name,set:"tst",collectorNumber:"1",lang:"en",foil:false,count,addedAt:1,updatedAt:1,manaValue:/^\d/.test(name)?Number(name[0]):2,
  colors:[],colorIdentity:[],typeLine,oracleText,legalities:{commander:"legal",standard:"legal"},isBasicLand:/Basic Land/.test(typeLine)
});
describe("deck builder",()=>{
  it("erkennt Commander",()=>{
    const x=c("1","A","Legendary Creature — Human","partner");
    expect(commanderCandidates([x],[])).toHaveLength(1);
  });
  it("respektiert Sammlung und Commander-Größe",()=>{
    const cards=[
      c("cmd","Commander","Legendary Creature — Human",""),
      ...Array.from({length:40},(_,i)=>c(String(i),"Island","Basic Land — Island","",10))
    ];
    const d=buildDeck(cards,{name:"x",format:"commander" as const,colors:[],commander:cards[0],targetManaValue:3});
    expect(d.commanderIds).toEqual(["cmd"]);
    expect(deckStats(d).total).toBeLessThanOrEqual(99);
  });
  it("gewichtet verifizierte Turniersignale ohne Deckregeln zu umgehen",()=>{
    const land=c("land","Wastes","Basic Land — Wastes","",30);
    const creatures=Array.from({length:28},(_,i)=>
      c(
        `signal-${i}`,
        i===0?"A Weak Card":i===27?"Z Strong Card":`M Card ${String(i).padStart(2,"0")}`,
        "Creature — Test",
        "Vigilance",
        4
      )
    );
    const pool=[land,...creatures];
    const options={name:"x",format:"standard" as const,colors:[],targetManaValue:2};
    const baseline=buildDeck(pool,options);
    const informed=buildDeck(pool,{
      ...options,
      intelligence:{
        cards:{
          "z strong card":{performance:1},
          "a weak card":{performance:-1}
        },
        topDeckAvailable:true
      }
    });
    const copies=(deck:ReturnType<typeof buildDeck>,name:string)=>
      deck.cards.find(card=>card.name===name)?.count??0;
    expect(copies(informed,"Z Strong Card")).toBeGreaterThan(copies(baseline,"Z Strong Card"));
    expect(copies(informed,"A Weak Card")).toBeLessThan(copies(baseline,"A Weak Card"));
    expect(deckStats(informed).total).toBe(60);
  });
  it("übernimmt Community-Struktur nur konservativ",()=>{
    const commander=c("cmd","Commander","Legendary Creature — Human","",1);
    const land=c("land","Wastes","Basic Land — Wastes","",100);
    const creatures=Array.from({length:80},(_,i)=>
      c(`community-${i}`,`M Community ${String(i).padStart(2,"0")}`,"Creature — Test","Vigilance",1)
    );
    const deck=buildDeck([commander,land,...creatures],{
      name:"x",
      format:"commander" as const,
      colors:[],
      commander,
      targetManaValue:3,
      intelligence:{
        cards:{},
        archidektAvailable:true,
        edhrecAvailable:true,
        structure:{lands:42,targetManaValue:5,sampleDecks:20}
      }
    });
    const lands=deck.cards
      .filter(card=>/Land/.test(card.typeLine??""))
      .reduce((sum,card)=>sum+card.count,0);
    expect(lands).toBe(38);
    expect(deck.targetManaValue).toBeCloseTo(3.4);
    expect(deckStats(deck).total).toBe(99);
  });
  it("berechnet Mana Value",()=>{
    const d={cards:[c("a","A","Creature","")].map(x=>({...x,count:2,role:"Creature",reason:"x",available:2})),sideboard:[],commanderIds:[],format:"standard" as const,id:"x",name:"x",createdAt:1,updatedAt:1,colors:[]};
    expect(deckStats(d).averageManaValue).toBe(2);
  });
});
