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
  it("berechnet Mana Value",()=>{
    const d={cards:[c("a","A","Creature","")].map(x=>({...x,count:2,role:"Creature",reason:"x",available:2})),sideboard:[],commanderIds:[],format:"standard" as const,id:"x",name:"x",createdAt:1,updatedAt:1,colors:[]};
    expect(deckStats(d).averageManaValue).toBe(2);
  });
});
