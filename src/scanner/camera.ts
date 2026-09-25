export type ScannerFrame = {
  full: HTMLCanvasElement;
  title: HTMLCanvasElement;
  metadata: HTMLCanvasElement;
};

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function drawCrop(
  source: HTMLCanvasElement,
  x: number,
  y: number,
  width: number,
  height: number,
  scale = 2
): HTMLCanvasElement {
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return canvas;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);

  // Lokale Kontrastanhebung für kleine Kartentexte. Kein hartes Thresholding,
  // damit helle und dunkle Frames gleichermaßen lesbar bleiben.
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

export function captureScannerFrame(video: HTMLVideoElement): ScannerFrame | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;

  const full = createCanvas(sourceWidth, sourceHeight);
  const ctx = full.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight);

  // MTG-Karten sind ca. 63 x 88 mm. Der Nutzer richtet die Karte im mittigen
  // Overlay aus; dieser Ausschnitt funktioniert unabhängig von der Displaygröße.
  const cardAspect = 63 / 88;
  let cardWidth = sourceWidth * 0.82;
  let cardHeight = cardWidth / cardAspect;
  if (cardHeight > sourceHeight * 0.88) {
    cardHeight = sourceHeight * 0.88;
    cardWidth = cardHeight * cardAspect;
  }

  const cardX = (sourceWidth - cardWidth) / 2;
  const cardY = (sourceHeight - cardHeight) / 2;

  const title = drawCrop(
    full,
    cardX + cardWidth * 0.055,
    cardY + cardHeight * 0.035,
    cardWidth * 0.89,
    cardHeight * 0.13,
    2.2
  );

  const metadata = drawCrop(
    full,
    cardX + cardWidth * 0.04,
    cardY + cardHeight * 0.80,
    cardWidth * 0.92,
    cardHeight * 0.17,
    2.6
  );

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
