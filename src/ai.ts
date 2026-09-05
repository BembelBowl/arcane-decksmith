import { auth } from "./firebase";
import { DeckRecord } from "./types";

type RoleCounts = Record<string, number>;

function countCards(
  deck: DeckRecord,
  predicate: (card: DeckRecord["cards"][number]) => boolean
): number {
  return deck.cards
    .filter(predicate)
    .reduce((sum, card) => sum + card.count, 0);
}

function roleCounts(deck: DeckRecord): RoleCounts {
  const result: RoleCounts = {};

  for (const card of deck.cards) {
    const role = card.role?.trim() || "Sonstiges";
    result[role] = (result[role] ?? 0) + card.count;
  }

  return result;
}

function findRole(
  roles: RoleCounts,
  terms: string[]
): number {
  return Object.entries(roles)
    .filter(([role]) =>
      terms.some(term =>
        role.toLowerCase().includes(term.toLowerCase())
      )
    )
    .reduce((sum, [, count]) => sum + count, 0);
}

function averageManaValue(deck: DeckRecord): number {
  let totalMana = 0;
  let totalCards = 0;

  for (const card of deck.cards) {
    if (/land/i.test(card.typeLine ?? "")) {
      continue;
    }

    totalMana += (card.manaValue ?? 0) * card.count;
    totalCards += card.count;
  }

  if (totalCards === 0) return 0;

  return Number((totalMana / totalCards).toFixed(2));
}

function manaCurve(deck: DeckRecord) {
  const curve = {
    "0–1": 0,
    "2": 0,
    "3": 0,
    "4": 0,
    "5+": 0
  };

  for (const card of deck.cards) {
    if (/land/i.test(card.typeLine ?? "")) {
      continue;
    }

    const mv = card.manaValue ?? 0;

    let bucket: keyof typeof curve;

    if (mv <= 1) bucket = "0–1";
    else if (mv === 2) bucket = "2";
    else if (mv === 3) bucket = "3";
    else if (mv === 4) bucket = "4";
    else bucket = "5+";

    curve[bucket] += card.count;
  }

  return curve;
}

