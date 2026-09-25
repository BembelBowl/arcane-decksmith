export type ScannerFrame = {
  full: HTMLCanvasElement;
  title: HTMLCanvasElement;
  metadata: HTMLCanvasElement;
};

type SourceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const CARD_ASPECT = 63 / 88;

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function visibleSourceRect(video: HTMLVideoElement): SourceRect | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const displayWidth = video.clientWidth;
  const displayHeight = video.clientHeight;
  if (!sourceWidth || !sourceHeight || !displayWidth || !displayHeight) return null;

  // Das Video wird mit object-fit: cover dargestellt. Dieser Ausschnitt bildet
  // exakt den tatsächlich sichtbaren Kamerabereich zurück auf die Videoquelle.
  const scale = Math.max(displayWidth / sourceWidth, displayHeight / sourceHeight);
  const visibleWidth = displayWidth / scale;
  const visibleHeight = displayHeight / scale;

  return {
    x: (sourceWidth - visibleWidth) / 2,
    y: (sourceHeight - visibleHeight) / 2,
    width: visibleWidth,
    height: visibleHeight
  };
}

function scannerCardRect(video: HTMLVideoElement): SourceRect | null {
  const visible = visibleSourceRect(video);
  if (!visible) return null;

  const displayWidth = video.clientWidth;
  const displayHeight = video.clientHeight;
  const displayCardWidth = Math.min(
    displayWidth * 0.82,
    displayHeight * 0.78 * CARD_ASPECT
  );
  const displayCardHeight = displayCardWidth / CARD_ASPECT;
  const displayCardX = (displayWidth - displayCardWidth) / 2;
  const displayCardY = displayHeight * 0.46 - displayCardHeight / 2;

  const xRatio = visible.width / displayWidth;
  const yRatio = visible.height / displayHeight;

  return {
    x: visible.x + displayCardX * xRatio,
    y: visible.y + displayCardY * yRatio,
    width: displayCardWidth * xRatio,
    height: displayCardHeight * yRatio
  };
}

function drawVideoCrop(
  video: HTMLVideoElement,
  rect: SourceRect,
  maxWidth: number,
  upscale = 2
): HTMLCanvasElement {
  const targetWidth = Math.min(maxWidth, Math.max(rect.width, rect.width * upscale));
  const targetHeight = targetWidth * (rect.height / rect.width);
  const canvas = createCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    video,
    rect.x, rect.y, rect.width, rect.height,
    0, 0, canvas.width, canvas.height
  );

  // Die OCR bekommt nur kleine Ausschnitte. Kontrastanhebung bleibt erhalten,
  // wird aber auf deutlich weniger Pixel angewendet als zuvor.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
    data[i] = contrasted;
    data[i + 1] = contrasted;
    data[i + 2] = contrasted;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function captureScannerMetadataFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const card = scannerCardRect(video);
  if (!card) return null;

  return drawVideoCrop(
    video,
    {
      x: card.x + card.width * 0.04,
      y: card.y + card.height * 0.80,
      width: card.width * 0.92,
      height: card.height * 0.17
    },
    900,
    2.15
  );
}

export function captureScannerTitleFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const card = scannerCardRect(video);
  if (!card) return null;

  return drawVideoCrop(
    video,
    {
      x: card.x + card.width * 0.055,
      y: card.y + card.height * 0.035,
      width: card.width * 0.89,
      height: card.height * 0.13
    },
    820,
    2
  );
}

// Kompatibilitätsfunktion für möglichen späteren Gebrauch. Der Scanner selbst
// nutzt die beiden separaten Fast-/Fallback-Crops, damit nicht unnötig beide
// OCR-Bilder pro Durchlauf erzeugt werden.
export function captureScannerFrame(video: HTMLVideoElement): ScannerFrame | null {
  const title = captureScannerTitleFrame(video);
  const metadata = captureScannerMetadataFrame(video);
  if (!title || !metadata) return null;

  const full = createCanvas(video.videoWidth, video.videoHeight);
  const ctx = full.getContext("2d");
  if (ctx) ctx.drawImage(video, 0, 0, full.width, full.height);
  return { full, title, metadata };
}

export async function openBackCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Dieser Browser unterstützt keinen Kamerazugriff.");
  }

  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    }
  });
}

export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach(track => track.stop());
}

export async function setTorch(stream: MediaStream, enabled: boolean): Promise<boolean> {
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const capabilities = track.getCapabilities?.() as MediaTrackCapabilities & { torch?: boolean };
  if (!capabilities?.torch) return false;

  try {
    await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

export function supportsTorch(stream: MediaStream | null): boolean {
  const track = stream?.getVideoTracks()[0];
  if (!track?.getCapabilities) return false;
  const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
  return capabilities.torch === true;
}
