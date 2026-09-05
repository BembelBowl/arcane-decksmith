import type {
  CardRecord,
  DeckCard,
  DeckRecord,
  Format
} from "./types";

const COLOR_ORDER = ["W", "U", "B", "R", "G"];

const BASIC_NAMES = new Set([
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
  "Wastes",
  "Ebene",
  "Insel",
  "Sumpf",
  "Gebirge",
  "Wald",
  "Ödnis"
]);

function isLand(card: CardRecord) {
  return /\bLand\b/i.test(card.typeLine ?? "");
}

function isCreature(card: CardRecord) {
  return /\bCreature\b/i.test(card.typeLine ?? "");
}

function cardText(card: CardRecord) {
  return `${card.typeLine ?? ""} ${card.oracleText ?? ""}`.toLowerCase();
}

function roleOf(card: CardRecord): string {
  const text = cardText(card);

  if (isLand(card)) {
    return "Land";
  }

  if (
    /add \{?[wubrgc]/.test(text) ||
    /search your library for (a|an) (basic )?land/.test(text) ||
    /mana.*pool/.test(text) ||
    /ramp/.test(text)
  ) {
    return "Ramp";
  }

  if (
    /draw (a|one|two|three|x|cards?)|draws? a card|card draw/.test(text)
  ) {
    return "Card Advantage";
  }

  if (
    /destroy target|exile target|return target.*hand|counter target|deals? .* damage to target|target creature gets -/.test(text)
  ) {
    return "Interaction";
  }

  if (/search your library/.test(text)) {
    return "Tutor";
  }

  if (/when .* enters|whenever|at the beginning|combat/.test(text)) {
    return isCreature(card)
      ? "Synergie"
      : "Value";
  }

  if (isCreature(card)) {
    return "Creature";
  }

  return "Value";
}

function standardLegal(card: CardRecord) {
  return card.legalities?.standard === "legal";
}

function commanderFormatLegal(card: CardRecord) {
  return card.legalities?.commander === "legal";
}

function isLegendaryCreature(card: CardRecord) {
  return (
    /\bLegendary\b/i.test(card.typeLine ?? "") &&
    /\bCreature\b/i.test(card.typeLine ?? "")
  );
}

function isBackground(card: CardRecord) {
  return (
    /\bLegendary\b/i.test(card.typeLine ?? "") &&
    /\bBackground\b/i.test(card.typeLine ?? "")
  );
}

function canBePrimaryCommander(card: CardRecord) {
  if (!commanderFormatLegal(card)) {
    return false;
  }

  return (
    isLegendaryCreature(card) ||
    /can be your commander/i.test(card.oracleText ?? "")
  );
}

function hasGenericPartner(card: CardRecord) {
  const oracle = card.oracleText ?? "";

  return (
    /(^|\n)partner(\s|$|\()/i.test(oracle) &&
    !/partner with/i.test(oracle)
  );
}

function hasFriendsForever(card: CardRecord) {
  return /friends forever/i.test(card.oracleText ?? "");
}

function hasDoctorsCompanion(card: CardRecord) {
  return /doctor'?s companion/i.test(card.oracleText ?? "");
}

function isDoctor(card: CardRecord) {
  return /\bDoctor\b/i.test(card.typeLine ?? "");
}

function choosesBackground(card: CardRecord) {
  return /choose a background/i.test(card.oracleText ?? "");
}

function partnerWithName(card: CardRecord) {
  const match=(card.oracleText ?? "").match(
    /partner with ([^(\n.]+)/i
  );

  return match?.[1]?.trim().toLowerCase();
}

function identityOk(
  card: CardRecord,
  colors: string[]
) {
  return (card.colorIdentity ?? []).every(
    color => colors.includes(color)
  );
}

export function commanderColorIdentity(
  commanders: CardRecord[]
) {
  const colors=new Set<string>();

  for(const commander of commanders){
    for(const color of commander.colorIdentity ?? []){
      colors.add(color);
    }
  }

  return [
    ...COLOR_ORDER.filter(color=>colors.has(color)),
    ...[...colors].filter(color=>!COLOR_ORDER.includes(color)).sort()
  ];
}

export function commanderPairAllowed(
  first: CardRecord,
  second: CardRecord
) {
  if (
    first.id === second.id ||
    !commanderFormatLegal(first) ||
    !commanderFormatLegal(second)
  ) {
    return false;
  }

  const firstPartnerWith=partnerWithName(first);
  const secondPartnerWith=partnerWithName(second);

  if (
    firstPartnerWith === second.name.toLowerCase() ||
    secondPartnerWith === first.name.toLowerCase()
  ) {
    return true;
  }

  if (
    hasGenericPartner(first) &&
    hasGenericPartner(second)
  ) {
    return true;
  }

  if (
    hasFriendsForever(first) &&
    hasFriendsForever(second)
  ) {
    return true;
  }

  if (
    (hasDoctorsCompanion(first) && isDoctor(second)) ||
    (hasDoctorsCompanion(second) && isDoctor(first))
  ) {
    return true;
  }

  if (
    (choosesBackground(first) && isBackground(second)) ||
    (choosesBackground(second) && isBackground(first))
  ) {
    return true;
  }

  return false;
}

export function commanderCandidates(
  pool: CardRecord[],
  colors?: string[]
) {
  return pool.filter(card =>
    canBePrimaryCommander(card) &&
    (
      colors === undefined ||
      identityOk(card, colors)
    )
  );
}

export function commanderPairCandidates(
  pool: CardRecord[],
  primary: CardRecord
) {
  return pool.filter(card =>
    commanderPairAllowed(primary, card)
  );
}

export function deckCopyLimit(
  card: CardRecord,
  format: Format
) {
  const unlimited =
    card.isBasicLand ||
    BASIC_NAMES.has(card.name) ||
    /a deck can have any number/i.test(card.oracleText ?? "");

  if (unlimited) {
    return Number.POSITIVE_INFINITY;
  }

  return format === "commander"
    ? 1
    : 4;
}

export function cardLegalForDeck(
  card: CardRecord,
  format: Format,
  colors: string[] = []
) {
  if (format === "standard") {
    return standardLegal(card);
  }

  return (
    commanderFormatLegal(card) &&
    identityOk(card, colors)
  );
}

function cardScore(
  card: CardRecord,
  format: Format,
  targetManaValue?: number
) {
  const role=roleOf(card);
  let score=0;

  if(role==="Ramp") score+=8;
  if(role==="Card Advantage") score+=7;
  if(role==="Interaction") score+=7;
  if(role==="Tutor") score+=6;
  if(role==="Synergie") score+=6;
  if(isCreature(card)) score+=3;
  if(card.manaValue<=3) score+=3;

  if(targetManaValue!=null){
    score+=Math.max(
      0,
      4-Math.abs(card.manaValue-targetManaValue)
    );
  }

  if(
    format==="standard" &&
    standardLegal(card)
  ){
    score+=3;
  }

  return score;
}

function makeDeckCard(
  card: CardRecord,
  reason: string,
  available: number,
  count=1
):DeckCard {
  return {
    id:card.id,
    name:card.name,
    count,
    manaValue:card.manaValue,
    typeLine:card.typeLine,
    role:roleOf(card),
    reason,
    available
  };
}

export interface BuildOptions {
  name:string;
  format:Format;
  colors:string[];

  /*
   * "commander" bleibt aus Kompatibilitätsgründen erhalten.
   * Neue Aufrufer können bis zu zwei Commander über
   * "commanders" übergeben.
   */
  commander?:CardRecord;
  commanders?:CardRecord[];

  targetManaValue:number;
  minManaValue?:number;
  maxManaValue?:number;
}

export function buildDeck(
  pool:CardRecord[],
  options:BuildOptions
):DeckRecord {
  const commanders=
    options.format==="commander"
      ?(
          options.commanders?.length
            ?options.commanders
            :options.commander
              ?[options.commander]
              :[]
        ).slice(0,2)
      :[];

  const colors=
    options.format==="commander" &&
    commanders.length>0
      ?commanderColorIdentity(commanders)
      :options.colors;

  const colorEligible=
    pool.filter(card=>
      options.format==="standard"
        ?identityOk(card,colors)
        :identityOk(card,colors)
    );

  const eligible=
    colorEligible.filter(card=>
      options.format==="commander"
        ?commanderFormatLegal(card)
        :standardLegal(card)
    );

  const commanderIds=
    new Set(commanders.map(card=>card.id));

  const filtered=
    eligible.filter(card=>!commanderIds.has(card.id));

  /*
   * Commander hat insgesamt 100 Karten.
   * Bei einem Commander bleiben 99 Plätze im Hauptdeck,
   * bei zwei Commandern 98.
   *
   * Falls buildDeck ohne Commander aufgerufen wird,
   * bleiben aus Kompatibilitätsgründen 99 Plätze.
   */
  const commanderSlots=
    options.format==="commander"
      ?Math.max(1,commanders.length)
      :0;

  const target=
    options.format==="commander"
      ?100-commanderSlots
      :60;

  const selected=
    new Map<string,DeckCard>();

  const usedById=
    new Map<string,number>();

  const usedByName=
    new Map<string,number>();

  let slots=target;

  const add=(
    card:CardRecord,
    reason:string,
    wanted=1
  ):number=>{
    const nameKey=card.name.toLowerCase();

    const ruleLimit=
      deckCopyLimit(
        card,
        options.format
      );

    const currentByName=
      usedByName.get(nameKey)??0;

    const currentById=
      usedById.get(card.id)??0;

    const amount=Math.min(
      wanted,
      ruleLimit-currentByName,
      card.count-currentById,
      slots
    );

    if(amount<=0){
      return 0;
    }

    const existing=selected.get(card.id);

    if(existing){
      selected.set(
        card.id,
        {
          ...existing,
          count:existing.count+amount
        }
      );
    }else{
      selected.set(
        card.id,
        makeDeckCard(
          card,
          reason,
          card.count,
          amount
        )
      );
    }

    usedById.set(
      card.id,
      currentById+amount
    );

    usedByName.set(
      nameKey,
      currentByName+amount
    );

    slots-=amount;

    return amount;
  };

  const minManaValue=
    options.minManaValue??0;

  const maxManaValue=
    options.maxManaValue??Infinity;

  const inManaRange=(card:CardRecord)=>
    card.manaValue>=minManaValue &&
    card.manaValue<=maxManaValue;

  const lands=
    filtered
      .filter(isLand)
      .sort((a,b)=>
        (b.isBasicLand?1:0)-
        (a.isBasicLand?1:0) ||
        a.manaValue-b.manaValue
      );

  const nonlands=
    filtered
      .filter(card=>
        !isLand(card) &&
        inManaRange(card)
      );

  const desiredLands=
    options.format==="commander"
      ?36
      :24;

  const desiredRamp=
    options.format==="commander"
      ?10
      :4;

  const desiredDraw=
    options.format==="commander"
      ?10
      :7;

  const desiredInteraction=
    options.format==="commander"
      ?10
      :8;

  let currentLandCount=0;

  for(const card of lands){
    if(
      slots<=0 ||
      currentLandCount>=desiredLands
    ){
      break;
    }

    const missingLands=
      desiredLands-currentLandCount;

    const wanted=
      card.isBasicLand ||
      BASIC_NAMES.has(card.name)
        ?Math.min(
            card.count,
            missingLands
          )
        :1;

    currentLandCount+=add(
      card,
      "Mana-Basis: Landquote",
      wanted
    );
  }

  const fillRole=(
    role:string,
    wanted:number,
    reason:string
  )=>{
    const list=
      nonlands
        .filter(card=>roleOf(card)===role)
        .sort((a,b)=>
          cardScore(
            b,
            options.format,
            options.targetManaValue
          )-
          cardScore(
            a,
            options.format,
            options.targetManaValue
          )
        );

    let added=0;

    for(const card of list){
      if(
        added>=wanted ||
        slots<=0
      ){
        break;
      }

      added+=add(
        card,
        reason,
        Math.min(
          wanted-added,
          deckCopyLimit(
            card,
            options.format
          )
        )
      );
    }
  };

  fillRole(
    "Ramp",
    desiredRamp,
    "Bewertet als Mana-Beschleunigung."
  );

  fillRole(
    "Card Advantage",
    desiredDraw,
    "Bewertet als Kartenvorteil."
  );

  fillRole(
    "Interaction",
    desiredInteraction,
    "Bewertet als Interaktion/Antwort."
  );

  fillRole(
    "Tutor",
    options.format==="commander"
      ?4
      :2,
    "Bewertet als Tutor für Konsistenz."
  );

  const remaining=
    [...nonlands]
      .sort((a,b)=>
        cardScore(
          b,
          options.format,
          options.targetManaValue
        )-
        cardScore(
          a,
          options.format,
          options.targetManaValue
        )
      );

  for(const card of remaining){
    if(slots<=0){
      break;
    }

    add(
      card,
      "Gesamtbewertung aus Kurve, Rolle, Format und Farbidentität.",
      Math.min(
        deckCopyLimit(
          card,
          options.format
        ),
        card.count,
        slots
      )
    );
  }

  /*
   * Wenn danach noch Plätze frei sind, werden weitere
   * vorhandene Länder verwendet. Das ist besonders bei
   * kleinen Sammlungen hilfreich.
   */
  if(slots>0){
    for(const card of lands){
      if(slots<=0){
        break;
      }

      const remainingCopies=
        Math.min(
          deckCopyLimit(
            card,
            options.format
          ),
          card.count
        )-
        (usedById.get(card.id)??0);

      if(remainingCopies<=0){
        continue;
      }

      add(
        card,
        "Zusätzliches Land zum Auffüllen der Mana-Basis.",
        remainingCopies
      );
    }
  }

  const deckCards=[
    ...selected.values()
  ];

  const mainDeckCount=
    deckCards.reduce(
      (sum,card)=>sum+card.count,
      0
    );

  const landCount=
    deckCards
      .filter(card=>card.role==="Land")
      .reduce(
        (sum,card)=>sum+card.count,
        0
      );

  const nonlandCount=
    mainDeckCount-landCount;

  const nonlandManaTotal=
    deckCards
      .filter(card=>card.role!=="Land")
      .reduce(
        (sum,card)=>
          sum+
          card.manaValue*
          card.count,
        0
      );

  const averageManaValue=
    nonlandManaTotal/
    Math.max(1,nonlandCount);

  const score=Math.round(
    Math.min(
      100,
      55+
      Math.min(
        20,
        landCount>=desiredLands
          ?20
          :landCount*0.5
      )+
      Math.min(
        15,
        desiredRamp>=8
          ?10
          :5
      )+
      Math.min(
        10,
        deckCards
          .filter(card=>
            [
              "Interaction",
              "Card Advantage"
            ].includes(card.role)
          )
          .reduce(
            (sum,card)=>
              sum+card.count,
            0
          )*0.5
      )+
      Math.max(
        0,
        5-
        Math.abs(
          averageManaValue-
          options.targetManaValue
        )
      )
    )
  );

  let notes:string;

  if(slots<=0){
    notes=
      options.format==="commander"
        ?`Commander-Deck vollständig aus der vorhandenen Sammlung erstellt (${mainDeckCount} Karten im Hauptdeck plus ${commanders.length||1} Commander).`
        :"Standard-Deck vollständig aus der vorhandenen Sammlung erstellt.";
  }else if(
    options.format==="standard" &&
    eligible.length===0
  ){
    notes=
      `Es konnten keine Standard-legalen Karten mit der gewählten Farbauswahl gefunden werden. `+
      `Es fehlen daher noch ${slots} Karten.`;
  }else if(
    options.format==="standard"
  ){
    notes=
      `Das Deck wurde mit ${mainDeckCount} passenden Standard-legalen Karten aus deiner Sammlung erstellt. `+
      `Es fehlen noch ${slots} Karten bis zur Mindestgröße von 60.`;
  }else{
    const commanderCount=
      commanders.length||1;

    notes=
      `Das Commander-Deck wurde mit ${mainDeckCount} Karten im Hauptdeck erstellt. `+
      `Es fehlen noch ${slots} Karten bis zu ${100-commanderCount} Hauptdeck-Karten `+
      `plus ${commanderCount} Commander.`;
  }

  return {
    id:crypto.randomUUID(),
    name:options.name,
    format:options.format,
    commanderIds:commanders.map(
      card=>card.id
    ),
    cards:deckCards,
    sideboard:[],
    targetManaValue:
      options.targetManaValue,
    minManaValue:
      options.minManaValue,
    maxManaValue:
      options.maxManaValue,
    colors,
    createdAt:Date.now(),
    updatedAt:Date.now(),
    score,
    notes
  };
}

export function deckStats(
  deck:DeckRecord
) {
  const cards=deck.cards;

  const mainDeckCount=
    cards.reduce(
      (sum,card)=>sum+card.count,
      0
    );

  const commanderCount=
    deck.format==="commander"
      ?deck.commanderIds.length
      :0;

  const total=
    mainDeckCount+commanderCount;

  const lands=
    cards
      .filter(card=>
        /\bLand\b/i.test(
          card.typeLine??""
        )
      )
      .reduce(
        (sum,card)=>
          sum+card.count,
        0
      );

  const nonland=
    mainDeckCount-lands;

  const manaTotal=
    cards
      .filter(card=>
        !/\bLand\b/i.test(
          card.typeLine??""
        )
      )
      .reduce(
        (sum,card)=>
          sum+
          card.manaValue*
          card.count,
        0
      );

  const averageManaValue=
    manaTotal/
    Math.max(1,nonland);

  return {
    total,
    lands,
    nonland,
    averageManaValue:
      Number(
        averageManaValue.toFixed(2)
      ),
    roleCounts:
      cards.reduce<
        Record<string,number>
      >(
        (result,card)=>{
          result[card.role]=
            (result[card.role]??0)+
            card.count;

          return result;
        },
        {}
      )
  };
}
