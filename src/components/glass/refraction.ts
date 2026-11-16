/** Rounded rectangle surface normals. Displacement is confined to a narrow bevel. */
export function edgeVector(x: number, y: number, width: number, height: number, radius: number, bevel: number): [number, number] {
  const r = Math.min(radius, width / 2, height / 2);
  const px = x - width / 2, py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0), length = Math.hypot(ax, ay);
  const inside = -(length + Math.min(Math.max(qx, qy), 0) - r);
  if (inside <= 0 || inside >= bevel) return [0, 0];
  const nx = length > 0 ? ax / length : qx > qy ? 1 : 0;
  const ny = length > 0 ? ay / length : qx > qy ? 0 : 1;
  // A smooth convex meniscus: maximum bending inside the rim, clean flat center.
  const bend = Math.sin(Math.PI * inside / bevel) ** 1.3;
  return [-Math.sign(px) * nx * bend, -Math.sign(py) * ny * bend];
}

const maps = new Map<string, string>();
export function displacementMap(width: number, height: number, radius: number, bevel: number) {
  const key = [width, height, radius, bevel].join(':');
  const cached = maps.get(key);
  if (cached) { maps.delete(key); maps.set(key, cached); return cached; }
  const ratio = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const [nx, ny] = edgeVector((x + .5) / ratio, (y + .5) / ratio, width, height, radius, bevel);
    const i = (y * canvas.width + x) * 4;
    pixels.data[i] = Math.round(127.5 + nx * 126); pixels.data[i + 1] = Math.round(127.5 + ny * 126);
    pixels.data[i + 2] = Math.round(Math.hypot(nx, ny) * 255); pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  const url = canvas.toDataURL(); maps.set(key, url);
  if (maps.size > 16) maps.delete(maps.keys().next().value!);
  return url;
}
