type SourceRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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

  // Das Video wird mit object-fit: cover dargestellt. Wir lesen deshalb exakt
  // den Bereich aus, der auf dem Display sichtbar ist – nicht nur einen Rahmen.
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

function drawVideoCrop(
  video: HTMLVideoElement,
  rect: SourceRect,
  maxWidth: number
): HTMLCanvasElement {
  const targetWidth = Math.min(maxWidth, rect.width);
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

  // Moderate Graustufen-/Kontrastanhebung für OCR über das gesamte Bild.
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const contrasted = Math.max(0, Math.min(255, (gray - 128) * 1.28 + 128));
    data[i] = contrasted;
    data[i + 1] = contrasted;
    data[i + 2] = contrasted;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Liefert den kompletten sichtbaren Kamerabereich für die OCR. Dadurch kann die
 * Karte beliebig im Vollbild liegen; ein fest definierter Kartenrahmen ist nicht
 * mehr Teil der Erkennungslogik.
 */
export function captureScannerFullFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const visible = visibleSourceRect(video);
  if (!visible) return null;
  return drawVideoCrop(video, visible, 900);
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
