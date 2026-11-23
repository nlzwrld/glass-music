/**
 * Encodes a user-selected image file into a crisp square 512x512 JPEG data URL
 * suitable for local SQLite playlist artwork on both Desktop and Android.
 */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const TARGET_SIZE = 512;
const MAX_DATA_URL_LEN = 650_000;

export async function encodePlaylistCoverFile(file: File): Promise<string> {
  if (!file || (file.type && !file.type.startsWith('image/'))) {
    throw new Error('Escolha uma imagem válida (JPG, PNG ou WebP).');
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error('A imagem é muito grande (máximo 15 MB).');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Não foi possível abrir esta imagem.'));
      el.src = objectUrl;
    });

    const sw = img.naturalWidth || img.width;
    const sh = img.naturalHeight || img.height;
    if (!sw || !sh) {
      throw new Error('Imagem inválida ou corrompida.');
    }

    const side = Math.min(sw, sh);
    const sx = Math.floor((sw - side) / 2);
    const sy = Math.floor((sh - side) / 2);
    const outSize = Math.min(TARGET_SIZE, Math.max(128, side));

    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Não foi possível processar a imagem.');
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, outSize, outSize);
    ctx.drawImage(img, sx, sy, side, side, 0, 0, outSize, outSize);

    let dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (dataUrl.length > MAX_DATA_URL_LEN) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    }
    if (dataUrl.length > MAX_DATA_URL_LEN) {
      throw new Error('Imagem excede o limite permitido.');
    }
    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
