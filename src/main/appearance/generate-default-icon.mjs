#!/usr/bin/env node
/**
 * 内置默认图标生成器（零依赖，纯 Node）。
 *
 * 产物：
 * - `resources/icon-{16,24,32,48,64,128,256,512}.png`：各尺寸 PNG（打包与桌面集成用）；
 * - `resources/icon.ico`：Windows 图标（PNG 条目，Vista+）；
 * - `resources/icon.icns`：macOS 图标（PNG 条目，10.7+）；
 * - `src/main/appearance/default-icon.ts`：窗口/Dock（256）与托盘（32）用的 base64 data URL。
 *
 * 设计：圆角方形 + 靛蓝到青色渐变底 + 白色终端提示符（> _），呼应「shell」产品形态。
 * 每个尺寸按 4 倍超采样渲染后盒式滤波降采样，保证 16px 托盘尺寸也可辨识。
 *
 * 用法：`node src/main/appearance/generate-default-icon.mjs`
 * 重新生成后需同步提交 resources/ 与 default-icon.ts（后者由本脚本写入，请勿手改）。
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const SUPERSAMPLE = 4;

const CORNER_RADIUS = 0.225;
const GRADIENT_TOP = [0x4f, 0x46, 0xe5]; // indigo-600
const GRADIENT_BOTTOM = [0x06, 0xb6, 0xd4]; // cyan-500
const GLYPH_COLOR = [0xff, 0xff, 0xff];

// 终端提示符：chevron「>」两笔 + 底部短横「_」。
const CHEVRON = [
  { x: 0.315, y: 0.345 },
  { x: 0.455, y: 0.5 },
  { x: 0.315, y: 0.655 },
];
const UNDERSCORE = { from: { x: 0.545, y: 0.655 }, to: { x: 0.735, y: 0.655 } };
const STROKE_HALF_WIDTH = 0.0575;

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOURCES_DIRECTORY = join(HERE, '..', '..', '..', 'resources');
const DEFAULT_ICON_MODULE = join(HERE, 'default-icon.ts');

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 圆角方形 SDF（单位坐标，内部为负）。 */
function roundedBoxDistance(x, y) {
  const half = 0.5 - CORNER_RADIUS;
  const dx = Math.abs(x - 0.5) - half;
  const dy = Math.abs(y - 0.5) - half;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - CORNER_RADIUS;
}

/** 点到线段距离。 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : clamp01(((px - ax) * vx + (py - ay) * vy) / lengthSquared);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** chevron 折线距离。 */
function chevronDistance(x, y) {
  return Math.min(
    distanceToSegment(x, y, CHEVRON[0].x, CHEVRON[0].y, CHEVRON[1].x, CHEVRON[1].y),
    distanceToSegment(x, y, CHEVRON[1].x, CHEVRON[1].y, CHEVRON[2].x, CHEVRON[2].y),
  );
}

/** 下划线胶囊距离。 */
function underscoreDistance(x, y) {
  return distanceToSegment(x, y, UNDERSCORE.from.x, UNDERSCORE.from.y, UNDERSCORE.to.x, UNDERSCORE.to.y);
}

/** 渲染一个尺寸的 RGBA 位图（4 倍超采样 + 盒式降采样）。 */
function renderIcon(size) {
  const supersampled = size * SUPERSAMPLE;
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        const unitY = (y * SUPERSAMPLE + sy + 0.5) / supersampled;
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const unitX = (x * SUPERSAMPLE + sx + 0.5) / supersampled;

          // 背景：约 1 像素抗锯齿（按超采样分辨率计算）。
          const shapeCoverage = clamp01(0.5 - roundedBoxDistance(unitX, unitY) * supersampled);
          if (shapeCoverage <= 0) continue;

          // 字形：chevron 与下划线取并集，白色不透明。
          const glyphDistance = Math.min(chevronDistance(unitX, unitY), underscoreDistance(unitX, unitY));
          const glyphCoverage = clamp01(0.5 - (glyphDistance - STROKE_HALF_WIDTH) * supersampled);

          const gradientT = clamp01(unitY);
          const baseRed = GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * gradientT;
          const baseGreen = GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * gradientT;
          const baseBlue = GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * gradientT;

          red += (baseRed + (GLYPH_COLOR[0] - baseRed) * glyphCoverage) * shapeCoverage;
          green += (baseGreen + (GLYPH_COLOR[1] - baseGreen) * glyphCoverage) * shapeCoverage;
          blue += (baseBlue + (GLYPH_COLOR[2] - baseBlue) * glyphCoverage) * shapeCoverage;
          alpha += shapeCoverage;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(red / samples);
      rgba[offset + 1] = Math.round(green / samples);
      rgba[offset + 2] = Math.round(blue / samples);
      rgba[offset + 3] = Math.round((alpha / samples) * 255);
    }
  }

  return rgba;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** 编码 8 位 RGBA PNG。 */
