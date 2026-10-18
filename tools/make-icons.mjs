/**
 * 程序化生成全部图标（不依赖任何图形库，自带 PNG 编码器）：
 *   icons/icon-192.png / icon-512.png / icon-maskable-512.png / apple-touch-icon.png / favicon-32.png
 *   android/res/mipmap-*\/ic_launcher.png            传统图标
 *   android/res/mipmap-*\/ic_launcher_foreground.png Android 8+ 自适应图标前景层
 *
 *   node tools/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* ================= 极简 PNG 编码器 ================= */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       /* filter: none */
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    /* bit depth */
  ihdr[9] = 6;    /* RGBA */
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ================= 绘制 ================= */
const SS = 4;                       /* 4× 超采样抗锯齿 */
const clamp01 = v => v < 0 ? 0 : (v > 1 ? 1 : v);

/* 键位网格：3 行 × 5 列，全部对齐的矩形键（和 App 里的布局一致） */
function dots(scale, cy) {
  const sx = 0.168 * scale;     /* 列间距 */
  const sy = 0.205 * scale;     /* 行间距 */
  const hw = 0.052 * scale;     /* 键半宽 */
  const hh = 0.042 * scale;     /* 键半高 */
  const rc = 0.018 * scale;     /* 圆角 */
  const h = (cy === undefined ? 0.5 : cy);
  const out = [];
  for (let r = 0; r < 3; r++) {
    const y = h + (r - 1) * sy;
    for (let c = 0; c < 5; c++) {
      out.push([0.5 + (c - 2) * sx, y, hw, hh, rc]);
    }
  }
  return out;
}

/* 圆角矩形有向距离场（<0 在内部） */
function rrect(px, py, hw, hh, rc) {
  const dx = Math.abs(px) - hw + rc;
  const dy = Math.abs(py) - hh + rc;
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - rc;
}

function sample(u, v, o) {
  let r = 0, g = 0, b = 0, a = 0;

  /* --- 背景 --- */
  if (o.bg === 'rounded') {
    const c = o.corner;
    const dx = Math.abs(u - 0.5) - (0.5 - c);
    const dy = Math.abs(v - 0.5) - (0.5 - c);
    const sd = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - c;
    if (sd > 0) return [0, 0, 0, 0];
  }
  if (o.bg === 'rounded' || o.bg === 'full') {
    const dx = (u - 0.5) * 1.02, dy = (v - 0.30) * 1.22;
    const t = Math.min(1, Math.hypot(dx, dy) / 0.86);
    r = 0.106 + (0.016 - 0.106) * t;
    g = 0.184 + (0.035 - 0.184) * t;
    b = 0.400 + (0.086 - 0.400) * t;
    a = 1;
  }

  /* --- 琴键（实心圆角矩形 + 顶部受光 + 外发光） --- */
  let add = [0, 0, 0], cov = 0;
  const HALO = 0.052;
  const list = o.dots;
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    const dist = rrect(u - k[0], v - k[1], k[2], k[3], k[4]);
    if (dist > HALO) continue;
    if (dist <= 0) {
      /* 键面：自上而下略微变暗，像被打光照着 */
      const ty = clamp01((v - (k[1] - k[3])) / (2 * k[3]));
      const b = 0.97 - 0.5 * ty;
      add[0] = Math.max(add[0], b * 0.60);
      add[1] = Math.max(add[1], b * 0.79);
      add[2] = Math.max(add[2], b * 1.00);
      cov = 1;
    } else {
      /* 外发光：紧贴键缘的一圈柔光 */
      const h = Math.pow(1 - dist / HALO, 1.6) * 0.62;
      add[0] += h * 0.55;
      add[1] += h * 0.78;
      add[2] += h * 1.00;
      cov = Math.max(cov, clamp01(h * 1.7));
    }
  }

  /* --- 星点 --- */
  if (o.sparkle) {
    const sp = [[0.155, 0.195, 0.016], [0.855, 0.155, 0.012], [0.30, 0.845, 0.011], [0.80, 0.80, 0.009]];
    for (let i = 0; i < sp.length; i++) {
      const d = Math.hypot(u - sp[i][0], v - sp[i][1]) / sp[i][2];
      if (d > 1) continue;
      const k = Math.pow(1 - d, 1.6) * 0.9;
      add[0] += k * 1.0; add[1] += k * 0.93; add[2] += k * 0.70;
    }
  }

  if (o.bg === 'none') {
    /* 透明背景：alpha 由光点覆盖决定 */
    const cov2 = Math.max(cov, Math.min(1, Math.max(add[2], Math.max(add[0], add[1]))));
    if (cov2 <= 0.001) return [0, 0, 0, 0];
    return [clamp01(add[0] / cov2 * 1.0), clamp01(add[1] / cov2 * 1.02), clamp01(add[2] / cov2), cov2];
  }

  return [clamp01(r + add[0]), clamp01(g + add[1]), clamp01(b + add[2]), a];
}

function render(size, opt) {
  const o = Object.assign({
    bg: 'rounded', corner: 0.22, dotScale: 1, sparkle: true
  }, opt);
  o.dots = dots(o.dotScale, o.cy);

  const W = size * SS, N = SS * SS;
  const out = Buffer.alloc(size * size * 4);

  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (ox * SS + sx + 0.5) / W;
          const v = (oy * SS + sy + 0.5) / W;
          const c = sample(u, v, o);
          pr += c[0] * c[3]; pg += c[1] * c[3]; pb += c[2] * c[3]; pa += c[3];
        }
      }
      const i = (oy * size + ox) * 4;
      const a = pa / N;
      if (a <= 0.002) { out[i + 3] = 0; continue; }
      out[i]     = Math.round(clamp01(pr / N / a) * 255);
      out[i + 1] = Math.round(clamp01(pg / N / a) * 255);
      out[i + 2] = Math.round(clamp01(pb / N / a) * 255);
      out[i + 3] = Math.round(clamp01(a) * 255);
    }
  }
  return encodePNG(size, size, out);
}

/* ================= 输出 ================= */
function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log('  ' + path.relative(root, file) + '  ' + (buf.length / 1024).toFixed(1) + ' KB');
}

console.log('生成图标…');

/* Web / PWA */
write(path.join(root, 'icons', 'icon-192.png'),
  render(192, { bg: 'rounded', corner: 0.22 }));
write(path.join(root, 'icons', 'icon-512.png'),
  render(512, { bg: 'rounded', corner: 0.22 }));
write(path.join(root, 'icons', 'icon-maskable-512.png'),
  render(512, { bg: 'full', dotScale: 0.72, sparkle: false }));
write(path.join(root, 'icons', 'apple-touch-icon.png'),
  render(180, { bg: 'full', corner: 0, dotScale: 0.86, cy: 0.5 }));
write(path.join(root, 'icons', 'favicon-32.png'),
  render(32, { bg: 'rounded', corner: 0.22, sparkle: false }));

/* Android 传统图标 */
const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(legacy)) {
  write(path.join(root, 'android', 'res', 'mipmap-' + d, 'ic_launcher.png'),
    render(px, { bg: 'rounded', corner: 0.22 }));
}

/* Android 自适应图标前景层（108dp 画布，内容在中间 72dp 安全区内） */
const fg = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [d, px] of Object.entries(fg)) {
  write(path.join(root, 'android', 'res', 'mipmap-' + d, 'ic_launcher_foreground.png'),
    render(px, { bg: 'none', dotScale: 0.60, sparkle: false }));
}

console.log('完成。');
