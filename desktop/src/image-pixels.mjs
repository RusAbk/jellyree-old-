// A separate CPU pipeline for Desktop, shared by preview/export and tested without a DOM.
const clamp = (n, min = 0, max = 255) => Math.max(min, Math.min(max, n));
const mix = (a, b, amount) => a + (b - a) * amount;
const luminance = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;
function blur(input, width, height, radius) {
  const temp = new Float32Array(input.length),
    out = new Float32Array(input.length);
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += input[y * width + clamp(k, 0, width - 1)];
    for (let x = 0; x < width; x++) {
      temp[y * width + x] = sum / (radius * 2 + 1);
      sum +=
        input[y * width + clamp(x + radius + 1, 0, width - 1)] -
        input[y * width + clamp(x - radius, 0, width - 1)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++)
      sum += temp[clamp(k, 0, height - 1) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / (radius * 2 + 1);
      sum +=
        temp[clamp(y + radius + 1, 0, height - 1) * width + x] -
        temp[clamp(y - radius, 0, height - 1) * width + x];
    }
  }
  return out;
}
export function adjustPixels(source, width, height, a) {
  const out = new Uint8ClampedArray(source.length),
    exposure = 2 ** (a.exposure / 50),
    contrast = a.contrast / 100;
  for (let i = 0; i < source.length; i += 4) {
    let r = (source[i] * exposure * a.brightness) / 100,
      g = (source[i + 1] * exposure * a.brightness) / 100,
      b = (source[i + 2] * exposure * a.brightness) / 100;
    const l = clamp(luminance(r, g, b) / 255, 0, 1);
    const lift = a.shadows * 0.8 * (1 - l) ** 3 + a.highlights * 0.8 * l ** 3;
    r =
      (r - 127.5) * contrast +
      127.5 +
      lift +
      a.temperature * 0.32 +
      a.tint * 0.14;
    g = (g - 127.5) * contrast + 127.5 + lift - a.tint * 0.24;
    b =
      (b - 127.5) * contrast +
      127.5 +
      lift -
      a.temperature * 0.32 +
      a.tint * 0.14;
    if (a.toneDepth) {
      const depth = a.toneDepth / 100;
      const curve = (value) => {
        const v = clamp(value / 255, 0, 1);
        return 255 * (v + depth * (v - 0.5) * v * (1 - v) * 2);
      };
      r = curve(r);
      g = curve(g);
      b = curve(b);
    }
    const gray = luminance(r, g, b),
      spread = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const saturation =
      a.saturation / 100 +
      (a.vibrance / 100) * (a.vibrance > 0 ? 1 - clamp(spread, 0, 1) : 1);
    r = mix(gray, r, saturation);
    g = mix(gray, g, saturation);
    b = mix(gray, b, saturation);
    const mono = luminance(r, g, b);
    r = mix(r, mono, a.grayscale / 100);
    g = mix(g, mono, a.grayscale / 100);
    b = mix(b, mono, a.grayscale / 100);
    const sr = r * 0.393 + g * 0.769 + b * 0.189,
      sg = r * 0.349 + g * 0.686 + b * 0.168,
      sb = r * 0.272 + g * 0.534 + b * 0.131;
    r = mix(r, sr, a.sepia / 100);
    g = mix(g, sg, a.sepia / 100);
    b = mix(b, sb, a.sepia / 100);
    const fade = a.fade / 100;
    out[i] = r * (1 - fade * 0.35) + fade * 42;
    out[i + 1] = g * (1 - fade * 0.35) + fade * 42;
    out[i + 2] = b * (1 - fade * 0.35) + fade * 42;
    out[i + 3] = source[i + 3];
  }
  const details = a.sharpness || a.clarity || a.definition || a.glamour;
  let luma, fine, medium, broad;
  if (details) {
    luma = new Float32Array(width * height);
    for (let n = 0; n < luma.length; n++)
      luma[n] = luminance(out[n * 4], out[n * 4 + 1], out[n * 4 + 2]);
    if (a.sharpness)
      fine = blur(luma, width, height, Math.max(1, Math.round(width / 700)));
    if (a.clarity || a.glamour)
      medium = blur(luma, width, height, Math.max(2, Math.round(width / 120)));
    if (a.definition)
      broad = blur(luma, width, height, Math.max(3, Math.round(width / 35)));
  }
  for (let n = 0; n < width * height; n++) {
    const x = n % width,
      y = Math.floor(n / width),
      i = n * 4;
    let detail = 0;
    if (fine) detail += ((luma[n] - fine[n]) * a.sharpness) / 60;
    if (medium)
      detail += (luma[n] - medium[n]) * (a.clarity / 100 - a.glamour / 130);
    if (broad) detail += ((luma[n] - broad[n]) * a.definition) / 100;
    const distance =
      ((x + 0.5) / width - 0.5) ** 2 + ((y + 0.5) / height - 0.5) ** 2;
    const vignette =
      1 - (clamp((distance - 0.04) / 0.46, 0, 1) * a.vignette) / 120;
    const random =
      ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) /
        4294967295 -
      0.5;
    const grain = random * a.grain * 0.45;
    for (let c = 0; c < 3; c++)
      out[i + c] = (out[i + c] + detail) * vignette + grain;
  }
  return out;
}
export function stretchCoordinate(value, start, end, amount) {
  if (!amount || end - start > 0.98) return value;
  const length = end - start,
    target = clamp(length * (1 + amount / 100), 0.02, 0.98);
  const before = (start * (1 - target)) / (1 - length),
    after = before + target;
  if (value < before) return before ? (value * start) / before : 0;
  if (value <= after) return start + ((value - before) * length) / target;
  return end + ((value - after) * (1 - end)) / (1 - after);
}
export function warpPixels(source, width, height, a) {
  if (!a.strokes.length && !a.stretchAmount) return source;
  const out = new Uint8ClampedArray(source.length);
  const dx = new Float32Array(width * height),
    dy = new Float32Array(width * height);
  for (const stroke of a.strokes) {
    const cx = stroke.x * width,
      cy = stroke.y * height,
      radius = stroke.radius * Math.min(width, height);
    for (
      let y = Math.max(0, Math.floor(cy - radius));
      y <= Math.min(height - 1, Math.ceil(cy + radius));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - radius));
        x <= Math.min(width - 1, Math.ceil(cx + radius));
        x++
      ) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d >= 1) continue;
        const n = y * width + x,
          weight = (1 - d * d) ** 2 * stroke.strength;
        dx[n] += stroke.dx * width * weight;
        dy[n] += stroke.dy * height * weight;
      }
    }
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const n = y * width + x;
      let u = (x + 0.5) / width,
        v = (y + 0.5) / height;
      if (a.stretchAxis === "x")
        u = stretchCoordinate(u, a.stretchStart, a.stretchEnd, a.stretchAmount);
      else
        v = stretchCoordinate(v, a.stretchStart, a.stretchEnd, a.stretchAmount);
      const sx = clamp(u * width - 0.5 - dx[n], 0, width - 1),
        sy = clamp(v * height - 0.5 - dy[n], 0, height - 1);
      const x0 = Math.floor(sx),
        y0 = Math.floor(sy),
        x1 = Math.min(width - 1, x0 + 1),
        y1 = Math.min(height - 1, y0 + 1),
        fx = sx - x0,
        fy = sy - y0;
      for (let c = 0; c < 4; c++)
        out[n * 4 + c] = mix(
          mix(
            source[(y0 * width + x0) * 4 + c],
            source[(y0 * width + x1) * 4 + c],
            fx,
          ),
          mix(
            source[(y1 * width + x0) * 4 + c],
            source[(y1 * width + x1) * 4 + c],
            fx,
          ),
          fy,
        );
    }
  return out;
}
export function imageHistogram(data) {
  const bins = new Array(64).fill(0);
  let count = 0,
    shadows = 0,
    highlights = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const luma = luminance(data[i], data[i + 1], data[i + 2]);
    bins[Math.min(63, Math.floor(luma / 4))]++;
    count++;
    if (Math.min(data[i], data[i + 1], data[i + 2]) < 4) shadows++;
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 251) highlights++;
  }
  const peak = Math.max(1, ...bins);
  return {
    bins: bins.map((n) => n / peak),
    shadows: count ? (shadows * 100) / count : 0,
    highlights: count ? (highlights * 100) / count : 0,
  };
}