function largestCurveArea(
  curve: ReturnType<typeof manaCurve>
): string {
  const entries = Object.entries(curve);

  if (!entries.length) return "nicht erkennbar";

  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

function createStrengths(
  lands: number,
  creatures: number,
  ramp: number,
  draw: number,
  interaction: number,
  avgMv: number
): string[] {
  const strengths: string[] = [];

  if (ramp >= 8) {
    strengths.push(
      `Mit ${ramp} Ramp-Karten besitzt das Deck eine gute Mana-Beschleunigung.`
    );
  }

  if (draw >= 7) {
    strengths.push(
      `${draw} Karten für Kartennachschub helfen dabei, im Spiel nicht zu schnell die Ressourcen zu verlieren.`
    );
  }

  if (interaction >= 7) {
    strengths.push(
      `${interaction} Interaktionskarten geben dem Deck gute Möglichkeiten, auf gegnerische Bedrohungen zu reagieren.`
    );
  }

  if (creatures >= 20) {
    strengths.push(
      `Mit ${creatures} Kreaturen hat das Deck eine deutliche Präsenz auf dem Spielfeld.`
    );
  }

  if (avgMv > 0 && avgMv <= 3.2) {
    strengths.push(
      `Der durchschnittliche Mana Value von ${avgMv} spricht für eine vergleichsweise niedrige und gut spielbare Mana-Kurve.`
    );
  }

  if (lands > 0 && strengths.length === 0) {
    strengths.push(
      "Die Deckstruktur ist grundsätzlich spielbar, sollte aber nach einigen Testspielen weiter abgestimmt werden."
    );
  }

  return strengths;
}

function createWeaknesses(
  deck: DeckRecord,
  lands: number,
  ramp: number,
  draw: number,
  interaction: number,
  avgMv: number
): string[] {
  const weaknesses: string[] = [];

  if (deck.format === "commander") {
    if (lands < 33) {
      weaknesses.push(
        `Mit nur ${lands} Ländern könnte das Deck Schwierigkeiten haben, zuverlässig genug Mana zu ziehen.`
      );
    }

    if (lands > 42) {
      weaknesses.push(
        `Mit ${lands} Ländern ist der Länderanteil relativ hoch; möglicherweise können einige davon durch wirkungsvolle Nichtländer ersetzt werden.`
      );
    }

    if (ramp < 7) {
      weaknesses.push(
        `Nur ${ramp} Ramp-Karten könnten für Commander etwas wenig Mana-Beschleunigung sein.`
      );
    }

    if (draw < 6) {
      weaknesses.push(
        `Mit nur ${draw} Karten für Kartennachschub könnte dem Deck in längeren Spielen die Hand ausgehen.`
      );
    }

    if (interaction < 6) {
      weaknesses.push(
        `Mit nur ${interaction} Interaktionskarten könnte das Deck Schwierigkeiten gegen gegnerische Schlüsselpermanents haben.`
      );
    }
  }

  if (deck.format === "standard") {
    if (lands < 20) {
      weaknesses.push(
        `Mit ${lands} Ländern könnte die Manabasis für ein Standard-Deck zu knapp sein.`
      );
    }

    if (lands > 28) {
      weaknesses.push(
        `Mit ${lands} Ländern könnte das Deck häufiger zu viele Länder ziehen.`
      );
    }

    if (interaction < 4) {
      weaknesses.push(
        "Das Deck besitzt nur wenig Interaktion mit dem gegnerischen Spielplan."
      );
    }
  }

  if (avgMv >= 4) {
    weaknesses.push(
      `Der durchschnittliche Mana Value von ${avgMv} ist relativ hoch. Das Deck könnte dadurch langsam ins Spiel kommen.`
    );
  }

  if (weaknesses.length === 0) {
    weaknesses.push(
      "Aus den reinen Deckdaten ist keine besonders auffällige strukturelle Schwäche erkennbar. Testspiele bleiben für die Feinabstimmung wichtig."
    );
  }

  return weaknesses;
}

export function generateDeckExplanation(
  deck: DeckRecord
): string {
  const mainDeckCards = deck.cards.reduce(
    (sum, card) => sum + card.count,
    0
  );

  const commanderCount =
    deck.format === "commander"
      ? deck.commanderIds?.length ?? 0
      : 0;

  const total = mainDeckCards + commanderCount;

  const lands = countCards(
    deck,
    card => /land/i.test(card.typeLine ?? "")
  );

  const creatures = countCards(
    deck,
    card => /creature/i.test(card.typeLine ?? "")
  );

  const nonlands = mainDeckCards - lands;
  const avgMv = averageManaValue(deck);
  const roles = roleCounts(deck);

  const ramp = findRole(
    roles,
    ["ramp", "mana", "beschleunigung"]
  );

  const draw = findRole(
    roles,
    ["draw", "card draw", "kartenziehen", "karten ziehen"]
  );

  const interaction = findRole(
    roles,
    [
      "interaction",
      "interaktion",
      "removal",
      "counter",
      "entfernung"
    ]
  );

  const tutors = findRole(
    roles,
    ["tutor", "suche"]
  );

  const curve = manaCurve(deck);
  const curvePeak = largestCurveArea(curve);

  const strengths = createStrengths(
    lands,
    creatures,
    ramp,
    draw,
    interaction,
    avgMv
  );

  const weaknesses = createWeaknesses(
    deck,
    lands,
    ramp,
    draw,
    interaction,
    avgMv
  );

  const roleParts: string[] = [];

  if (ramp > 0) roleParts.push(`${ramp} Ramp`);
  if (draw > 0) roleParts.push(`${draw} Kartennachschub`);
  if (interaction > 0) {
    roleParts.push(`${interaction} Interaktion`);
  }
  if (tutors > 0) roleParts.push(`${tutors} Tutoren`);

  const roleText =
    roleParts.length > 0
      ? roleParts.join(", ")
      : "keine eindeutig klassifizierten Spezialrollen";

  return [
    `DECKANALYSE – ${deck.name}`,
    "",
    `Format: ${
      deck.format === "commander"
        ? "Commander"
        : "Standard"
    }`,
    `Karten: ${total} insgesamt · ${lands} Länder · ${nonlands} Nichtländer`,
    `Kreaturen: ${creatures}`,
    `Durchschnittlicher Mana Value: ${avgMv}`,
    "",
    "MANA-KURVE",
    `MV 0–1: ${curve["0–1"]}`,
    `MV 2: ${curve["2"]}`,
    `MV 3: ${curve["3"]}`,
    `MV 4: ${curve["4"]}`,
    `MV 5+: ${curve["5+"]}`,
    `Der größte Teil der Mana-Kurve liegt bei MV ${curvePeak}.`,
    "",
    "KARTENROLLEN",
    roleText,
    "",
    "STÄRKEN",
    ...strengths.map(text => `• ${text}`),
    "",
    "MÖGLICHE SCHWÄCHEN",
    ...weaknesses.map(text => `• ${text}`)
  ].join("\n");
}

const AI_WORKER_URL =
  "https://arcane-decksmith-ai.benjamin-ambros.workers.dev";

export async function generateAiDeckExplanation(
  deck: DeckRecord
): Promise<string> {
  const user = auth?.currentUser;

  if (!user) {
    throw new Error("Du musst angemeldet sein, um die KI-Analyse zu verwenden.");
  }

  const idToken = await user.getIdToken();

  const analysis = generateDeckExplanation(deck);

  const response = await fetch(AI_WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    },
    body: JSON.stringify({
      analysis
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error ?? "Die KI-Analyse ist fehlgeschlagen."
    );
  }

  if (!data?.explanation) {
    throw new Error("Die KI hat keine Erklärung zurückgegeben.");
  }

  return data.explanation;
}
