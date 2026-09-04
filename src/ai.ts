function cleanText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim();
}

function hasRepetition(text: string): boolean {
  const normalized = text.toLowerCase();

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);

  if (words.length < 12) return false;

  // Erkennt kurze, ständig wiederholte Wortfolgen.
  for (let size = 2; size <= 8; size++) {
    const counts = new Map<string, number>();

    for (let i = 0; i <= words.length - size; i++) {
      const phrase = words.slice(i, i + size).join(" ");
      const count = (counts.get(phrase) ?? 0) + 1;

      if (count >= 4) {
        return true;
      }

      counts.set(phrase, count);
    }
  }

  return false;
}

function looksBroken(text: string): boolean {
  if (!text || text.length < 30) return true;

  const lower = text.toLowerCase();

  const badPatterns = [
    "follow the instructions",
    "provide more specific instructions",
    "do not provide any specific instructions",
    "the instructions are",
    "please provide more specific",
    "as an ai",
    "graphical representation of the graphical",
    "i cannot provide"
  ];

  return (
    badPatterns.some(pattern => lower.includes(pattern)) ||
    hasRepetition(text)
  );
}

function fallbackExplanation(prompt: string): string {
  const data = cleanText(prompt);

  return [
    "Deck-Analyse",
    "",
    "Das Deck wurde anhand der vorhandenen Deckdaten zusammengestellt.",
    "",
    data,
    "",
    "Die Auswahl berücksichtigt die festgelegte Mana-Kurve, verfügbare Karten und die Rollen der Karten im Deck.",
    "",
    "Achte beim weiteren Bearbeiten besonders auf ein ausgewogenes Verhältnis zwischen Ländern, Kartenziehen, Interaktion und Karten, die den eigentlichen Spielplan unterstützen."
  ].join("\n");
}

let generator: any = null;

export async function generateLocalExplanation(
  prompt: string
): Promise<string> {
  try {
    if (!generator) {
      const mod = await import("@huggingface/transformers");

      generator = await mod.pipeline(
        "text2text-generation",
        "Xenova/LaMini-Flan-T5-77M",
        {
          dtype: "q8"
        }
      );
    }

    const fullPrompt = `
Erkläre dieses Magic: The Gathering Deck.

WICHTIGE REGELN:
- Antworte ausschließlich auf Deutsch.
- Schreibe höchstens 8 kurze Sätze.
- Wiederhole keine Sätze oder Formulierungen.
- Erfinde keine Karten.
- Verwende ausschließlich die angegebenen Deckdaten.
- Erkläre den Spielplan.
- Erkläre die Mana-Kurve.
- Erwähne Länder und wichtige Kartenrollen.
- Nenne mögliche Schwächen.
- Schreibe keine Meta-Kommentare über diese Anweisung.

DECKDATEN:
${prompt}

DECK-ANALYSE AUF DEUTSCH:
`.trim();

    const result = await generator(fullPrompt, {
      max_new_tokens: 120,
      temperature: 0.1,
      repetition_penalty: 1.4,
      no_repeat_ngram_size: 3
    });

    const text = cleanText(
      String(result?.[0]?.generated_text ?? "")
    );

    if (looksBroken(text)) {
      return fallbackExplanation(prompt);
    }

    return text;
  } catch {
    return fallbackExplanation(prompt);
  }
}
