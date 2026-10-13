// 星空几何与视觉编码（清晰版）
// 关键改动：不再使用任何径向渐变贴图；星点在片元里画硬边圆，尺寸用像素控制；
// 连线改成屏幕空间加宽的四边形（LineBasicMaterial 的 linewidth 在 WebGL 里无效）。
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { STYLE } from './style';
import type { Star } from '../types';

export interface SceneSky {
  center: THREE.Vector3;
  radius: number;
  positions: Float32Array;
  posById: Map<number, THREE.Vector3>;
}

/** 把原始坐标归一化到半径≈1 的球内：渲染与相机参数就与数据尺度无关。 */
export function normalizeSky(stars: Star[]): SceneSky {
  const center = new THREE.Vector3();
  const posById = new Map<number, THREE.Vector3>();
  if (!stars.length) return { center, radius: 1, positions: new Float32Array(0), posById };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const s of stars) {
    if (s.x < minX) minX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.z < minZ) minZ = s.z;
    if (s.x > maxX) maxX = s.x;
    if (s.y > maxY) maxY = s.y;
    if (s.z > maxZ) maxZ = s.z;
  }
  center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  let radius = 0;
  const tmp = new THREE.Vector3();
  for (const s of stars) radius = Math.max(radius, tmp.set(s.x, s.y, s.z).distanceTo(center));
  if (!(radius > 1e-6)) radius = 1;
  const positions = new Float32Array(stars.length * 3);
  stars.forEach((s, i) => {
    const v = new THREE.Vector3((s.x - center.x) / radius, (s.y - center.y) / radius, (s.z - center.z) / radius);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
    posById.set(s.id, v);
  });
  return { center, radius, positions, posById };
}

export function toScene(sky: SceneSky, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set((x - sky.center.x) / sky.radius, (y - sky.center.y) / sky.radius, (z - sky.center.z) / sky.radius);
}

/**
 * 本文件的星点着色器不做 sRGB 输出编码，写进帧缓冲的就是原值。
 * 因此调色板用 rawHex 按「直写」方式存储，保证屏幕上看到的颜色 = 这里写的颜色，亮度可控。
 * 10 个大区色相都挑过明度（sRGB 相对亮度 ≥ 0.63），和 #05060c 背景对比充足：
 *   cyan 0.77 / violet 0.64 / pink 0.68 / coral 0.63 / amber 0.81
 *   green 0.85 / spring 0.80 / teal 0.77 / indigo 0.70 / rose 0.72
 */
