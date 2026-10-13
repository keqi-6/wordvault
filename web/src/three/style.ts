// 三种风格的开关：?style=A|B|C（默认 A）。
// 目的：把"像不像星空"这类判断交给用户，用参数暴露三个方向，而不是交一个调好的数字。
export type StyleKey = 'A' | 'B' | 'C';

export interface StyleCfg {
  key: StyleKey;
  zh: string;
  /** 辉光通道：点半径倍数 / 亮度 / 兜底云再乘的系数 */
  glowScale: number;
  glowGain: number;
  glowCloudMul: number;
  /** 装饰星尘点数（纯纵深，不参与拾取） */
  dust: number;
  /** 背景渐变（中心 → 边缘） */
  bgInner: string;
  bgOuter: string;
  /** L0 标签预算 / 标签候选上限 */
  clusterBudget: number;
  clusterCandidates: number;
  /** 调色板：饱和度与色温偏移（度） */
  paletteS: number;
  warmShift: number;
}

const V = (new URLSearchParams(location.search).get('style') || 'A').toUpperCase();

const PRESETS: Record<StyleKey, StyleCfg> = {
  A: {
    key: 'A', zh: '银河感优先',
    // 单点 alpha 必须很低：加法混合下"每像素叠几十上百个点"，0.4 早就爆成白块，
    // 密度→亮度的关系会完全丢失（那就是"一团白棉花"的来源）。0.06 让它重新线性。
    glowScale: 16, glowGain: 0.06, glowCloudMul: 0.18,
    dust: 30000, bgInner: '#070a16', bgOuter: '#01010a',
    clusterBudget: 34, clusterCandidates: 42,
    paletteS: 0.55, warmShift: 0,
  },
  B: {
    key: 'B', zh: '干净星点优先',
    glowScale: 6, glowGain: 0.07, glowCloudMul: 0.08,
    dust: 12000, bgInner: '#05060f', bgOuter: '#010107',
    clusterBudget: 18, clusterCandidates: 24,
    paletteS: 0.36, warmShift: 0,
  },
  C: {
    key: 'C', zh: '星云气感优先',
    glowScale: 8, glowGain: 0.12, glowCloudMul: 0.38,
    dust: 20000, bgInner: '#0a0812', bgOuter: '#03020a',
    clusterBudget: 28, clusterCandidates: 36,
    paletteS: 0.50, warmShift: 14,
  },
};

export const STYLE: StyleCfg = { ...PRESETS[(V as StyleKey) in PRESETS ? (V as StyleKey) : 'A'] };

/**
 * 亮度档位：?bright=low|mid|high（默认 mid）。
 * 注意：这三档是"在保留辉光与星尘纵深的前提下"整体提亮，不是靠压低某个亮度占比去调。
 */
export type BrightKey = 'low' | 'mid' | 'high';

interface BrightCfg {
  gain: number;
  aBgInner: string;
  bgOuter: string;
  dustLo: number;
  dustHi: number;
  /** 辉光通道的额外倍率（"星云亮起来"主要靠这一层） */
  glowMul: number;
}

const BRIGHT: Record<BrightKey, BrightCfg> = {
  low: { gain: 0.85, aBgInner: '#0d1428', bgOuter: '#0a0d1c', dustLo: 0.12, dustHi: 0.22, glowMul: 1.0 },
  mid: { gain: 0.98, aBgInner: '#121a33', bgOuter: '#0c1024', dustLo: 0.15, dustHi: 0.3, glowMul: 1.38 },
  high: { gain: 1.1, aBgInner: '#18203d', bgOuter: '#101634', dustLo: 0.2, dustHi: 0.38, glowMul: 1.8 },
};

// 用户选定 low 为默认
const BK = (new URLSearchParams(location.search).get('bright') || 'low').toLowerCase();
export const BRIGHTNESS: BrightCfg = BRIGHT[(BK as BrightKey) in BRIGHT ? (BK as BrightKey) : 'mid'];
STYLE.bgInner = BRIGHTNESS.aBgInner;
STYLE.bgOuter = BRIGHTNESS.bgOuter;

/**
 * 「海报星空」变体：?poster=P1|P2|P3
 *  P1 星芒优先 / P2 星云丝缕优先 / P3 银河带优先
 * 只在 poster 参数存在时生效，不影响默认观感。
 */