function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 编码多尺寸 ICO（PNG 条目，Windows Vista+）。 */
function encodeIco(entries) {
  const headerSize = 6 + 16 * entries.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  let offset = headerSize;
  entries.forEach((entry, index) => {
    const base = 6 + 16 * index;
    header[base] = entry.size >= 256 ? 0 : entry.size;
    header[base + 1] = entry.size >= 256 ? 0 : entry.size;
    header[base + 2] = 0; // palette
    header[base + 3] = 0; // reserved
    header.writeUInt16LE(1, base + 4); // planes
    header.writeUInt16LE(32, base + 6); // bit count
    header.writeUInt32LE(entry.png.length, base + 8);
    header.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, ...entries.map((entry) => entry.png)]);
}

/** 编码 ICNS（PNG 条目，macOS 10.7+）。 */
function encodeIcns(entries) {
  const total = 8 + entries.reduce((sum, entry) => sum + 8 + entry.data.length, 0);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);

  const chunks = entries.map((entry) => {
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.write(entry.type, 0, 'ascii');
    chunkHeader.writeUInt32BE(8 + entry.data.length, 4);
    return Buffer.concat([chunkHeader, entry.data]);
  });

  return Buffer.concat([header, ...chunks]);
}

function renderDefaultIconModule(pngBySize) {
  const dataUrl = (size) =>
    `data:image/png;base64,${pngBySize.get(size).toString('base64')}`;

  return `/**
 * 内置默认图标 data URL。
 *
 * 由 \`src/main/appearance/generate-default-icon.mjs\` 生成，请勿手改；
 * 重新生成：\`node src/main/appearance/generate-default-icon.mjs\`。
 *
 * 为什么用内嵌 data URL 而不是读取 resources/：打包产物只包含 dist/
 * （见 electron-builder 的 files 配置），resources/ 不随包分发；
 * 内嵌保证开发与打包环境下默认图标始终可用。用户自定义图标仍按
 * 规格 §5.4 复制到配置目录后由文件加载。
 *
 * - 256：窗口图标（Windows 任务栏、Linux 窗口图标）与 macOS Dock；
 * - 32：托盘图标基尺寸（按平台缩放到 16px）。
 */

/** 256×256 默认图标（窗口与 Dock 用）。 */
export const DEFAULT_ICON_DATA_URL_256 = '${dataUrl(256)}';

/** 32×32 默认图标（托盘基尺寸）。 */
export const DEFAULT_ICON_DATA_URL_32 = '${dataUrl(32)}';
`;
}

function main() {
  const pngBySize = new Map();
  for (const size of SIZES) {
    const rgba = renderIcon(size);
    pngBySize.set(size, encodePng(size, rgba));
    process.stdout.write(`rendered ${size}x${size}\n`);
  }

  mkdirSync(RESOURCES_DIRECTORY, { recursive: true });

  for (const size of SIZES) {
    const target = join(RESOURCES_DIRECTORY, `icon-${size}.png`);
    writeFileSync(target, pngBySize.get(size));
  }

  // ICO：16/24/32/48/256（256 用 0 表示宽度字节）。
  writeFileSync(
    join(RESOURCES_DIRECTORY, 'icon.ico'),
    encodeIco([16, 24, 32, 48, 256].map((size) => ({ size, png: pngBySize.get(size) }))),
  );

  // ICNS：ic12=32(16@2x)、ic11=64(32@2x)、ic07=128、ic13=256(128@2x)、ic09=512。
  writeFileSync(
    join(RESOURCES_DIRECTORY, 'icon.icns'),
    encodeIcns([
      { type: 'ic12', data: pngBySize.get(32) },
      { type: 'ic11', data: pngBySize.get(64) },
      { type: 'ic07', data: pngBySize.get(128) },
      { type: 'ic13', data: pngBySize.get(256) },
      { type: 'ic09', data: pngBySize.get(512) },
    ]),
  );

  writeFileSync(DEFAULT_ICON_MODULE, renderDefaultIconModule(pngBySize));
  process.stdout.write(`wrote ${DEFAULT_ICON_MODULE}\n`);
}

main();
