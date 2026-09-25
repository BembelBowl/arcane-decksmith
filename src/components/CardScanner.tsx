import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  getCardByFuzzyName,
  getCardsBySetAndCollectorNumbers,
  getPrintings,
  getSets,
  imageFor,
  type ScryfallCard,
  type ScryfallSet
} from "../scryfall";
import type { CardFinish } from "../types";
import {
  captureScannerMetadataFrame,
  captureScannerTitleFrame,
  openBackCamera,
  setTorch,
  stopCamera,
  supportsTorch
} from "../scanner/camera";
import {
  normalizeCardNameCandidate,
  parseScannerMetadata,
  rankPrintings,
  shouldIgnoreName,
  type RecognitionCandidate
} from "../scanner/cardRecognition";

type CardScannerProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (card: ScryfallCard, finish: CardFinish) => Promise<void>;
};

type TesseractResult = { data: { text: string; confidence?: number } };
type TesseractWorker = {
  recognize: (image: CanvasImageSource) => Promise<TesseractResult>;
  terminate: () => Promise<void>;
};
type TesseractModule = {
  createWorker: (
    langs?: string | string[],
    oem?: number,
    options?: { logger?: (message: { status?: string; progress?: number }) => void }
  ) => Promise<TesseractWorker>;
};

type TesseractWindow = Window & { Tesseract?: TesseractModule };

const TESSERACT_SCRIPT = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js";
let tesseractModulePromise: Promise<TesseractModule> | null = null;
let tesseractWorkerPromise: Promise<TesseractWorker> | null = null;
const exactPrintingCache = new Map<string, Promise<ScryfallCard[]>>();
const fuzzyCardCache = new Map<string, Promise<ScryfallCard | null>>();
const SCAN_DELAY_MS = 380;
const HIGH_CONFIDENCE = 92;
const MEDIUM_CONFIDENCE = 60;

function finishOptions(card: ScryfallCard): CardFinish[] {
  const result: CardFinish[] = [];
  const finishes = new Set(card.finishes ?? []);
  if (card.nonfoil || finishes.has("nonfoil") || card.prices?.eur) result.push("nonfoil");
  if (card.foil || finishes.has("foil") || card.prices?.eur_foil) result.push("foil");
  return result.length > 0 ? result : ["nonfoil"];
}

function candidateLabel(candidate: RecognitionCandidate): string {
  const card = candidate.card;
  return `${card.set_name ?? card.set.toUpperCase()} · #${card.collector_number}`;
}

function confidenceLabel(score: number): string {
  if (score >= HIGH_CONFIDENCE) return "Sehr sicher";
  if (score >= MEDIUM_CONFIDENCE) return "Wahrscheinlich";
  return "Bitte prüfen";
}

function getLoadedTesseract(): TesseractModule | null {
  const api = (window as TesseractWindow).Tesseract;
  return api && typeof api.createWorker === "function" ? api : null;
}

function loadTesseractModule(): Promise<TesseractModule> {
  const loaded = getLoadedTesseract();
  if (loaded) return Promise.resolve(loaded);
  if (tesseractModulePromise) return tesseractModulePromise;

  tesseractModulePromise = new Promise<TesseractModule>((resolve, reject) => {
    const finish = () => {
      const api = getLoadedTesseract();
      if (api) {
        resolve(api);
      } else {
        reject(new Error("Tesseract wurde geladen, stellt aber createWorker nicht bereit."));
      }
    };

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TESSERACT_SCRIPT}"]`
    );

    // Wenn ein früherer Ladevorgang ein Script-Element hinterlassen hat, aber
    // keine globale Tesseract-API verfügbar ist, laden wir sauber neu.
    existing?.remove();

    const script = document.createElement("script");
    script.src = TESSERACT_SCRIPT;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Texterkennung konnte nicht geladen werden.")),
      { once: true }
    );
    document.head.appendChild(script);
  }).catch(error => {
    // Nach einem temporären Netzwerkfehler darf ein erneuter Scanner-Start
    // einen neuen Ladeversuch unternehmen.
    tesseractModulePromise = null;
    throw error;
  });

  return tesseractModulePromise;
}

