import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function writeBmp24(filePath, width, height, pixelFn) {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const fileSize = 54 + pixelBytes;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  buf.write('BM', 0, 2, 'ascii');
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10);

  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // bottom-up DIB
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // 24-bit RGB
  buf.writeUInt32LE(0, 30); // BI_RGB (uncompressed)
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y++) {
    const bmpRow = height - 1 - y;
    const rowOff = 54 + bmpRow * rowStride;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y, width, height);
      const off = rowOff + x * 3;
      buf[off] = clampByte(b);
      buf[off + 1] = clampByte(g);
      buf[off + 2] = clampByte(r);
    }
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, buf);
}

// Signed distance approximation for Liquid Hub droplet emblem centered at (cx, cy) with radius R
function dropletAlpha(x, y, cx, cy, r) {
  let hits = 0;
  const samples = 4;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + 0.5) / samples - cx) / r;
      const py = (y + (sy + 0.5) / samples - cy) / r;
      // Smooth tear-drop shape: bottom circle (y >= 0.1) + tapered top cone (-1.35..0.1)
      let inside = false;
      if (py >= 0.08) {
        inside = px * px + (py - 0.16) * (py - 0.16) <= 0.84 * 0.84;
      } else if (py >= -1.28) {
        const t = (py + 1.28) / 1.36; // 0 at tip, 1 at equator
        const halfW = 0.84 * Math.pow(t, 0.78);
        inside = Math.abs(px) <= halfW;
      }
      if (inside) {
        // Inner audio wave cutout across droplet center
        const waveY = 0.18 + Math.sin(px * 4.4) * 0.11;
        const onWave = Math.abs(px) <= 0.52 && Math.abs(py - waveY) <= 0.085;
        if (!onWave) hits++;
      }
    }
  }
  return hits / (samples * samples);
}

function renderSidebarPixel(x, y, w, h) {
  const nx = x / w;
  const ny = y / h;
  // Deep minimalist obsidian base
  let r = 11 + ny * 6;
  let g = 13 + ny * 9;
  let b = 16 + ny * 11;

  // Ambient emerald glow behind emblem
  const dx = (x - w * 0.5) / (w * 0.72);
  const dy = (y - h * 0.36) / (h * 0.32);
  const glow = Math.exp(-(dx * dx + dy * dy) * 2.2);
  r += glow * 26;
  g += glow * 78;
  b += glow * 64;

  // Subtle bottom glow
  const dx2 = (x - w * 0.25) / (w * 0.85);
  const dy2 = (y - h * 0.88) / (h * 0.28);
  const glow2 = Math.exp(-(dx2 * dx2 + dy2 * dy2) * 2.5);
  r += glow2 * 14;
  g += glow2 * 44;
  b += glow2 * 38;

  // Thin crisp accent hairline along right edge
  if (x === w - 1) {
    r = 46;
    g = 86;
    b = 76;
  }

  // Droplet emblem centered in upper third
  const alpha = dropletAlpha(x, y, w * 0.5, h * 0.36, 32);
  if (alpha > 0) {
    const grad = Math.max(0, Math.min(1, (y - (h * 0.36 - 40)) / 80));
    const er = 126 * (1 - grad) + 60 * grad;
    const eg = 228 * (1 - grad) + 166 * grad;
    const eb = 198 * (1 - grad) + 135 * grad;
    r = r * (1 - alpha) + er * alpha;
    g = g * (1 - alpha) + eg * alpha;
    b = b * (1 - alpha) + eb * alpha;
  }

  // Subtle horizontal minimalist accent bar below emblem
  if (y >= Math.round(h * 0.56) && y <= Math.round(h * 0.56) + 2 && x >= 44 && x <= w - 44) {
    r = 82;
    g = 183;
    b = 154;
  }

  return [r, g, b];
}

function renderHeaderPixel(x, y, w, h) {
  const nx = x / w;
  let r = 13 + nx * 6;
  let g = 16 + nx * 10;
  let b = 20 + nx * 9;

  const dx = (x - w * 0.78) / (w * 0.42);
  const dy = (y - h * 0.5) / (h * 0.9);
  const glow = Math.exp(-(dx * dx + dy * dy) * 2.0);
  r += glow * 22;
  g += glow * 64;
  b += glow * 54;

  // Droplet emblem on right side of header banner
  const alpha = dropletAlpha(x, y, w - 30, h * 0.52, 16);
  if (alpha > 0) {
    const grad = Math.max(0, Math.min(1, y / h));
    const er = 126 * (1 - grad) + 62 * grad;
    const eg = 228 * (1 - grad) + 168 * grad;
    const eb = 198 * (1 - grad) + 138 * grad;
    r = r * (1 - alpha) + er * alpha;
    g = g * (1 - alpha) + eg * alpha;
    b = b * (1 - alpha) + eb * alpha;
  }

  // Crisp bottom divider line
  if (y === h - 1) {
    r = 56;
    g = 128;
    b = 108;
  }

  return [r, g, b];
}

const outDir = resolve(process.cwd(), 'src-tauri', 'windows');
writeBmp24(resolve(outDir, 'nsis-sidebar.bmp'), 164, 314, renderSidebarPixel);
writeBmp24(resolve(outDir, 'nsis-header.bmp'), 150, 57, renderHeaderPixel);
console.log('Generated custom Liquid Hub NSIS bitmaps (164x314 sidebar, 150x57 header).');
