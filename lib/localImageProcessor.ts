export type ImageFilterPreset =
  | 'original'
  | 'noir'
  | 'warm_tungsten'
  | 'cold_berlin'
  | 'upscale_2x';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Bild konnte nicht im lokalen Canvas verarbeitet werden.'));
    img.src = src;
  });
}

export async function processImageLocally(
  imageUrl: string,
  preset: ImageFilterPreset
): Promise<{ dataUrl: string; width: number; height: number; operation: string }> {
  const img = await loadImage(imageUrl);
  const scale = preset === 'upscale_2x' ? 2 : 1;
  const maxDim = 2048;
  const rawW = img.width * scale;
  const rawH = img.height * scale;
  const ratio = Math.min(1, maxDim / Math.max(rawW, rawH));
  const width = Math.round(rawW * ratio);
  const height = Math.round(rawH * ratio);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D nicht verfügbar.');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (preset === 'noir') {
    ctx.filter = 'grayscale(100%) contrast(132%) brightness(94%)';
  } else if (preset === 'warm_tungsten') {
    ctx.filter = 'sepia(28%) contrast(112%) saturate(118%) brightness(98%)';
  } else if (preset === 'cold_berlin') {
    ctx.filter = 'hue-rotate(188deg) saturate(82%) contrast(115%) brightness(95%)';
    // Restore hue with subtle blue tint overlay instead
    ctx.filter = 'saturate(85%) contrast(116%) brightness(95%)';
  } else if (preset === 'upscale_2x') {
    ctx.filter = 'contrast(106%) saturate(104%)';
  }

  ctx.drawImage(img, 0, 0, width, height);

  if (preset === 'cold_berlin') {
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(20, 58, 112, 0.16)';
    ctx.fillRect(0, 0, width, height);
  }

  return {
    dataUrl: canvas.toDataURL('image/png'),
    width,
    height,
    operation:
      preset === 'upscale_2x'
        ? `Lokales 2x Upscaling (${width}x${height})`
        : `Lokales Grading (${preset})`,
  };
}
