let generator: any = null;

function fallbackExplanation(prompt: string): string {
  return [
    "Die lokale KI hat keine brauchbare Erklärung erzeugt.",
    "",
    "Regelbasierte Zusammenfassung:",
    prompt
  ].join("\n");
}

function looksLikeBadMetaAnswer(text: string): boolean {
  const normalized = text.toLowerCase();

  const badPatterns = [
    "follow the instructions",
    "provide more specific instructions",
    "do not provide any specific instructions",
    "the instructions are",
    "please provide more specific",
    "i cannot provide",
    "as an ai"
  ];

  return badPatterns.some(pattern => normalized.includes(pattern));
}

export async function generateLocalExplanation(prompt: string): Promise<string> {
  try {
    if (!generator) {
      const mod = await import("@huggingface/transformers");

      generator = await mod.pipeline(
        "text2text-generation",
        "Xenova/LaMini-Flan-T5-77M",
        { dtype: "q8" }
      );
    }

    const fullPrompt = `
Du bist ein Assistent für Magic: The Gathering.

Erkläre ausschließlich das beschriebene Deck.
Antworte auf Deutsch.
Schreibe kurz, konkret und sachlich.
Beschreibe:
- die grundlegende Spielidee,
- wichtige Kartenrollen,
- Mana-Kurve und Länder,
- mögliche Schwächen.

Gib keine Meta-Kommentare über Anweisungen oder Prompts aus.

Deckdaten:
${prompt}

Deck-Erklärung:
`.trim();

    const out = await generator(fullPrompt, {
      max_new_tokens: 140,
      temperature: 0.2
    });

    const text = String(out?.[0]?.generated_text ?? "").trim();

    if (!text || text.length < 30 || looksLikeBadMetaAnswer(text)) {
      return fallbackExplanation(prompt);
    }

    return text;
  } catch {
    return "Die lokale KI konnte auf diesem Gerät nicht geladen werden. Die regelbasierte Begründung bleibt verfügbar.";
  }
}