export interface PosterCfg {
  key: string;
  zh: string;
  /** 星芒：只给最亮的 top 0.5%，强度与点径倍率 */
  spike: number;
  spikeSize: number;
  /** 辉光丝缕：噪声扰动强度 + 洋红/青偏移量 */
  filament: number;
  hueShift: number;
  /** 银河带：斜向聚集的尘埃比例 */
  band: number;
  /** 星尘亮度倍率 */
  dustMul: number;
}

const POSTERS: Record<string, PosterCfg> = {
  P1: { key: 'P1', zh: '星芒优先', spike: 1.0, spikeSize: 6.5, filament: 0.25, hueShift: 0.15, band: 0, dustMul: 1.0 },
  P2: { key: 'P2', zh: '星云丝缕优先', spike: 0.6, spikeSize: 4.5, filament: 0.85, hueShift: 0.4, band: 0, dustMul: 1.15 },
  P3: { key: 'P3', zh: '银河带优先', spike: 0.75, spikeSize: 5.5, filament: 0.5, hueShift: 0.25, band: 0.55, dustMul: 1.3 },
};

/**
 * 星点"屏幕尺寸下限 + 确定性抽稀"：
 * - 远看时星点会缩到 1px 级，一堆 1px 点糊在一起就是"密集恐惧"的来源，所以设屏幕尺寸下限；
 * - 抽稀只在真的过密时触发（目标可见点数），且**按星点 id 的哈希确定性取舍**，同一视角可复现，
 *   不会每帧闪；被抽掉的星**仍然参与辉光层**（几何共享，只是核心不画）。
 * - `?thin=0` 可关闭，用于同机位前后对比。
 */
export interface ThinCfg {
  enabled: boolean;
  /** L0 目标"独立星点"数量上限 */
  target: number;
  /** 家族星（内容）与兜底星云（背景）各自的保留比例上限 */
  keepFamily: number;
  keepCloud: number;
}

const thinArg = new URLSearchParams(location.search).get('thin');
export const THIN: ThinCfg = {
  enabled: thinArg !== '0',
  target: 9000,
  keepFamily: 0.55,
  keepCloud: 0.28,
};

/**
 * L0 全景的四种展示策略：?l0=A|B|C|D（默认 A = 现状）
 * 只影响 L0；L1/L2/词层一律不受影响。共同点：
 *  - 所有词仍在库里、仍在坐标上，只是"是否作为独立星点渲染"不同（未渲染的仍参与辉光层）；
 *  - 取舍一律用 id 哈希 / 位置条纹 / 距离淡出，**同一视角可复现**，不随帧变化。
 */
export type L0Mode = 'A' | 'B' | 'C' | 'D';

export interface L0Cfg {
  mode: L0Mode;
  /** 保留星点的尺寸倍率（B 的核心要更大） */
  sizeMul: number;
  /** A 用：目标独立星点数与家族/星云上限 */
  target: number;
  keepFamily: number;
  keepCloud: number;
  /** C 用：条纹密度（越大条越密） */
  streak: number;
}

const l0arg = (new URLSearchParams(location.search).get('l0') || 'A').toUpperCase();
const L0_MODES: Record<L0Mode, L0Cfg> = {
  A: { mode: 'A', sizeMul: 1.0, target: 9000, keepFamily: 0.55, keepCloud: 0.28, streak: 0 },
  B: { mode: 'B', sizeMul: 1.9, target: 0, keepFamily: 0, keepCloud: 0, streak: 0 },
  C: { mode: 'C', sizeMul: 1.25, target: 0, keepFamily: 0, keepCloud: 0, streak: 26 },
  D: { mode: 'D', sizeMul: 1.35, target: 0, keepFamily: 0, keepCloud: 0, streak: 0 },
};
export const L0: L0Cfg = L0_MODES[(l0arg as L0Mode) in L0_MODES ? (l0arg as L0Mode) : 'A'];

const PK = (new URLSearchParams(location.search).get('poster') || '').toUpperCase();
export const POSTER: PosterCfg | null = POSTERS[PK] || null;

// 保守版：?sat=low —— 只把气体饱和度压到 0.40-0.45（白核保持一致），用于和你担心的"糖果色"对照
const SAT = new URLSearchParams(location.search).get('sat');
if (SAT === 'low') STYLE.paletteS = 0.42;
else if (SAT === 'high') STYLE.paletteS = 0.55;