function rawColor(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

export function rawHex(hex: string): THREE.Color {
  const h = hex.replace('#', '');
  return rawColor(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  );
}

function hslRaw(h: number, s: number, l: number): THREE.Color {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m0 = l - c / 2;
  return rawColor(r + m0, g + m0, b + m0);
}

/**
 * 星温色系：色相沿「冷白蓝(205°) → 柔品红 → 暖金(25°)」排布，饱和度压到 0.3-0.5，
 * 相邻簇靠**明度交替**区分 —— 不再是一圈等明度的糖果色。
 */
export function majorColors(majors: Array<{ key: string }>): Map<string, THREE.Color> {
  const m = new Map<string, THREE.Color>();
  const n = majors.length;
  const spread = n <= 16;
  majors.forEach((mj, i) => {
    // 色相沿色相环均匀铺开：≤16 个团时覆盖 330°（相邻团至少差 20-33°）；
    // 团多时用黄金角 137.508°，保证相邻编号也不会撞色。
    const hue = spread
      ? 195 + (330 * i) / Math.max(1, n) + STYLE.warmShift
      : i * 137.508 + STYLE.warmShift;
    const sat = STYLE.paletteS;
    const lig = (i % 2 === 0 ? 0.80 : 0.68) + 0.05 * (n > 1 ? i / (n - 1) : 0);
    m.set(mj.key, hslRaw(((hue % 360) + 360) % 360, sat, Math.min(0.92, lig)));
  });
  return m;
}

/**
 * 按**空间相邻**分配星团色相（贪心图着色）：
 * 先把团心投到单位球上，按词数从大到小依次定色；每个团只关心"已经定色的最近 3 个邻居"，
 * 在 0..350° 里挑一个让"与邻居的色差不足 40° 的惩罚"最小的色相 —— 挨得近的团颜色最远，
 * 隔得远的可以复用相近色。
 */
export function spatialMajorColors(
  items: Array<{ key: string; count?: number; center?: [number, number, number] }>,
): Map<string, THREE.Color> {
  const m = new Map<string, THREE.Color>();
  const n = items.length;
  const ligFor = (rank: number, idx: number) =>
    Math.min(0.92, (idx % 2 === 0 ? 0.80 : 0.68) + 0.05 * (n > 1 ? rank / (n - 1) : 0));
  const usable = items.filter((it) => Array.isArray(it.center));
  if (n > 0 && usable.length === n) {
    const dirs = items.map((it) => {
      const c = it.center as [number, number, number];
      const l = Math.hypot(c[0], c[1], c[2]) || 1;
      return [c[0] / l, c[1] / l, c[2] / l] as [number, number, number];
    });
    const order = items.map((_, i) => i).sort((a, b) => (items[b].count || 0) - (items[a].count || 0));
    const hue: number[] = new Array(n).fill(-1);
    const circ = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    const assigned: number[] = [];
    order.forEach((idx, rank) => {
      const near = assigned
        .map((a) => ({ a, dot: dirs[idx][0] * dirs[a][0] + dirs[idx][1] * dirs[a][1] + dirs[idx][2] * dirs[a][2] }))
        .sort((x, y) => y.dot - x.dot)
        .slice(0, 3);
      let bestH = 0;
      let bestScore = -Infinity;
      for (let h = 0; h < 360; h += 10) {
        let penalty = 0;
        let minGap = 360;
        for (const nb of near) {
          const w = Math.max(0.15, (nb.dot + 1) / 2); // 越近权重越大
          const d = circ(h, hue[nb.a]);
          if (d < minGap) minGap = d;
          if (d < 40) penalty += w * (40 - d);
        }
        // 先满足"与最近邻 ≥40°"，再看整体最疏
        const score = -penalty * 1000 + minGap;
        if (score > bestScore) {
          bestScore = score;
          bestH = h;
        }
      }
      hue[idx] = bestH + STYLE.warmShift;
      assigned.push(idx);
      m.set(items[idx].key, hslRaw(((bestH + STYLE.warmShift) % 360 + 360) % 360, STYLE.paletteS, ligFor(rank, idx)));
    });
    return m;
  }
  // 退化：没有团心信息时按索引均匀铺开
  items.forEach((it, i) => {
    const hue = n <= 16 ? 195 + (330 * i) / Math.max(1, n) + STYLE.warmShift : i * 137.508 + STYLE.warmShift;
    m.set(it.key, hslRaw(((hue % 360) + 360) % 360, STYLE.paletteS, ligFor(i, i)));
  });
  return m;
}

export function colorForMajor(key: string, table: Map<string, THREE.Color>): THREE.Color {
  const c = table.get(key);
  if (c) return c;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = ((h ^ key.charCodeAt(i)) * 16777619) >>> 0;
  const col = hslRaw((h % 360), STYLE.paletteS, 0.72);
  table.set(key, col);
  return col;
}

// strength=0 时偏向「高亮冷玫瑰/紫」而不是深红：暗星要「弱」，不是「看不见」
const COLD = rawColor(0.86, 0.66, 0.88);
const HOT = rawColor(0.95, 0.98, 1.0);
// 任何情况下都不低于这个中性暗星色，保证明显亮于 #05060c 背景
const FLOOR = rawColor(0.34, 0.3, 0.38);

export type DisplayMode = 'bright' | 'strength';

export function tintStar(
  star: Star,
  base: THREE.Color,
  out: THREE.Color,
  mode: DisplayMode = 'bright',
  gain = 1,
): void {
  const s = Math.min(1, Math.max(0, Number(star.strength) || 0));
  out.copy(base);
  if (mode === 'strength') {
    out.lerp(COLD, (1 - Math.sqrt(s)) * 0.35);
    out.lerp(HOT, Math.pow(s, 1.4) * 0.55);
  }
  // 「全亮」是默认：所有星同一起跑线，strength 完全不参与（背没背过都亮着）
  // 「记忆强度」才按强度变化，但下限 0.62，任何词都不会暗到看不见
  // 记忆强度模式：0.45（没背过，仍清楚可见）→ 1.15（滚瓜烂熟），和"全亮"有明显对比
  // gain 是层级增益：L0 全景把单颗星压到 ~0.5，星团的光靠"密度"而不是"每颗都开到最亮"
  // 重尾亮度映射：中位数 ~0.35，最高频 / 首期点亮到 1.0-1.2 —— 少数炽亮的星撑起深空
  const f = Number(star.frq) || 0;
  const tf = f > 0 ? Math.log10(f + 1) / Math.log10(44409) : 0.08;
  // 重尾指数 3.0：更多星点暗下去、少数更亮 → 反差/纵深更强
  const bright = 0.26 + 0.92 * Math.pow(tf, 3.0);
  let lum = (mode === 'strength' ? 0.4 + 0.8 * s : Math.max(bright, star.lit ? 1.05 : 0)) * gain;
  if (star.satellite) lum *= 0.8;
  if (mode === 'strength' && star.lit) lum *= 1.12; // 全亮模式下亮暗一致，lit 改由小环标识
  out.multiplyScalar(lum);
  // 下限也要随亮度缩放：否则"全亮"和"记忆强度"都会被同一个 FLOOR 抬到一样亮，
  // 看起来像"切了没反应"。缩放下限后仍然保证任何词都明显亮于背景。
  const fl = Math.min(1, lum * 1.8);
  out.r = Math.max(out.r, FLOOR.r * fl);
  out.g = Math.max(out.g, FLOOR.g * fl);
  out.b = Math.max(out.b, FLOOR.b * fl);
}

/** 不透明度基准：全亮模式下所有星一模一样；记忆强度模式也只做很小起伏，且下限很高 */
export function starTone(star: Star, mode: DisplayMode = 'bright'): number {
  if (mode !== 'strength') return 0.94;
  const s = Math.min(1, Math.max(0, Number(star.strength) || 0));
  return 0.78 + 0.22 * Math.sqrt(s);
}

/**
 * 基础尺寸系数：词频跨约 4 个数量级，映射到 [0.4, 3.2]（约 8 倍可见差异）。
 * frq=0 的（无词频数据）单独归到 0.6 这一档，不再和常用词混在一起取中等大小。
 */
export function starPointSize(star: Star): number {
  const f = Number(star.frq) || 0;
  let base = f > 0 ? 3.2 - 2.8 * (Math.log10(f + 1) / Math.log10(44409)) : 0.6;
  base = Math.min(3.2, Math.max(0.4, base));
  if (star.satellite) base *= 0.74;
  if (star.lit) base *= 1.22;
  // 重尾：只有最高频的那一小撮词额外放大点径（少数炽亮的星才撑得起深空）
  const t = f > 0 ? Math.log10(f + 1) / Math.log10(44409) : 0.08;
  base *= 1 + 0.6 * Math.max(0, (t - 0.62) / 0.38);
  return base;
}

export interface StarBuffers {
  geometry: THREE.BufferGeometry;
  color: Float32Array;
  size: Float32Array;
  tone: Float32Array;
  vis: Float32Array;
  lit: Float32Array;
  cloud: Float32Array;
  /** 1 = 该星团的"白热核"（每团最亮的 5%），用来做白核 + 彩色气体的分层 */
  core: Float32Array;
  /** 辉光提亮系数：联系星 3.5、本级星 1.6、其余 1 */
  boost: Float32Array;
  /** 1 = 带星芒的"最亮星"（每团 top 0.5%） */
  spike: Float32Array;
}

export function makeStarBuffers(sky: SceneSky, stars: Star[], mode: DisplayMode = 'bright'): StarBuffers {
  const n = stars.length;
  const color = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const tone = new Float32Array(n);
  const vis = new Float32Array(n);
  const lit = new Float32Array(n);
  const cloudArr = new Float32Array(n);
  const coreArr = new Float32Array(n);
  const boostArr = new Float32Array(n).fill(1);
  const spikeArr = new Float32Array(n);
  {
    // 每团最亮的 top 0.5% → 星芒（海报星空最有辨识度的标志，但绝不能满屏都是）
    const byGroup = new Map<string, number[]>();
    stars.forEach((s, i) => {
      const f = Number(s.frq) || 0;
      const t = f > 0 ? Math.log10(f + 1) / Math.log10(44409) : 0.05;
      const key = s.group || s.major || '';
      const arr = byGroup.get(key);
      if (arr) arr.push(t);
      else byGroup.set(key, [t]);
      spikeArr[i] = t;
    });
    const thr = new Map<string, number>();
    for (const [k, arr] of byGroup) {
      const sorted = arr.slice().sort((a, b) => a - b);
      // top 1%（海报里星芒是"一眼看见"的元素，0.5% 太少；1% × 10 团 ≈ 266 颗，不会满屏）
      thr.set(k, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]);
    }
    stars.forEach((s, i) => {
      const isSpike = spikeArr[i] >= (thr.get(s.group || s.major || '') ?? 2);
      spikeArr[i] = isSpike ? 1 : 0;
    });
  }
  // 每个星团各自取"最亮的 5%"作为白热核（用词频重尾 t 做密度分层代理）
  {
    const byGroup = new Map<string, number[]>();
    stars.forEach((s, i) => {
      const f = Number(s.frq) || 0;
      const t = f > 0 ? Math.log10(f + 1) / Math.log10(44409) : 0.05;
      const key = s.group || s.major || '';
      const arr = byGroup.get(key);
      if (arr) arr.push(t);
      else byGroup.set(key, [t]);
      coreArr[i] = t; // 先存 t，后面按分组阈值改成 0/1
    });
    const thr = new Map<string, number>();
    for (const [k, arr] of byGroup) {
      const sorted = arr.slice().sort((a, b) => a - b);
      thr.set(k, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]);
    }
    stars.forEach((s, i) => {
      const t = coreArr[i];
      coreArr[i] = t >= (thr.get(s.group || s.major || '') ?? 2) ? 1 : 0;
    });
  }
  stars.forEach((s, i) => {
    // 兜底星云（无词根/无前缀/未归类…）整体小一档，只当背景
    const cloud = !!s.groupKind && s.groupKind !== 'family';
    size[i] = starPointSize(s) * (cloud ? 0.82 : 1);
    tone[i] = starTone(s, mode);
    lit[i] = s.lit ? 1 : 0;
    cloudArr[i] = cloud ? 1 : 0;
    vis[i] = 1;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(sky.positions.slice(), 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aTone', new THREE.BufferAttribute(tone, 1));
  geometry.setAttribute('aVis', new THREE.BufferAttribute(vis, 1));
  geometry.setAttribute('aLit', new THREE.BufferAttribute(lit, 1));
  geometry.setAttribute('aCloud', new THREE.BufferAttribute(cloudArr, 1));
  geometry.setAttribute('aCore', new THREE.BufferAttribute(coreArr, 1));
  geometry.setAttribute('aBoost', new THREE.BufferAttribute(boostArr, 1));
  geometry.setAttribute('aSpike', new THREE.BufferAttribute(spikeArr, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2);
  return { geometry, color, size, tone, vis, lit, cloud: cloudArr, core: coreArr, boost: boostArr, spike: spikeArr };
}

// ---------------------------------------------------------------- 标签（3 倍超采样，显示时缩放）
export interface LabelTex {
  texture: THREE.Texture;
  w: number;
  h: number;
}

/** 标签贴图构建次数（诊断用）：悬停路径**不允许**让它增长 */
export let LABEL_TEX_BUILDS = 0;

const LABEL_SCALE = 3;

/**
 * 标签贴图。
 * plain=true 是默认形态：**裸文字 + 暗描边/外发光**，没有黑底胶囊，不会把星点压住；
 * plain=false 只在"悬停/选中"时用，给一块半透明底板 + 描边，做强调。
 */
export function makeLabelTexture(
  text: string,
  sub: string,
  opts: { size: number; weight: number; color: string; subColor: string; border: string; bg?: string; plain?: boolean },
): LabelTex {
  const cv = document.createElement('canvas');
  let ctx = cv.getContext('2d');
  if (!ctx) return { texture: new THREE.Texture(), w: 1, h: 1 };
  const font = opts.weight + ' ' + opts.size * LABEL_SCALE + 'px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
  const subFont = '500 ' + opts.size * LABEL_SCALE * 0.78 + 'px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
  ctx.font = font;
  const w1 = ctx.measureText(text).width;
  ctx.font = subFont;
  const w2 = sub ? ctx.measureText(sub).width : 0;
  const plain = !!opts.plain;
  const gap = sub ? opts.size * LABEL_SCALE * 0.5 : 0;
  const padX = opts.size * LABEL_SCALE * (plain ? 0.34 : 0.62);
  const padY = opts.size * LABEL_SCALE * (plain ? 0.22 : 0.34);
  const w = Math.ceil(w1 + w2 + gap + padX * 2);
  const h = Math.ceil(opts.size * LABEL_SCALE * 1.3 + padY * 2);
  cv.width = w;
  cv.height = h;
  ctx = cv.getContext('2d');
  if (!ctx) return { texture: new THREE.Texture(), w: 1, h: 1 };
  if (!plain) {
    const r = h / 2;
    ctx.beginPath();
    ctx.moveTo(r, 1);
    ctx.lineTo(w - r, 1);
    ctx.arc(w - r, r, r - 1, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(r, h - 1);
    ctx.arc(r, r, r - 1, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = opts.bg || 'rgba(6,9,18,0.84)';
    ctx.fill();
    ctx.lineWidth = 1.5 * LABEL_SCALE * 0.5;
    ctx.strokeStyle = opts.border;
    ctx.stroke();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  // 裸文字也要在任何星点上读得清：先用深色描边勾一圈，再填字
  const outline = Math.max(2, opts.size * LABEL_SCALE * 0.16);
  ctx.lineJoin = 'round';
  ctx.lineWidth = outline;
  ctx.font = font;
  ctx.strokeStyle = 'rgba(2,4,10,0.92)';
  ctx.strokeText(text, padX, h / 2 + 1);
  ctx.fillStyle = opts.color;
  ctx.fillText(text, padX, h / 2 + 1);
  if (sub) {
    ctx.font = subFont;
    ctx.lineWidth = outline * 0.8;
    ctx.strokeStyle = 'rgba(2,4,10,0.9)';
    ctx.strokeText(sub, padX + w1 + gap, h / 2 + 2);
    ctx.fillStyle = opts.subColor;
    ctx.fillText(sub, padX + w1 + gap, h / 2 + 2);
  }
  LABEL_TEX_BUILDS += 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { texture: tex, w: w / LABEL_SCALE, h: h / LABEL_SCALE };
}

/** sizeAttenuation=false 的 Sprite：屏幕像素尺寸恒定 */
export function scaleForPixels(px: number, viewportHCss: number, fovDeg: number): number {
  const t = Math.tan((fovDeg * Math.PI) / 180 / 2);
  return (px * 2 * t) / viewportHCss;
}

// ---------------------------------------------------------------- 连线（屏幕空间加宽）
/**
 * 关系连线（选中态主角）：用 three 的 LineSegments2 + LineMaterial，能在 WebGL 里得到**真实像素宽度**
 * （原生 linewidth 恒为 1）。widthPx 是 CSS 像素，内部按 DPR 放大，保证不同缩放屏观感一致。
 */
export function makeThickLines(points: number[], colorHex: number, opacity: number, widthPx: number): LineSegments2 {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(new Float32Array(points));
  // 从中心向外渐隐：起点（选中词端）亮，终点（联系词端）淡到 30%
  const segs = Math.floor(points.length / 6);
  const cols = new Float32Array(segs * 6);
  for (let i = 0; i < segs; i++) {
    cols[i * 6] = 1; cols[i * 6 + 1] = 1; cols[i * 6 + 2] = 1;
    cols[i * 6 + 3] = 0.3; cols[i * 6 + 4] = 0.3; cols[i * 6 + 5] = 0.3;
  }
  if (segs > 0) geo.setColors(cols);
  const mat = new LineMaterial({
    color: colorHex,
    linewidth: widthPx,
    transparent: true,
    opacity,
    vertexColors: segs > 0,
    depthWrite: false,
    depthTest: false,
  });
  mat.resolution.set(1, 1);
  const seg = new LineSegments2(geo, mat);
  seg.frustumCulled = false;
  // resize/DPR 变化后要按这个值重新同步像素宽度
  seg.userData.widthPx = widthPx;
  return seg;
}

/** 把 LineMaterial 的 resolution / linewidth 同步到当前渲染尺寸与 DPR */
export function syncThickLine(seg: THREE.Object3D, widthCss: number, heightCss: number, dpr: number, baseWidthPx: number): void {
  const mat = (seg as unknown as { material?: LineMaterial }).material;
  if (!mat || !mat.isLineMaterial) return;
  mat.resolution.set(Math.max(1, Math.round(widthCss * dpr)), Math.max(1, Math.round(heightCss * dpr)));
  mat.linewidth = baseWidthPx * dpr;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export function pushEdge(out: number[], a: THREE.Vector3, b: THREE.Vector3, arc: boolean, bulge: number, seg: number): void {
  if (!arc) {
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    return;
  }
  const dir = tmpA.copy(b).sub(a);
  const len = dir.length() || 1e-6;
  const nrm = tmpB.copy(dir).normalize().cross(UP);
  if (nrm.lengthSq() < 1e-6) nrm.set(1, 0, 0);
  nrm.normalize().multiplyScalar(len * bulge);
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5).add(nrm);
  const q = new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  const pts = q.getPoints(seg);
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
  }
}

export function disposeGroup(g: THREE.Object3D): void {
  for (const child of g.children.slice()) {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
    g.remove(child);
  }
}

// ---------------------------------------------------------------- 簇晕（解析式，不用贴图）
// 用途：让「星团」在远景下有体积感。片元里按到簇心的距离算衰减，完全不依赖纹理。
const HALO_VS = `
  attribute vec3 aCenter;
  attribute vec2 aCorner;
  attribute float aRadius;
  attribute vec3 aColor;
  attribute float aOpacity;
  uniform vec3 uRight;
  uniform vec3 uUp;
  varying vec2 vCorner;
  varying vec3 vColor;
  varying float vOpacity;
  void main() {
    vCorner = aCorner;
    vColor = aColor;
    vOpacity = aOpacity;
    vec3 world = aCenter + (uRight * aCorner.x + uUp * aCorner.y) * aRadius;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const HALO_FS = `
  varying vec2 vCorner;
  varying vec3 vColor;
  varying float vOpacity;
  void main() {
    float d = length(vCorner);
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 2.6) * vOpacity;
    if (a <= 0.0035) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export interface HaloItem {
  center: THREE.Vector3;
  radius: number;
  color: THREE.Color;
  opacity: number;
}

export function makeHaloMesh(items: HaloItem[]): THREE.Mesh | null {
  if (!items.length) return null;
  const n = items.length;
  const pos = new Float32Array(n * 4 * 3);
  const ctr = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const radius = new Float32Array(n * 4);
  const color = new Float32Array(n * 4 * 3);
  const opacity = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  const C: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  items.forEach((it, i) => {
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      pos[v * 3] = it.center.x;
      pos[v * 3 + 1] = it.center.y;
      pos[v * 3 + 2] = it.center.z;
      ctr[v * 3] = it.center.x;
      ctr[v * 3 + 1] = it.center.y;
      ctr[v * 3 + 2] = it.center.z;
      corner[v * 2] = C[k][0];
      corner[v * 2 + 1] = C[k][1];
      radius[v] = it.radius;
      color[v * 3] = it.color.r;
      color[v * 3 + 1] = it.color.g;
      color[v * 3 + 2] = it.color.b;
      opacity[v] = it.opacity;
    }
    idx[i * 6] = i * 4;
    idx[i * 6 + 1] = i * 4 + 1;
    idx[i * 6 + 2] = i * 4 + 2;
    idx[i * 6 + 3] = i * 4;
    idx[i * 6 + 4] = i * 4 + 2;
    idx[i * 6 + 5] = i * 4 + 3;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCenter', new THREE.BufferAttribute(ctr, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geo.setAttribute('aOpacity', new THREE.BufferAttribute(opacity, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uRight: { value: new THREE.Vector3(1, 0, 0) },
      uUp: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: HALO_VS,
    fragmentShader: HALO_FS,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------- 辉光通道（第二遍渲染）
const GLOW_VS = `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aTone;
  attribute float aVis;
  attribute float aCloud;
  attribute float aBoost;
  uniform float uDPR;
  uniform float uPx;
  uniform float uRefDist;
  uniform float uGlowScale;
  varying vec3 vColor;
  varying float vFactor;
  void main() {
    vColor = aColor;
    // 兜底星云不给足量辉光，否则两万个点会糊成一大片
    float cloudMul = mix(1.0, STYLE_CLOUD_MUL, aCloud);
    vFactor = aTone * aVis * cloudMul * aBoost;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 0.02);
    float att = clamp(uRefDist / d, 0.7, 1.4);
    gl_PointSize = clamp(aSize * uPx * att, 0.5, 2.5) * uGlowScale * uDPR;
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FS = `
  uniform float uGlowGain;
  varying vec3 vColor;
  varying float vFactor;
  void main() {
    float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (r > 1.0) discard;
    // 严格跟着点密度走的柔光：指数尾巴
    float a = pow(1.0 - r, 2.4) * uGlowGain * vFactor;
    if (a <= 0.002) discard;
    // 外圈比星点更有颜色：饱和度 ×1.15
    vec3 c = mix(vec3(dot(vColor, vec3(0.299, 0.587, 0.114))), vColor, 1.15);
    gl_FragColor = vec4(c, a);
  }
`;

/** 辉光层：与星核共享同一份 geometry，点径放大 6-10 倍、亮度 0.06-0.15、加法混合 */
export function makeGlowPoints(glowScale: number, glowGain: number, cloudMul: number): THREE.Points {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uDPR: { value: 1 },
      uPx: { value: 1 },
      uRefDist: { value: 2.9 },
      uGlowScale: { value: glowScale },
      uGlowGain: { value: glowGain },
      uCloudMul: { value: cloudMul },
    },
    vertexShader: GLOW_VS.replace('STYLE_CLOUD_MUL', cloudMul.toFixed(3)),
    fragmentShader: GLOW_FS,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(new THREE.BufferGeometry(), mat);
  pts.frustumCulled = false;
  pts.renderOrder = 1; // 先画辉光，再画星核
  return pts;
}

/** 装饰星尘：与单词无关的随机点，只做纵深，不参与拾取 */
export function makeDust(count: number, radiusInner: number, radiusOuter: number, lumLo = 0.15, lumHi = 0.3): THREE.Points {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // 球壳内均匀分布
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = radiusInner + Math.random() * (radiusOuter - radiusInner);
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    pos[i * 3] = r * s * Math.cos(th);
    pos[i * 3 + 1] = r * s * Math.sin(th);
    pos[i * 3 + 2] = r * u;
    const l = lumLo + Math.random() * (lumHi - lumLo);
    const warm = Math.random();
    col[i * 3] = l * (warm > 0.6 ? 1.0 : 0.85);
    col[i * 3 + 1] = l * 0.92;
    col[i * 3 + 2] = l * (warm > 0.6 ? 0.82 : 1.0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), radiusOuter + 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uDPR: { value: 1 } },
    vertexShader: `
      attribute vec3 aColor;
      uniform float uDPR;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        gl_PointSize = 1.7 * uDPR;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
        if (r > 1.0) discard;
        gl_FragColor = vec4(vColor, pow(1.0 - r, 1.6));
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 0;
  return pts;
}

/** 每帧把相机的右/上方向喂给簇晕，保证始终朝向相机 */
export function updateHaloBillboard(mesh: THREE.Mesh, camera: THREE.Camera): void {
  const m = camera.matrixWorld.elements;
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.uRight.value as THREE.Vector3).set(m[0], m[1], m[2]).normalize();
  (mat.uniforms.uUp.value as THREE.Vector3).set(m[4], m[5], m[6]).normalize();
}

// ---------------------------------------------------------------- 悬停/选中高亮环（解析式，无贴图）
// 一个 Points 里放 2 个点（[0]=悬停、[1]=选中），片元里画「实心核 + 细环」。
const HL_VS = `
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aCore;
  attribute float aRing;
  uniform float uDPR;
  varying vec3 vColor;
  varying float vCore;
  varying float vRing;
  void main() {
    vColor = aColor;
    vCore = aCore;
    vRing = aRing;
    gl_PointSize = aSize * uDPR;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HL_FS = `
  uniform float uFeather;
  varying vec3 vColor;
  varying float vCore;
  varying float vRing;
  void main() {
    vec2 pc = gl_PointCoord - vec2(0.5);
    float d = length(pc) * 2.0;
    if (d > 1.0) discard;
    float core = (1.0 - smoothstep(0.30, 0.44, d)) * vCore;
    float ring = (1.0 - smoothstep(0.05, 0.05 + uFeather, abs(d - 0.86))) * vRing;
    float a = max(core, ring);
    if (a <= 0.004) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

export interface HighlightSpec {
  pos: THREE.Vector3;
  sizePx: number;
  color: THREE.Color;
  core: number;
  ring: number;
}

export const HIGHLIGHT_SLOTS = 64;

export function makeHighlightPoints(): THREE.Points {
  const geo = new THREE.BufferGeometry();
  const n = HIGHLIGHT_SLOTS;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aCore', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('aRing', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uDPR: { value: 1 }, uFeather: { value: 0.16 } },
    vertexShader: HL_VS,
    fragmentShader: HL_FS,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.NormalBlending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return pts;
}

/** 写入第 i 个高亮点；spec 为 null 表示这个点不显示 */
export function setHighlightPoint(points: THREE.Points, i: number, spec: HighlightSpec | null): void {
  const geo = points.geometry;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const size = geo.getAttribute('aSize') as THREE.BufferAttribute;
  const color = geo.getAttribute('aColor') as THREE.BufferAttribute;
  const core = geo.getAttribute('aCore') as THREE.BufferAttribute;
  const ring = geo.getAttribute('aRing') as THREE.BufferAttribute;
  if (spec) {
    pos.setXYZ(i, spec.pos.x, spec.pos.y, spec.pos.z);
    size.setX(i, spec.sizePx);
    color.setXYZ(i, spec.color.r, spec.color.g, spec.color.b);
    core.setX(i, spec.core);
    ring.setX(i, spec.ring);
  } else {
    size.setX(i, 0);
    core.setX(i, 0);
    ring.setX(i, 0);
  }
  pos.needsUpdate = true;
  size.needsUpdate = true;
  color.needsUpdate = true;
  core.needsUpdate = true;
  ring.needsUpdate = true;
}