async function loadTesseract(): Promise<TesseractWorker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = loadTesseractModule()
      .then(tesseract => tesseract.createWorker(["eng", "deu"], 1))
      .catch(error => {
        tesseractWorkerPromise = null;
        throw error;
      });
  }

  return tesseractWorkerPromise;
}

async function lookupExactPrinting(
  setCode: string,
  collectorNumber: string
): Promise<ScryfallCard[]> {
  const key = `${setCode.toLowerCase()}:${collectorNumber.toLowerCase()}`;
  let pending = exactPrintingCache.get(key);
  if (!pending) {
    pending = getCardsBySetAndCollectorNumbers(setCode, [collectorNumber])
      .then(result => result.cards)
      .catch(error => {
        exactPrintingCache.delete(key);
        throw error;
      });
    exactPrintingCache.set(key, pending);
  }
  return pending;
}

async function lookupFuzzyCard(name: string): Promise<ScryfallCard | null> {
  const key = name.trim().toLocaleLowerCase();
  let pending = fuzzyCardCache.get(key);
  if (!pending) {
    pending = getCardByFuzzyName(name).catch(error => {
      fuzzyCardCache.delete(key);
      throw error;
    });
    fuzzyCardCache.set(key, pending);
  }
  return pending;
}

export default function CardScanner({ open, onClose, onAdd }: CardScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<TesseractWorker | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const scanningRef = useRef(false);
  const stableRef = useRef<{ id: string; count: number }>({ id: "", count: 0 });

  const [sets, setSets] = useState<ScryfallSet[]>([]);
  const [error, setError] = useState("");
  const [candidates, setCandidates] = useState<RecognitionCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [finish, setFinish] = useState<CardFinish>("nonfoil");
  const [adding, setAdding] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [addedMessage, setAddedMessage] = useState("");

  const selected = useMemo(
    () => candidates.find(candidate => candidate.card.id === selectedId) ?? candidates[0] ?? null,
    [candidates, selectedId]
  );

  useEffect(() => {
    if (!selected) return;
    const options = finishOptions(selected.card);
    if (!options.includes(finish)) setFinish(options[0]);
  }, [finish, selected]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    cancelledRef.current = false;
    setError("");
    setCandidates([]);
    setSelectedId(null);
    setAddedMessage("");
    setPaused(false);
    stableRef.current = { id: "", count: 0 };

    const boot = async () => {
      try {
        const [catalog, stream, worker] = await Promise.all([
          getSets(),
          openBackCamera(),
          loadTesseract()
        ]);

        if (cancelledRef.current) {
          stopCamera(stream);
          return;
        }

        setSets(catalog);
        streamRef.current = stream;
        workerRef.current = worker;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }

        setTorchAvailable(supportsTorch(stream));
      } catch (cause) {
        console.error(cause);
        setError(
          cause instanceof Error
            ? cause.message
            : "Kamera oder Texterkennung konnte nicht gestartet werden."
        );
      }
    };

    void boot();

    return () => {
      cancelledRef.current = true;
      if (scanTimerRef.current !== null) window.clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
      stopCamera(streamRef.current);
      streamRef.current = null;
      workerRef.current = null;
      scanningRef.current = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open || error || paused || !sets.length) return;

    const schedule = (delay = SCAN_DELAY_MS) => {
      if (cancelledRef.current || paused) return;
      scanTimerRef.current = window.setTimeout(() => void scanOnce(), delay);
    };

    const scanOnce = async () => {
      if (scanningRef.current || cancelledRef.current || paused) return;
      const video = videoRef.current;
      const worker = workerRef.current;
      if (!video || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        schedule(500);
        return;
      }

      scanningRef.current = true;

      try {
        // Fast Path: zuerst nur den kleinen Metadatenbereich lesen. Set +
        // Collector Number reichen aus, um das Printing eindeutig zu bestimmen.
        const metadataFrame = captureScannerMetadataFrame(video);
        if (!metadataFrame) {
          schedule(250);
          return;
        }

        const metadataResult = await worker.recognize(metadataFrame);
        if (cancelledRef.current) return;

        const parsedMetadata = parseScannerMetadata(metadataResult.data.text, sets);
    
        let ranked: RecognitionCandidate[] = [];
        let exactPrinting = false;
        let name = "";

        if (parsedMetadata.setCode && parsedMetadata.collectorNumber) {
          const exactCards = await lookupExactPrinting(
            parsedMetadata.setCode,
            parsedMetadata.collectorNumber
          );

          if (exactCards.length > 0) {
            let matchingCards = exactCards;

            if (parsedMetadata.language) {
              const allPrintings = await getPrintings(exactCards[0]);
              const localized = allPrintings.filter(card =>
                card.set.toLowerCase() === parsedMetadata.setCode &&
                card.collector_number.toLowerCase() === parsedMetadata.collectorNumber &&
                card.lang?.toLowerCase() === parsedMetadata.language
              );
              if (localized.length > 0) matchingCards = localized;
            }

            ranked = rankPrintings(matchingCards, "", parsedMetadata).map(candidate => ({
              ...candidate,
              score: Math.max(candidate.score, 98),
              reasons: candidate.reasons.length
                ? candidate.reasons
                : ["Set und Collector Number stimmen überein"]
            }));
            exactPrinting = true;
          }
        }

        // Slow Path nur bei Bedarf: Der deutlich teurere Namens-OCR-Lauf wird
        // komplett übersprungen, sobald Set + Collector Number erfolgreich waren.
        if (ranked.length === 0) {
          const titleFrame = captureScannerTitleFrame(video);
          if (titleFrame) {
            const titleResult = await worker.recognize(titleFrame);
            if (cancelledRef.current) return;
            name = normalizeCardNameCandidate(titleResult.data.text);
          }

          if (name && !shouldIgnoreName(name)) {
            const fuzzy = await lookupFuzzyCard(name);
            if (fuzzy) {
              const printings = await getPrintings(fuzzy);
              ranked = rankPrintings(printings, name, parsedMetadata).slice(0, 8);
            }
          }
        }

        if (ranked.length === 0) {
          stableRef.current = { id: "", count: 0 };
          setCandidates([]);
          setSelectedId(null);
          schedule(380);
          return;
        }

        const top = ranked[0];

        // Ein gültiger Scryfall-Treffer über Set + Collector Number ist bereits
        // eindeutig. Dafür ist kein zweiter OCR-Durchlauf nötig.
        if (exactPrinting) {
          stableRef.current = { id: top.card.id, count: 1 };
          setCandidates(ranked);
          setSelectedId(top.card.id);
          setPaused(true);
          return;
        }

        const stable = stableRef.current.id === top.card.id
          ? { id: top.card.id, count: stableRef.current.count + 1 }
          : { id: top.card.id, count: 1 };
        stableRef.current = stable;

        const stabilityBonus = stable.count >= 2 ? 5 : 0;
        const adjusted = ranked.map((candidate, index) =>
          index === 0
            ? { ...candidate, score: Math.min(100, candidate.score + stabilityBonus) }
            : candidate
        );

        setCandidates(adjusted);
        setSelectedId(top.card.id);

        const score = adjusted[0].score;
        if (score >= HIGH_CONFIDENCE && stable.count >= 2) {
          setPaused(true);
        } else if (score >= MEDIUM_CONFIDENCE) {
          setPaused(true);
        } else {
          schedule(420);
        }
      } catch (cause) {
        console.error(cause);
        schedule(600);
      } finally {
        scanningRef.current = false;
      }
    };

    schedule(180);
    return () => {
      if (scanTimerRef.current !== null) window.clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    };
  }, [error, open, paused, sets]);

  if (!open) return null;

  const resumeScanning = () => {
    setCandidates([]);
    setSelectedId(null);
    setAddedMessage("");
    stableRef.current = { id: "", count: 0 };
    setPaused(false);
  };

  const addSelected = async () => {
    if (!selected || adding) return;
    setAdding(true);
    try {
      await onAdd(selected.card, finish);
      if (navigator.vibrate) navigator.vibrate(80);
      setAddedMessage(`${selected.card.name} wurde zur Sammlung hinzugefügt.`);
      window.setTimeout(() => {
        if (!cancelledRef.current) resumeScanning();
      }, 1200);
    } catch (cause) {
      console.error(cause);
      setError(cause instanceof Error ? cause.message : "Karte konnte nicht gespeichert werden.");
    } finally {
      setAdding(false);
    }
  };

  const toggleTorch = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    const next = !torchOn;
    if (await setTorch(stream, next)) setTorchOn(next);
  };

  return createPortal(
    <div className="scanner-backdrop" role="dialog" aria-modal="true" aria-label="Kartenscanner">
      <div className="scanner-shell">
        <div className="scanner-camera">
          <video ref={videoRef} playsInline muted autoPlay />
          <button className="scanner-close" type="button" onClick={onClose} aria-label="Scanner schließen">×</button>
          <div className="scanner-card-guide" aria-hidden="true">
            <span className="scanner-guide-title">Name</span>
            <span className="scanner-guide-bottom">Set / Collector Number</span>
          </div>
          {!paused && !error && <div className="scanner-sweep" aria-hidden="true" />}
          {torchAvailable && (
            <button className="scanner-torch secondary" type="button" onClick={() => void toggleTorch()}>
              {torchOn ? "Licht aus" : "Licht an"}
            </button>
          )}
        </div>

        {error ? (
          <div className="scanner-panel scanner-error">
            <strong>Scanner nicht verfügbar</strong>
            <p>{error}</p>
            <button className="secondary" type="button" onClick={onClose}>Schließen</button>
          </div>
        ) : (
          <div className="scanner-panel">
            {addedMessage && <div className="scanner-success">✓ {addedMessage}</div>}

            {selected ? (
              <div className="scanner-result">
                <div className="scanner-result-main">
                  {imageFor(selected.card) && (
                    <img src={imageFor(selected.card)} alt="" />
                  )}
                  <div>
                    <div className="scanner-confidence">
                      <strong>{confidenceLabel(selected.score)}</strong>
                      <span>{selected.score}%</span>
                    </div>
                    <h3>{selected.card.name}</h3>
                    <p>{candidateLabel(selected)}</p>
                    {selected.reasons.length > 0 && (
                      <small>{selected.reasons.join(" · ")}</small>
                    )}
                  </div>
                </div>

                {candidates.length > 1 && (
                  <label className="scanner-version-select">
                    <span>Version</span>
                    <select
                      value={selected.card.id}
                      onChange={event => setSelectedId(event.target.value)}
                    >
                      {candidates.map(candidate => (
                        <option key={candidate.card.id} value={candidate.card.id}>
                          {candidate.card.set.toUpperCase()} #{candidate.card.collector_number} · {candidate.card.set_name ?? candidate.card.set}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                <div className="scanner-finish-row">
                  {finishOptions(selected.card).map(option => (
                    <label key={option}>
                      <input
                        type="radio"
                        name="scanner-finish"
                        value={option}
                        checked={finish === option}
                        onChange={() => setFinish(option)}
                      />
                      {option === "foil" ? "Foil" : "Non-Foil"}
                    </label>
                  ))}
                </div>

                <div className="scanner-result-actions">
                  <button className="secondary" type="button" onClick={resumeScanning}>Neu scannen</button>
                  <button type="button" onClick={() => void addSelected()} disabled={adding}>
                    {adding ? "Speichern…" : "+1 zur Sammlung"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="scanner-hint">
                <strong>Karte vollständig in den Rahmen halten.</strong>
                <span>Die erkannte Karte erscheint unten. Für die genaue Version liest der Scanner zusätzlich Set und Collector Number am unteren Kartenrand.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
