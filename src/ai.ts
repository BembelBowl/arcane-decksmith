let generator: any = null;

export async function generateLocalExplanation(prompt: string): Promise<string> {
  try {
    if (!generator) {
      const mod = await import("@huggingface/transformers");
      generator = await mod.pipeline("text2text-generation", "Xenova/LaMini-Flan-T5-77M", { dtype: "q8" });
    }
    const out = await generator(`Antworte auf Deutsch kurz und sachlich. ${prompt}`, { max_new_tokens: 100, temperature: 0.4 });
    return String(out?.[0]?.generated_text ?? "").trim() || "Keine lokale KI-Antwort erhalten.";
  } catch {
    return "Die lokale KI konnte auf diesem Gerät nicht geladen werden. Die regelbasierte Begründung bleibt verfügbar.";
  }
}
