import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "./firebase";
import type { ExternalImportResult } from "./importExport";

type ImportUrlResponse = ExternalImportResult & {
  deckName?: string;
  sourceUrl?: string;
};

function proxyUrl(): string | undefined {
  const configured = import.meta.env.VITE_IMPORT_PROXY_URL as string | undefined;
  return configured?.trim() || undefined;
}

export async function importExternalDeckUrl(url: string): Promise<ImportUrlResponse> {
  const value = url.trim();
  if (!value) throw new Error("Bitte eine Deck-URL eingeben.");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Die eingegebene URL ist ungültig.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Aus Sicherheitsgründen werden nur HTTPS-URLs unterstützt.");
  }

  const proxy = proxyUrl();
  if (proxy) {
    const endpoint = new URL(proxy);
    endpoint.searchParams.set("url", value);
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        headers: { Accept: "application/json" }
      });
    } catch {
      throw new Error(
        "Der Import-Dienst ist nicht erreichbar. Bitte später erneut versuchen oder das Deck als CSV/TXT importieren."
      );
    }
    const payload = await response.json().catch(() => null) as ImportUrlResponse | { error?: string } | null;
    if (!response.ok) {
      throw new Error(payload && "error" in payload && payload.error
        ? payload.error
        : `URL-Import fehlgeschlagen (${response.status}).`);
    }
    return payload as ImportUrlResponse;
  }

  if (!firebaseApp) {
    throw new Error(
      "Der URL-Import benötigt die Import-Proxy-Funktion. CSV/TXT-Import funktioniert weiterhin direkt im Browser."
    );
  }

  const functions = getFunctions(firebaseApp, "europe-west1");
  const call = httpsCallable<{ url: string }, ImportUrlResponse>(functions, "importExternalDeckUrl");
  try {
    const result = await call({ url: value });
    return result.data;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? "";
    if (code === "functions/unauthenticated") {
      throw new Error("Der URL-Import ist nur mit Konto verfügbar. Im Demo-Modus bitte CSV/TXT importieren.");
    }
    if (code === "functions/resource-exhausted") {
      throw new Error("Zu viele URL-Importe in kurzer Zeit. Bitte eine Minute warten.");
    }
    if (code === "functions/not-found" || code === "functions/internal") {
      throw new Error(
        "Die Import-Funktion ist nicht erreichbar (Cloud Functions/Blaze-Plan nötig). CSV/TXT-Import funktioniert weiterhin direkt im Browser."
      );
    }
    throw error instanceof Error ? error : new Error("URL-Import fehlgeschlagen.");
  }
}
