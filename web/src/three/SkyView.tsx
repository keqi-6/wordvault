// 星空主界面（分级 + 清晰版）
// level 0 全景（10 个大区标签）→ level 1 大区（2 个子类标签）→ level 2 子类（单词星 + 单词标签）
// → 点单词在右侧打开词条面板。星点是片元里的硬边圆，连线是屏幕空间加宽的四边形。
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitCam } from './controls';
import {
  colorForMajor, disposeGroup, HIGHLIGHT_SLOTS, LABEL_TEX_BUILDS, makeHaloMesh, makeHighlightPoints,
  makeDust, makeGlowPoints, makeLabelTexture, makeStarBuffers, makeThickLines, normalizeSky, pushEdge,
  spatialMajorColors,
  scaleForPixels, setHighlightPoint, starPointSize, starTone, syncThickLine, tintStar,
  updateHaloBillboard,
} from './starfield';
import type { HighlightSpec } from './starfield';
import type { SceneSky, StarBuffers } from './starfield';
import { runtimeRefs, useWV } from '../store';
import { BRIGHTNESS, POSTER, STYLE } from './style';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { Rel, RelLayer, Star } from '../types';

const CAM_KEY = 'wv.cam.pano.v3';
const FOV = 52;
// 单词标签：先按优先级挑候选，再每帧做屏幕空间避让，最多同时显示 MAX_VISIBLE_WORD_LABELS 个
const WORD_LABEL_CANDIDATES = 60;
const MAX_VISIBLE_WORD_LABELS = 14;
/** 选中词最多画多少条关系连线（更多的仍在右侧面板里列出） */
const MAX_FOCUS_EDGES = 24;
/** L0 最多给多少个命名家族建标签候选（按词数从大到小取；兜底星云不受限） */
// L0 标签候选/预算由 STYLE 决定（见 three/style.ts）
// 注：L0 已经不按"最多 N 个簇晕"铺开了 —— 那样 10 个加法混合的大柔光会叠成整屏的雾。
/** 联系词"飞向选中词"的动画时长（毫秒） */
const MOTION_MS = 720;
/** 主角（选中词+联系词）占画面高度的目标比例 */
// 主角取景：按"最远联系词"定距离（用最大距离，不用分位），HERO_FRAME 只作为下限提示
const HERO_FRAME = 0.45;
/** 选中词放在画面中心偏下：注视点上抬这么多倍"可见半高" */
const HERO_BIAS = 0.14;
/** 取景中心里"选中词本身"的权重（其余给"选中词+联系词"的质心） */
const HERO_CENTER_W = 0.65;

/** 联系词向选中词靠拢的比例，以及离选中词的硬上限（相对当前层级半径） */
const PULL_RATIO = 0.35;
const PULL_CAP = 0.5;

// 高亮环颜色：悬停=冷白细环，选中=品牌金常亮（两者都画在 hlPoints 里，索引 0/1）
const HL_HOVER = new THREE.Color(0.93, 0.97, 1.0);
const HL_SELECT = new THREE.Color(1.0, 0.82, 0.34);
// 联系词的高亮环按关系层着色，和连线同色
/** 白热核的目标色 */
const HL_WHITE = new THREE.Color(1, 1, 1);

/** 兜底星云的中性灰蓝（去饱和用） */
const HL_CLOUD = new THREE.Color(0.62, 0.66, 0.74);
/** 兜底星云的额外压暗系数 */
const CLOUD_DIM = 0.45;

const HL_REL: Record<RelLayer, THREE.Color> = {
  semantic: new THREE.Color(0.31, 0.89, 1.0),
  morphology: new THREE.Color(0.75, 0.58, 1.0),
  scenario: new THREE.Color(1.0, 0.71, 0.27),
};

// 每一级的星点基准像素与上下限（CSS 像素）；attRef 由相机距离实时给出
// 每一级的星点基准像素与上下限（CSS 像素）。注意 aSize 的系数范围是 [0.4,3.2]，
// 这里必须给出同样宽的 min/max，否则会被 clamp 压平、词频大小差别又看不出来。
const LEVEL_TUNE = [
  // 全景：单颗星暗（gain 0.5）、点小（上限 ~2.2px）、不透明度低（tone 0.5），
  // 这样 26,608 颗星叠在一起时星团仍靠"密度"显出结构，而不是糊成一片灰。
  // 辉光变淡之后，"星团有存在感"必须靠星点本身：点径与不透明度都提上去，
  // 但星核用的是普通 alpha 混合（不是加法），密集处只会趋近星色、不会累加成白块。
  { px: 1.45, minPx: 0.7, maxPx: 2.6, bright: 1.0, vis: 0.85, gain: 1.0, tone: 0.72 },
  { px: 1.6, minPx: 0.9, maxPx: 5.8, bright: 1.08, vis: 1, gain: 1, tone: 1 },
  { px: 1.8, minPx: 1.0, maxPx: 6.6, bright: 1, vis: 1, gain: 1, tone: 1 },
];

const STAR_VS = `
  uniform float uSpikeSize;
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aTone;
  attribute float aVis;
  attribute float aLit;
  attribute float aSpike;
  uniform float uSpike;
  uniform float uSpikePx;
  uniform float uDPR;
  uniform float uPx;
  uniform float uMinPx;
  uniform float uMaxPx;
  uniform float uRefDist;
  varying vec3 vColor;
  varying float vTone;
  varying float vVis;
  varying float vLit;
  varying float vSpike;
  void main() {
    vColor = aColor;
    vTone = aTone;
    vVis = aVis;
    vLit = aLit;
    vSpike = aSpike * uSpike;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 0.02);
    float att = clamp(uRefDist / d, 0.7, 1.4);
    // 普通星按层级夹取；带星芒的那 1% 直接给"绝对像素尺寸"——
    // 之前倍率乘完又被 uMaxPx(2.6px) 夹掉，所以星芒根本长不出来。
    float px = clamp(aSize * uPx * att, uMinPx, uMaxPx);
    px = mix(px, uSpikePx, vSpike);
    gl_PointSize = px * uDPR;
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FS = `
  uniform float uFeather;
  uniform float uBright;
  varying vec3 vColor;
  varying float vTone;
  varying float vVis;
  varying float vLit;
  varying float vSpike;
  void main() {
    vec2 pc = gl_PointCoord - vec2(0.5);
    float d2 = dot(pc, pc);
    if (d2 > 0.25) discard;
    float d = sqrt(d2);
    // 柔和径向衰减：亮核 + 指数尾巴（硬边圆点看起来像"像素"，这才是"星"）
    float core = smoothstep(0.34, 0.0, d);
    float halo = pow(smoothstep(1.0, 0.0, d), 2.4);
    float a = clamp(core + halo * 0.55, 0.0, 1.0);
    // 背过的词在中间挖个小孔 → 细环
    float ring = a * smoothstep(0.14, 0.32, d);
    a = mix(a, ring, vLit);
    // 星芒：十字 + 四斜角，只挂在最亮的 top 0.5% 上（不能满屏烟花）
    if (vSpike > 0.01) {
      vec2 q = abs(gl_PointCoord - vec2(0.5));
      // 细而长：宽度 0.085（≈2px@13px 点径）、长度几乎贯穿整个点
      float armH = smoothstep(0.085, 0.0, q.y) * smoothstep(0.52, 0.02, q.x);
      float armV = smoothstep(0.085, 0.0, q.x) * smoothstep(0.52, 0.02, q.y);
      float diag = smoothstep(0.07, 0.0, abs(q.x - q.y)) * smoothstep(0.5, 0.1, length(q));
      float diag2 = smoothstep(0.07, 0.0, abs(q.x + q.y - 0.5)) * smoothstep(0.5, 0.1, length(q));
      float spikes = max(max(armH, armV) * 0.98, max(diag, diag2) * 0.6);
      a = max(a, spikes * vSpike);
    }
    if (a <= 0.004) discard;
    gl_FragColor = vec4(min(vColor * uBright, vec3(1.0)), a * vTone * vVis);
  }
`;

interface EdgeStyle {
  color: number;
  opacity: number;
  arc: boolean;
  bulge: number;
  width: number;
  /** 连线不透明度（比线宽更容易压住"喧宾夺主"） */
}

// 选中态的关系连线是主角：高饱和、高亮、跑满不透明度（只有"全量边"背景模式才弱化）
// 关系连线是"提示"，不是主角：细、半透明、颜色降饱和，并且两端渐隐
function styleFor(layer: RelLayer, kind: string, faint: boolean, width = 1.3): EdgeStyle {
  const k = faint ? 0.4 : 0.5;
  if (layer === 'semantic') {
    if (kind === 'antonym') return { color: 0xe08a95, opacity: 0.62 * (faint ? 0.8 : 1), arc: false, bulge: 0, width };
    if (kind === 'near') return { color: 0x8fb8c8, opacity: 0.42 * (faint ? 0.8 : 1), arc: false, bulge: 0, width };
    return { color: 0x7cb9d4, opacity: k, arc: false, bulge: 0, width };
  }
  if (layer === 'morphology') return { color: 0x9b86c8, opacity: k, arc: true, bulge: faint ? 0.12 : 0.22, width };
  return { color: 0xc9a878, opacity: k, arc: false, bulge: 0, width };
}

interface LabelItem {
  key: string;
  kind: 'major' | 'minor' | 'word';
  sprite: THREE.Sprite;
  w: number;
  h: number;
  centerY: number;
  pos: THREE.Vector3;
  /** 越小越优先（lit 词 > frq 小）；每帧再叠加「离屏幕中心距离」 */
  basePriority: number;
  /** 选中 / 悬停的标签强制显示 */
  forced: boolean;
  /** 兜底星云的标签：永远显示，不参与避让竞争 */
  pinned: boolean;
  /** 选中词的联系词标签：不占单词标签预算（优先级高于普通词） */
  related: boolean;
  /** 当前贴图是否带底板（裸文字 / 高亮底板两套贴图缓存复用） */
  plated: boolean;
  text: string;
  sub: string;
  sizeCss: number;
  color: string;
  border: string;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  cam: OrbitCam;
  sky: SceneSky;
  stars: Star[];
  colorTable: Map<string, THREE.Color>;
  starPoints: THREE.Points;
  starBuf: StarBuffers | null;
  starMat: THREE.ShaderMaterial;
  /** 第二遍：辉光通道（共享星核 geometry） */
  glowPoints: THREE.Points;
  glowMat: THREE.ShaderMaterial;
  /** 装饰星尘（纯纵深，不参与拾取） */
  dustPoints: THREE.Points;
  labelGroup: THREE.Group;
  labels: LabelItem[];
  haloMesh: THREE.Mesh | null;
  /** L0 只给这个簇画晕（悬停/选中的那个；空串 = 都不画） */
  haloKey: string;
  /** 星点自身的 98 分位半径（场景单位，L0 取景用） */
  starP98: number;
  /** 渲染层当前实际装载的星相 key（诊断：和 store 的 layoutKey 对比就能判断数据有没有进渲染层） */
  layoutLoaded: string;
  /** 已经为哪个词做过"主角取景"（收敛保护） */
  heroFramedFor: string | null;
  /** 上次自动对齐取景的时间（节流用） */
  heroAlignAt: number;
  /** 用户最后一次"动过相机"的时间（拖拽/滚轮/双击重新居中）——动过之后就不再自动对齐 */
  heroAlignOffAt: number;
  /** 相机签名 + 连续不变的起始时刻（"停稳"的专用判据，与全景快照计时器无关） */
  camSig: string;
  camStableSince: number;
  /** 诊断：对齐执行次数 / 停稳次数 / 本次选中以来对齐次数 / 上次被哪条判据挡住 */
  heroAlignCount: number;
  settleCount: number;
  wasSettled: boolean;
  alignSinceSelect: number;
  alignBlock: string;
  /** 诊断：beginMotion 被调用的次数（补间被反复重启的话这个数会一直涨） */
  motionStarts: number;
  /** 本次聚焦是否已经启动过（键 = 选中词 + 联系词数）——防止 effect 重跑把补间反复重启 */
  focusStartedFor: string;
  /** 落在画面内的联系词端点数（硬指标：必须等于连线数） */
  focusOnScreen: number;
  /** 当前层级/选中词的"星团中心"投影后的屏幕 x（诊断：与"选中词 x"同类，但量团心） */
  clusterScreenX: number;
  clusterOffPct: number;
  /** 右侧面板宽度（可见画布 = 0..widthCss-panelW） */
  panelW: number;
  /** 可见区中心 x（投影按这里居中，而不是整窗中心） */
  viewCenterX: number;
  /** 选中词在屏幕上的横坐标 + 相对可见区中心的偏移（%）。这是"居中没有"的正确口径：
   *  光重心会被星云和连线带偏，选中词位置不会。 */
  selScreenX: number;
  selOffPct: number;
  focusGroup: THREE.Group;
  /** 星点 id → 顶点缓冲下标 / 该星相的原始坐标（动画回位用） */
  posIndex: Map<number, number>;
  basePos: Float32Array | null;
  /** 「联系词飞向选中词」动画 */
  motion: { id: number; idx: number; from: THREE.Vector3; to: THREE.Vector3 }[];
  motionTargets: Map<number, THREE.Vector3>;
  motionStart: number;
  motionActive: boolean;
  motionTick: number;
  tmpColor: THREE.Color;
  savedAt: number;
  lastCamKey: string;
  visibleCount: number;
  scopeCount: number;
  /** vis>=0.5 的星点数（"真正看得见"的口径，比"同屏"可信） */
  litVisible: number;
  /** 本级里实际被设成 vis>=0.5 的数量（和 scopeCount 不一致就说明 scope key 对不上） */
  scopeLit: number;
  hoverLemma: string | null;
  hoverStar: Star | null;
  hoverAt: number;
  pendingHover: { x: number; y: number } | null;
  hoverLastX: number;
  hoverLastY: number;
  /** 飞行期间暂停悬停拾取，落地后再补一次 */
  hoverResumeAt: number;
  /** 最近一次定位到的星（用于"确保目标星居中"的自校正） */
  selectedAt: number;
  reassertAt: number;
  reassertCount: number;
  lastFocusNonce: number;
  hlPoints: THREE.Points;
  labelsShown: number;
  labelsTotal: number;
  /** 上一帧画了几个联系词高亮（用来清掉多余的槽位） */
  hlPrev: number;
  /** 当前选中词画出的关系连线数 / 高亮的联系词数（HUD 展示，也方便验收） */
  focusEdges: number;
  focusRelated: number;
  /** 选中态连线的分桶（动画期间只更新顶点，不重建材质） */
  focusLines: { seg: LineSegments2; style: EdgeStyle; pairs: [number, number][] }[];
  byMinor: Record<string, Star[]>;
  byMajor: Record<string, Star[]>;
  byGroup: Record<string, Star[]>;
  majorCount: Record<string, number>;
  minorCount: Record<string, number>;
  majorCenter: Record<string, THREE.Vector3>;
  majorRadius: Record<string, number>;
  /** 各团的 p90 离心距离：取景用它而不是最大值 —— 最大值会被离群星点拉到整片天，
   *  导致相机停在远处、星点摊成 1px 的雾（用户录屏 f008 的"极淡圆盘"就是这个）。 */
  majorRadius90: Record<string, number>;
  minorRadius90: Record<string, number>;
  /** 各团**真实星点质心**（场景坐标）。声明中心对"铺满整片天"的大团会离星很远，
   *  相机照声明中心就会拍到一个空心的极淡圆盘（用户录屏 f008）。 */
  majorCentroid: Record<string, THREE.Vector3>;
  minorCentroid: Record<string, THREE.Vector3>;
  /** 本帧 applyCamera 实际用的取景半径（诊断） */
  frameRadius: number;
  minorCenter: Record<string, THREE.Vector3>;
  minorRadius: Record<string, number>;
  widthCss: number;
  heightCss: number;
}

// 投影用的共享向量，避免每帧/每次悬停都分配对象
const tmpProj = new THREE.Vector3();

function readPano(layout?: string): { theta: number; phi: number; radius: number; target: number[] } | null {
  try {
    const raw = localStorage.getItem(CAM_KEY + '.' + (layout || useWV.getState().layoutKey));
    if (!raw) return null;
    const j = JSON.parse(raw) as { theta: number; phi: number; radius: number; target: number[] };
    if (typeof j.theta !== 'number' || !Array.isArray(j.target) || j.target.length !== 3) return null;
    // 合理性校验：全景视角的相机半径大约 2.9，明显更近说明这条记忆是脏的（历史版本的飞行中间态）
    if (!(typeof j.radius === 'number') || j.radius < 1.2 || j.radius > 12) return null;
    return j;
  } catch {
    return null;
  }
}

export default function SkyView() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hudRef = useRef<HTMLDivElement | null>(null);
  const ctxRef = useRef<Ctx | null>(null);
  /** 标签贴图缓存（裸文字 / 带底板两套） */
  const labelTexRef = useRef(new Map<string, ReturnType<typeof makeLabelTexture>>());
  const [glError, setGlError] = useState('');

  const stars = useWV((s) => s.stars);
  const majors = useWV((s) => s.majors);
  const layoutKey = useWV((s) => s.layoutKey);
  const starsVersion = useWV((s) => s.starsVersion);
  const level = useWV((s) => s.level);
  const majorKey = useWV((s) => s.majorKey);
  const minorKey = useWV((s) => s.minorKey);
  const selected = useWV((s) => s.selected);
  const details = useWV((s) => s.details);
  const layers = useWV((s) => s.layers);
  const displayMode = useWV((s) => s.displayMode);
  const focus = useWV((s) => s.focus);

  // ---------------------------------------------------------------- 初始化
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;

    const scene = new THREE.Scene();
    // 背景交给 CSS 径向渐变（见下面 el.style.background）。这里必须留空，
    // 否则不透明清屏色会把渐变整个盖掉 —— 那正是"颜色被压暗 3 倍"的原因。
    scene.background = null;
    const camera = new THREE.PerspectiveCamera(FOV, w / h, 0.002, 500);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (e) {
      setGlError(e instanceof Error ? e.message : String(e));
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    // 背景交给 CSS 径向渐变（纯黑会让星空"贴纸感"很重），画布本身透明
    renderer.setClearColor(0x000000, 0);
    // 注意不要再往 #000 收——那一段渐晕会把"深靛蓝底色"吃掉，整幅又变回纯黑
    el.style.background =
      'radial-gradient(ellipse 145% 115% at 50% 45%, ' + STYLE.bgInner + ' 0%, ' +
      STYLE.bgInner + ' 45%, ' + STYLE.bgOuter + ' 100%)';
    el.appendChild(renderer.domElement);

    const cam = new OrbitCam(camera, renderer.domElement);
    cam.minRadius = 0.05;
    cam.maxRadius = 12;
    cam.attach();

    const starMat = new THREE.ShaderMaterial({
      uniforms: {
        uDPR: { value: dpr },
        uPx: { value: LEVEL_TUNE[0].px },
        uMinPx: { value: LEVEL_TUNE[0].minPx },
        uMaxPx: { value: LEVEL_TUNE[0].maxPx },
      uSpike: { value: POSTER ? POSTER.spike : 0 },
      uSpikeSize: { value: POSTER ? POSTER.spikeSize : 0 },
      uSpikePx: { value: 13 },
        uRefDist: { value: 2.9 },
        uFeather: { value: 0.25 },
        uBright: { value: LEVEL_TUNE[0].bright },
      },
      vertexShader: STAR_VS,
      fragmentShader: STAR_FS,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });

    const starPoints = new THREE.Points(new THREE.BufferGeometry(), starMat);
    starPoints.frustumCulled = false;
    starPoints.renderOrder = 2;
    scene.add(starPoints);
    // 第二遍辉光：共享星核 geometry，点径放大、亮度压低、加法混合 → 密度高的地方自然成银河
    const glowPoints = makeGlowPoints(STYLE.glowScale, STYLE.glowGain * BRIGHTNESS.glowMul, STYLE.glowCloudMul);
    scene.add(glowPoints);
    // 注：早期的 ?off=glow|stars|dust 分层测量开关已移除（它只是开发期用来
    // 把星点/辉光/背景三层贡献分开量的，注释里也写了「正常使用不要带」）。
    // 装饰星尘：更大的球壳上，只做纵深
    const dustPoints = makeDust(STYLE.dust, 1.7, 3.2, BRIGHTNESS.dustLo, BRIGHTNESS.dustHi);
    scene.add(dustPoints);

    const focusGroup = new THREE.Group();
    focusGroup.renderOrder = 3;
    scene.add(focusGroup);
    const labelGroup = new THREE.Group();
    labelGroup.renderOrder = 10;
    scene.add(labelGroup);
    const hlPoints = makeHighlightPoints();
    scene.add(hlPoints);

    const ctx: Ctx = {
      renderer, scene, camera, cam,
      sky: normalizeSky([]),
      stars: [],
      colorTable: new Map(),
      starPoints, starBuf: null, starMat, glowPoints, glowMat: glowPoints.material as THREE.ShaderMaterial, dustPoints,
      labelGroup, labels: [], haloMesh: null, haloKey: '', starP98: 1, layoutLoaded: '',
    heroFramedFor: null, heroAlignAt: 0, heroAlignOffAt: 0, camSig: '', camStableSince: 0,
    heroAlignCount: 0, settleCount: 0, wasSettled: false, alignSinceSelect: 0, alignBlock: 'init', motionStarts: 0,
    focusStartedFor: '',
    focusOnScreen: 0, clusterScreenX: -1, clusterOffPct: 0, panelW: 0, viewCenterX: w / 2,
    selScreenX: -1, selOffPct: 0, hlPoints,
      focusGroup,
      posIndex: new Map(),
      basePos: null,
      motion: [],
      motionTargets: new Map(),
      motionStart: 0,
      motionActive: false,
      motionTick: 0,
      tmpColor: new THREE.Color(),
      savedAt: 0,
      lastCamKey: '',
      visibleCount: 0, scopeCount: 0, litVisible: 0, scopeLit: 0, hoverLemma: null, hoverStar: null, hoverAt: 0,
      pendingHover: null, hoverLastX: -1e5, hoverLastY: -1e5, hoverResumeAt: 0,
      selectedAt: 0, reassertAt: 0, reassertCount: 0, lastFocusNonce: 0,
      labelsShown: 0, labelsTotal: 0, hlPrev: 0, focusEdges: 0, focusRelated: 0, focusLines: [],
      byMinor: {}, byMajor: {}, byGroup: {}, majorCount: {}, minorCount: {},
      majorCenter: {}, majorRadius: {}, majorRadius90: {}, majorCentroid: {}, minorCenter: {}, minorRadius: {}, minorRadius90: {}, minorCentroid: {}, frameRadius: 0,
      widthCss: w, heightCss: h,
    };
    ctxRef.current = ctx;
    // 首帧就按"可见区"（画布减去右侧面板）居中，别等到第一次 tick
    ctx.panelW = (() => {
      const pel = document.querySelector('.wordpanel');
      if (!pel) return 0;
      const rr = pel.getBoundingClientRect();
      return rr.width > 40 ? Math.max(0, window.innerWidth - rr.left) : 0;
    })();
    ctx.viewCenterX = (w - ctx.panelW) / 2;
    if (ctx.panelW > 0) {
      camera.aspect = (w + ctx.panelW) / h;
      camera.setViewOffset(w + ctx.panelW, h, ctx.panelW, 0, w, h);
      camera.updateProjectionMatrix();
    }

    const pano = readPano();
    if (pano) cam.setView(pano.theta, pano.phi, pano.radius, new THREE.Vector3(pano.target[0], pano.target[1], pano.target[2]));
    else cam.setView(0.75, 1.02, 2.95, new THREE.Vector3(0, 0, 0));

    cam.onTap = (x, y) => handleTap(x, y);
    // 悬停只记录位置，真正拾取放到渲染循环里做（每帧最多一次，避免每次 mousemove 全量拾取）
    cam.onHover = (x, y) => {
      const c = ctxRef.current;
      if (!c) return;
      c.pendingHover = x < -1e4 ? null : { x, y };
    };

    const ro = new ResizeObserver(() => {
      const c = ctxRef.current;
      if (!c) return;
      const nw = el.clientWidth || 1;
      const nh = el.clientHeight || 1;
      c.widthCss = nw;
      c.heightCss = nh;
      c.camera.aspect = nw / nh;
      c.camera.updateProjectionMatrix();
      const nd = Math.min(window.devicePixelRatio || 1, 2);
      c.renderer.setPixelRatio(nd);
      c.renderer.setSize(nw, nh);
      c.starMat.uniforms.uDPR.value = nd;
      c.glowMat.uniforms.uDPR.value = nd;
      layoutLabels();
      updateLineResolution();
      syncFocusLineWidth();
    });
    ro.observe(el);

    const clock = new THREE.Clock();
    let frames = 0;
    let fpsAt = performance.now();
    let fps = 0;
    let lastFrameAt = performance.now();

    /** 右侧词条面板的宽度（0 = 没显示面板，此时按整窗中心） */
    function panelWidth(): number {
      const pel = document.querySelector('.wordpanel');
      if (!pel) return 0;
      const r = pel.getBoundingClientRect();
      return r.width > 40 ? Math.max(0, window.innerWidth - r.left) : 0;
    }

    /**
     * 一帧的完整工作。既被 requestAnimationFrame（setAnimationLoop）调用，也被下面的
     * 看门狗兜底调用 —— 低帧率 / 后台标签页里 rAF 可能被节流甚至暂停，那时如果只有 rAF
     * 一条路径，就会出现"React 状态已切、画面永远停在旧星相"的部分更新。
     */
    const tick = (): void => {
      const c = ctxRef.current;
      if (!c) return;
      // 显示器 DPR 变化（拖到另一块屏）不会触发 ResizeObserver，这里兜底同步，避免画布变糊
      const wantDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (c.renderer.getPixelRatio() !== wantDpr) {
        c.widthCss = el.clientWidth || c.widthCss;
        c.heightCss = el.clientHeight || c.heightCss;
        c.renderer.setPixelRatio(wantDpr);
        c.renderer.setSize(c.widthCss, c.heightCss);
        c.starMat.uniforms.uDPR.value = wantDpr;
        c.glowMat.uniforms.uDPR.value = wantDpr;
        c.starMat.uniforms.uFeather.value = Math.min(
          0.32,
          Math.max(0.02, 1 / (c.starMat.uniforms.uPx.value * wantDpr)),
        );
        layoutLabels();
        updateLineResolution();
        syncFocusLineWidth();
      }
      const dt = clock.getDelta();
      c.cam.update(dt);
      // L0 的晕只跟随"当前簇"：变了才重建（最多 1 个 quad）
      lastFrameAt = performance.now();
      const st0 = useWV.getState();
      if (st0.level === 0) {
        const hs = c.hoverStar;
        const wantKey = hs ? hs.group || hs.major : st0.selected ? st0.starByLemma[st0.selected]?.group || '' : '';
        if (wantKey !== c.haloKey) {
          c.haloKey = wantKey;
          rebuildHalos();
        }
      }
      if (c.haloMesh) updateHaloBillboard(c.haloMesh, c.camera);
      // 联系词的飞行动画（只动它们，其它星点不动）
      stepMotion(performance.now());
      processPendingHover();
      if (!c.motionActive) updateHighlights();
      declutter();
      if (!c.motionActive) enforceFocusCentered();
      // 收敛保护：相机**真正停稳**后把取景对齐一次（让"跳转到达"与"直接搜索到达"逐像素一致）。
      // 停稳判据：相机签名（theta/phi/radius/target）连续不变 —— 与全景快照计时器彻底无关。
      // 硬保护：只要用户自己动过相机（拖拽/滚轮/双击重新居中）就永不再自动拽回去。
      {
        const nowMs = performance.now();
        const cs = c.cam.getState();
        const sig =
          cs.theta.toFixed(4) + '|' + cs.phi.toFixed(4) + '|' + cs.radius.toFixed(4) + '|' +
          cs.target.map((v) => v.toFixed(4)).join(',');
        if (sig !== c.camSig) {
          c.camSig = sig;
          c.camStableSince = nowMs;
        }
        const settled = nowMs - c.camStableSince > 300;
        if (c.wasSettled !== settled) {
          c.wasSettled = settled;
          if (settled) c.settleCount += 1;
        }
        const userMoved = Math.max(c.cam.lastUserInput(), c.heroAlignOffAt);
        // 把"被哪条判据挡住"记下来：这样 5 次里某次没对齐时能直接看出原因
        if (c.motionActive) c.alignBlock = 'moving';
        else if (!st0.selected) c.alignBlock = 'noSel';
        else if (!settled) c.alignBlock = 'notSettled';
        else if (userMoved > c.selectedAt) c.alignBlock = 'userMoved';
        else if (nowMs - c.heroAlignAt <= 500) c.alignBlock = 'throttle';
        else {
          c.alignBlock = 'ok';
          c.heroAlignAt = nowMs;
          c.heroFramedFor = st0.selected;
          if (frameSelection(false)) {
            c.heroAlignCount += 1;
            c.alignSinceSelect += 1;
          }
        }
      }
      // 投影中心避开右侧面板：三维内容按"可见画布"居中，而不是整窗居中
      const pw = panelWidth();
      if (pw !== c.panelW) {
        c.panelW = pw;
        c.viewCenterX = (c.widthCss - pw) / 2;
        const fullW = c.widthCss + pw;
        c.camera.aspect = fullW / c.heightCss;
        if (pw > 0) c.camera.setViewOffset(fullW, c.heightCss, pw, 0, c.widthCss, c.heightCss);
        else c.camera.clearViewOffset();
        c.camera.updateProjectionMatrix();
        layoutLabels();
        updateLineResolution();
      }
      // 星团中心的屏幕位置（诊断）：用它区分"相机对准错了" vs "投影/面板/DPR 映射错了"
      {
        const s2 = useWV.getState();
        const depth2c = (s2.layoutMeta?.depth ?? 2) === 2;
        const key = depth2c ? s2.minorKey : s2.majorKey;
        const cc = key ? (depth2c ? c.minorCenter : c.majorCenter)[key] : undefined;
        const sXY2 = { x: 0, y: 0, z: 0 };
        if (cc && project(cc, sXY2)) {
          c.clusterScreenX = sXY2.x;
          c.clusterOffPct = ((sXY2.x - c.viewCenterX) / Math.max(1, c.widthCss - c.panelW)) * 100;
        } else {
          c.clusterScreenX = -1;
          c.clusterOffPct = 0;
        }
      }
      // 选中词的屏幕位置：居中的正确口径（光重心会被星云/连线带偏）
      if (st0.selected) {
        const selStar = st0.starByLemma[st0.selected];
        const sp = selStar ? c.sky.posById.get(selStar.id) : undefined;
        const sXY = { x: 0, y: 0, z: 0 };
        if (sp && project(sp, sXY)) {
          c.selScreenX = sXY.x;
          const visW = Math.max(1, c.widthCss - c.panelW);
          c.selOffPct = ((sXY.x - c.viewCenterX) / visW) * 100;
        }
      } else {
        c.selScreenX = -1;
        c.selOffPct = 0;
      }
      // 星点尺寸按当前相机距离做轻微透视修正
      c.starMat.uniforms.uRefDist.value = Math.max(0.05, c.cam.getState().radius);
      c.glowMat.uniforms.uRefDist.value = c.starMat.uniforms.uRefDist.value;
      c.renderer.render(c.scene, c.camera);
      frames += 1;
      const now = performance.now();
      if (now - fpsAt > 600) {
        fps = Math.round((frames * 1000) / (now - fpsAt));
        frames = 0;
        fpsAt = now;
        if (hudRef.current) {
          hudRef.current.textContent =
            '星相 ' + c.layoutLoaded + (c.layoutLoaded === useWV.getState().layoutKey ? '' : '≠' + useWV.getState().layoutKey) + ' · ' +
            '星点 全库 ' + c.stars.length +
            '（本级 ' + c.scopeCount + '（实亮 ' + c.scopeLit + '）' +
            ' · 同屏 ' + c.visibleCount + ' · 实亮 ' + c.litVisible + '）' +
            ' · 标签 ' + c.labelsShown + (c.labelsTotal > c.labelsShown ? '/' + c.labelsTotal : '') +
            (c.focusEdges || c.focusRelated
              ? ' · 关系 连线 ' + c.focusEdges + '（在框内 ' + c.focusOnScreen + '） / 高亮 ' + c.focusRelated
              : '') +
            (c.selScreenX >= 0 ? ' · 选中词 x' + Math.round(c.selScreenX) + '（偏 ' + c.selOffPct.toFixed(1) + '%）' : '') +
            ' · 已移动 ' + c.motionTargets.size +
            ' · 取景 r' + c.frameRadius.toFixed(2) +
                    ' · 补间 ' + c.motionStarts + (c.motionActive ? '(进行中)' : '(已停)') +
            ' · 对齐 ' + c.alignSinceSelect + '/' + c.heroAlignCount + '（停稳 ' + c.settleCount +
            ' · 挡:' + c.alignBlock + ' · 距 ' + Math.round(performance.now() - c.heroAlignAt) + 'ms · 动过' +
            (Math.max(c.cam.lastUserInput(), c.heroAlignOffAt) > c.selectedAt ? 1 : 0) + '）' +
            ' · 面板 ' + Math.round(c.panelW) + 'px · 窗口 ' + Math.round(c.widthCss) + 'px · 贴图 ' + LABEL_TEX_BUILDS +
            (c.clusterScreenX >= 0 ? ' · 团心 x' + Math.round(c.clusterScreenX) + '（偏 ' + c.clusterOffPct.toFixed(1) + '%）' : '') +
            ' · ' + fps + ' fps';
        }
      }
      const st = useWV.getState();
      // 不入 store 的实时相机快照（浏览历史回退要用），每帧写一次、不触发渲染
      runtimeRefs.cam = c.cam.getState();
      if (now - c.savedAt > 800) {
        c.savedAt = now;
        const camState = c.cam.getState();
        const key =
          camState.theta.toFixed(4) + '|' + camState.phi.toFixed(4) + '|' + camState.radius.toFixed(4) +
          '|' + camState.target.map((v) => v.toFixed(4)).join(',');
        try {
          // 全景记忆只在「相机已经静止一整个采样周期」时写，避免把飞向全景的中间态写进去
          if (st.level === 0 && key === c.lastCamKey) {
            localStorage.setItem(CAM_KEY + '.' + st.layoutKey, JSON.stringify(camState));
          }
          localStorage.setItem('wv.cam.last', JSON.stringify(camState));
        } catch {
          /* 忽略存储失败 */
        }
        c.lastCamKey = key;
      }
    };

    // 双击画布 = 重新居中（拖拽跑偏后一键回来）
    const onDblClick = (): void => {
      const c = ctxRef.current;
      if (!c) return;
      const s = useWV.getState();
      if (s.level === 0) return; // 全景下不抢相机
      // 双击本身也是"用户主动指定视角"：记一笔，之后不再自动对齐
      c.heroAlignOffAt = performance.now();
      if (s.selected) {
        frameSelection(false);
        c.heroFramedFor = s.selected;
      } else {
        applyCamera();
      }
    };
    renderer.domElement.addEventListener('dblclick', onDblClick);

    renderer.setAnimationLoop(tick);
    // 看门狗：250ms 一次，只要超过 700ms 没有真正渲染过一帧就自己推一帧
    const watchdog = window.setInterval(() => {
      if (performance.now() - lastFrameAt > 700) tick();
    }, 250);

    return () => {
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('dblclick', onDblClick);
      window.clearInterval(watchdog);
      ro.disconnect();
      cam.detach();
      disposeGroup(focusGroup);
      disposeLabels();
      if (ctxRef.current && ctxRef.current.hlPoints) {
        ctxRef.current.hlPoints.geometry.dispose();
        (ctxRef.current.hlPoints.material as THREE.Material).dispose();
      }
      if (ctxRef.current && ctxRef.current.haloMesh) {
        ctxRef.current.haloMesh.geometry.dispose();
        (ctxRef.current.haloMesh.material as THREE.Material).dispose();
      }
      if (ctxRef.current && ctxRef.current.starBuf) ctxRef.current.starBuf.geometry.dispose();
      starMat.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === el) el.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- 数据到位
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !stars.length) return;
    ctx.stars = stars;
    ctx.sky = normalizeSky(stars);
    const stNow = useWV.getState();
    // 按空间相邻贪心着色：挨得近的星团色相差 ≥40°，隔得远的可复用相近色
    ctx.colorTable = spatialMajorColors(stNow.clusters.length ? stNow.clusters : stNow.majors);

    ctx.layoutLoaded = stNow.layoutKey;
    const sb = makeStarBuffers(ctx.sky, stars, useWV.getState().displayMode);
    // 记录 id→顶点下标，并把"该星相的原始位置"留一份给动画回位用
    ctx.posIndex = new Map();
    stars.forEach((s, i) => ctx.posIndex.set(s.id, i));
    ctx.basePos = (ctx.sky.positions as Float32Array).slice();
    ctx.motion = [];
    ctx.motionTargets = new Map();
    ctx.motionActive = false;
    if (ctx.starBuf) ctx.starBuf.geometry.dispose();
    ctx.starPoints.geometry = sb.geometry;
    ctx.glowPoints.geometry = sb.geometry; // 共享同一份几何：辉光严格跟着点密度走
    ctx.starBuf = sb;

    // 每个星团/子类的场景中心与半径（半径用于相机飞行距离）
    calcExtents();
    refreshStars();
    applyCamera();
    // 标签与簇晕**同步重建**：早先推到 requestAnimationFrame 里做，是想先让星点出现、
    // 避免"卡在正在读取星空"；但在低帧率（软件渲染 3-5fps）环境里，这会变成"星点已换、
    // 标签已换、几何却没轮到"的部分更新。现在一律同步做完，再立刻强制渲染一帧，
    // 保证任何帧率下切换星相都是一次性生效。
    rebuildLabels();
    rebuildHalos();
    ctx.renderer.render(ctx.scene, ctx.camera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stars]);

  // 星相切换：整张星图重排，相机回到该星相的全景
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.hoverStar = null;
    ctx.hoverLemma = null;
    ctx.hlPrev = 0;
    ctx.focusEdges = 0;
    ctx.focusRelated = 0;
    // 星相切换：动画中间态一律作废（新星图有自己的布局坐标）
    // 星相切换：新星图有自己的布局坐标，先把上一轮的临时位移作废
    ctx.motion = [];
    ctx.motionTargets = new Map();
    ctx.motionActive = false;
    disposeGroup(ctx.focusGroup);
    if (!ctx.stars.length) return;
    applyCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  // 层级切换：星点可见度 + 标签 + 相机
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    refreshStars();
    rebuildLabels();
    rebuildHalos();
    // 如果这次层级变化同时带着「定位到某颗星」的请求，就不要用层级中心覆盖它（focus 效果负责定位）
    const f = useWV.getState().focus;
    if (!(f && f.nonce !== ctx.lastFocusNonce)) applyCamera();
    clearHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, majorKey, minorKey]);

  // 显示模式（全亮 / 记忆强度）切换：重算颜色与不透明度
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !ctx.starBuf) return;
    refreshStars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMode]);

  // 亮度变化（复习回写）只刷新颜色
  useEffect(() => {
    refreshStars();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starsVersion]);

  // 选中词必须有标签（悬停/选中的标签在 declutter 里强制显示）
  useEffect(() => {
    const ctx = ctxRef.current;
    if (ctx) {
      ctx.selectedAt = performance.now();
      ctx.reassertCount = 0;
      ctx.reassertAt = 0;
    }
    ensureSelectedLabel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // 聚焦边 + 联系词高亮 + 整体框景 + 联系词飞动动画
  useEffect(() => {
    refreshStars(); // 联系词要提到全亮（关系数据可能是刚到的）
    rebuildLabels(); // 联系词的标签要一起补上（不看右侧面板也能认出它们）
    rebuildFocus();
    updateHighlights();
    // 联系词飞向选中词（取消选中则飞回原位），并按落位后的位置框景
    const c = ctxRef.current;
    if (c) {
      c.heroFramedFor = null; // 选中变了就允许再框一次
      c.alignSinceSelect = 0;
    }
    startFocusMotion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, details, stars, level, majorKey, minorKey, layoutKey, layers]);

  // 定位 / 回退飞行
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !focus) return;
    ctx.lastFocusNonce = focus.nonce;
    clearHover();
    if (focus.cam) {
      // 回退历史：相机整份还原（theta / phi / 半径 / 目标点），平滑过渡
      const cam = focus.cam;
      ctx.cam.glideTo(cam.theta, cam.phi, cam.radius, new THREE.Vector3(cam.target[0], cam.target[1], cam.target[2]));
      return;
    }
    const p = new THREE.Vector3(
      (focus.x - ctx.sky.center.x) / ctx.sky.radius,
      (focus.y - ctx.sky.center.y) / ctx.sky.radius,
      (focus.z - ctx.sky.center.z) / ctx.sky.radius,
    );
    // radius=null = 按当前层级给一个合适距离，保证目标星落在视野里
    const radius = focus.radius == null ? levelRadius() : focus.radius;
    ctx.cam.flyTo(p.x, p.y, p.z, radius);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // 窗口尺寸变化时标签要重新换算，但 ResizeObserver 已经处理；这里补一次首次布局
  useEffect(() => {
    layoutLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [majors]);

  // ---------------------------------------------------------------- 内部工具
  function calcExtents(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    const v = new THREE.Vector3();
    const toSceneV = (c: [number, number, number]) =>
      new THREE.Vector3(
        (c[0] - ctx.sky.center.x) / ctx.sky.radius,
        (c[1] - ctx.sky.center.y) / ctx.sky.radius,
        (c[2] - ctx.sky.center.z) / ctx.sky.radius,
      );
    const mc: Record<string, THREE.Vector3> = {};
    const mr: Record<string, number> = {};
    const nc: Record<string, THREE.Vector3> = {};
    const nr: Record<string, number> = {};
    // 星团中心一律来自 /api/sky 的 clusters[]（每套星相各不相同）
    for (const c of st.clusters) {
      mc[c.key] = toSceneV(c.center);
      mr[c.key] = 0;
    }
    // 情景星相 depth=2，才有子类
    for (const m of st.majors) {
      if (!mc[m.key]) {
        mc[m.key] = toSceneV(m.center);
        mr[m.key] = 0;
      }
      for (const mi of m.minors) {
        nc[mi.key] = toSceneV(mi.center);
        nr[mi.key] = 0;
      }
    }
    const byMinor: Record<string, Star[]> = {};
    const byMajor: Record<string, Star[]> = {};
    const byGroup: Record<string, Star[]> = {};
    const majorCount: Record<string, number> = {};
    const minorCount: Record<string, number> = {};
    const grpDists: Record<string, number[]> = {};
    const minDists: Record<string, number[]> = {};
    for (const s of st.stars) {
      (byMinor[s.minor] || (byMinor[s.minor] = [])).push(s);
      (byMajor[s.major] || (byMajor[s.major] = [])).push(s);
      (byGroup[s.group] || (byGroup[s.group] = [])).push(s);
      majorCount[s.major] = (majorCount[s.major] || 0) + 1;
      minorCount[s.minor] = (minorCount[s.minor] || 0) + 1;
      const p = ctx.sky.posById.get(s.id);
      if (!p) continue;
      const c1 = mc[s.group] || mc[s.major];
      if (c1) {
        const d = v.copy(p).distanceTo(c1);
        mr[s.group] = Math.max(mr[s.group] || 0, d);
        mr[s.major] = Math.max(mr[s.major] || 0, d);
        (grpDists[s.group] || (grpDists[s.group] = [])).push(d);
        (grpDists[s.major] || (grpDists[s.major] = [])).push(d);
      }
      const c2 = nc[s.minor];
      if (c2) {
        const d2b = v.copy(p).distanceTo(c2);
        nr[s.minor] = Math.max(nr[s.minor], d2b);
        (minDists[s.minor] || (minDists[s.minor] = [])).push(d2b);
      }
    }
    // 星点自身的 98 分位半径（场景单位）：L0 取景必须按"星点铺到多远"而不是"团心在哪"，
    // 否则大星团的外缘会被取景框切掉。
    const dists: number[] = [];
    const arr0 = ctx.sky.positions;
    for (let i = 0; i < arr0.length; i += 3) {
      dists.push(Math.hypot(arr0[i], arr0[i + 1], arr0[i + 2]));
    }
    dists.sort((a, b) => a - b);
    ctx.starP98 = dists.length ? dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.98))] : 1;
    ctx.byMinor = byMinor;
    ctx.byMajor = byMajor;
    ctx.byGroup = byGroup;
    ctx.majorCount = majorCount;
    ctx.minorCount = minorCount;
    ctx.majorCenter = mc;
    ctx.majorRadius = mr;
    // p90：相机要看的是"绝大部分星在哪里"，不是"最远那颗 outlier 在哪"
    const p90 = (m: Record<string, number[]>, fallback: Record<string, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const k of Object.keys(m)) {
        const a = m[k].slice().sort((x, y) => x - y);
        out[k] = a.length ? a[Math.min(a.length - 1, Math.floor(a.length * 0.9))] : fallback[k] || 0.3;
      }
      return out;
    };
    // 真实质心（按词数加权）——大团经常会"铺满整片天"，声明中心此时是空心的
    const sumM: Record<string, THREE.Vector3> = {};
    const sumN: Record<string, number[]> = {};
    const sumMi: Record<string, THREE.Vector3> = {};
    const sumMiN: Record<string, number[]> = {};
    for (const s of st.stars) {
      const p = ctx.sky.posById.get(s.id);
      if (!p) continue;
      const gm = sumM[s.major] || (sumM[s.major] = new THREE.Vector3());
      gm.add(p);
      (sumN[s.major] || (sumN[s.major] = [])).push(1);
      const gmi = sumMi[s.minor] || (sumMi[s.minor] = new THREE.Vector3());
      gmi.add(p);
      (sumMiN[s.minor] || (sumMiN[s.minor] = [])).push(1);
    }
    const majorCentroid: Record<string, THREE.Vector3> = {};
    for (const k of Object.keys(sumM)) {
      const n = sumN[k].length || 1;
      majorCentroid[k] = sumM[k].clone().multiplyScalar(1 / n);
    }
    const minorCentroid: Record<string, THREE.Vector3> = {};
    for (const k of Object.keys(sumMi)) {
      const n = sumMiN[k].length || 1;
      minorCentroid[k] = sumMi[k].clone().multiplyScalar(1 / n);
    }
    ctx.majorCentroid = majorCentroid;
    ctx.minorCentroid = minorCentroid;
    ctx.majorRadius90 = p90(grpDists, mr);
    ctx.minorCenter = nc;
    ctx.minorRadius = nr;
    ctx.minorRadius90 = p90(minDists, nr);
    // ★ 半径必须从**真实质心**量：从声明中心量出来的 p90 对"铺满整片天"的大团仍是 ~1.1，
    //   于是相机被推到 2.0（用户录屏 f008 的极淡圆盘）。从质心量才是"星到底铺开多大"。
    const cDistsM: Record<string, number[]> = {};
    const cDistsMi: Record<string, number[]> = {};
    for (const s of st.stars) {
      const p = ctx.sky.posById.get(s.id);
      if (!p) continue;
      const cm = majorCentroid[s.major];
      if (cm) (cDistsM[s.major] || (cDistsM[s.major] = [])).push(v.copy(p).distanceTo(cm));
      const cmi = minorCentroid[s.minor];
      if (cmi) (cDistsMi[s.minor] || (cDistsMi[s.minor] = [])).push(v.copy(p).distanceTo(cmi));
    }
    ctx.majorRadius90 = p90(cDistsM, ctx.majorRadius90);
    ctx.minorRadius90 = p90(cDistsMi, ctx.minorRadius90);
  }

  /** 颜色（大类色相 + strength 亮度）、tone 与当前层级的可见度 */
  function refreshStars(): void {
    const ctx = ctxRef.current;
    if (!ctx || !ctx.starBuf) return;
    const st = useWV.getState();
    const sb = ctx.starBuf;
    let visible = 0;
    let litVisible = 0;
    let scopeLit = 0;
    const mode = st.displayMode;
    const tune = LEVEL_TUNE[Math.min(2, st.level)];
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    // 选中词的联系词：它们常常在别的星团里，必须提到全亮，否则连线画在"黑屏"上
    const relIds = new Set<number>();
    for (const item of focusedRelations()) relIds.add(item.star.id);
    let toneDirty = false;
    st.stars.forEach((s, i) => {
      const cloud = !!s.groupKind && s.groupKind !== 'family';
      // L0 的星点增益来自"亮度档位"（?bright=low|mid|high），其余层级保持 1.0
      const gainNow = tune.gain * (st.level === 0 ? BRIGHTNESS.gain : 1);
      tintStar(s, colorForMajor(s.group || s.major, ctx.colorTable), ctx.tmpColor, mode, gainNow);
      // 白热核：每团最亮的 5% 强制接近白（色相不变、饱和度大降、明度拉满）
      if (sb.core[i]) {
        ctx.tmpColor.lerp(HL_WHITE, 0.7).multiplyScalar(1.05);
        ctx.tmpColor.r = Math.min(1, ctx.tmpColor.r);
        ctx.tmpColor.g = Math.min(1, ctx.tmpColor.g);
        ctx.tmpColor.b = Math.min(1, ctx.tmpColor.b);
      }
      if (cloud) {
        // 兜底星云：去饱和成灰蓝背景，别和命名家族抢注意力
        ctx.tmpColor.lerp(HL_CLOUD, 0.62);
      }
      sb.color[i * 3] = ctx.tmpColor.r;
      sb.color[i * 3 + 1] = ctx.tmpColor.g;
      sb.color[i * 3 + 2] = ctx.tmpColor.b;
      sb.tone[i] = starTone(s, mode) * tune.tone;
      let vis = 1;
      if (st.level === 0) vis = LEVEL_TUNE[0].vis;
      else if (st.level < wordsLevel) {
        // depth=2 的第二级：本大区亮，其它压到极暗
        vis = s.major === st.majorKey ? 1 : 0.012;
      } else if (depth2) {
        // 本子类 1；同大区兄弟子类只留一点星尘；其它大区几乎不可见
        vis = s.minor === st.minorKey ? 1 : s.major === st.majorKey ? 0.045 : 0.012;
      } else {
        // depth=1：本星团亮，其它星团几乎不可见
        vis = s.group === st.majorKey ? 1 : 0.012;
      }
      if (relIds.has(s.id)) {
        // 联系词：全亮 + 略放大（"重新高亮"要看得出来）
        sb.vis[i] = 1;
        sb.size[i] = starPointSize(s) * 2.7; // 联系星要明显大于背景星
        sb.boost[i] = 3.5; // 辉光单独提亮：让"被链接的星"自己发光
        toneDirty = true;
        visible += 1;
        return;
      }
      sb.size[i] = starPointSize(s) * (cloud ? 0.82 : 1);
      // 本帧这颗星是否属于"当前正在看的那一支"
      const inScopeNow =
        (st.level >= 1 && st.level < wordsLevel && s.major === st.majorKey) ||
        (st.level >= wordsLevel && depth2 && s.minor === st.minorKey) ||
        (st.level >= wordsLevel && !depth2 && s.group === st.majorKey);
      sb.boost[i] = inScopeNow ? 1.6 : 1; // 本级星给一点辉光，撑住背景星云
      if (cloud) {
        // 当前正在看的就是这片云时不要压暗它
        const inScope =
          (st.level === 0 && false) ||
          (st.level >= 1 && st.level < wordsLevel && s.major === st.majorKey) ||
          (st.level >= wordsLevel && depth2 && s.minor === st.minorKey) ||
          (st.level >= wordsLevel && !depth2 && s.group === st.majorKey);
        if (!inScope) vis *= CLOUD_DIM;
      }
      sb.vis[i] = vis;
      if (vis >= 0.02) visible += 1;
      if (vis >= 0.5) {
        litVisible += 1;
        if (inScopeNow) scopeLit += 1;
      }
    });
    ctx.visibleCount = visible;
    ctx.litVisible = litVisible;
    ctx.scopeLit = scopeLit;
    ctx.scopeCount =
      st.level === 0
        ? st.stars.length
        : st.level < wordsLevel
          ? ctx.majorCount[st.majorKey || ''] || 0
          : depth2
            ? ctx.minorCount[st.minorKey || ''] || 0
            : (ctx.byGroup[st.majorKey || ''] || []).length;
    (sb.geometry.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (sb.geometry.getAttribute('aTone') as THREE.BufferAttribute).needsUpdate = true;
    (sb.geometry.getAttribute('aVis') as THREE.BufferAttribute).needsUpdate = true;
    void toneDirty;
    // 一律标记上传：条件上传曾经是"部分更新"这类 bug 的温床，属性数组只有 26k 个 float，代价可忽略
    for (const name of ['aSize', 'aTone', 'aVis', 'aColor', 'aLit', 'aBoost']) {
      const at = sb.geometry.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (at) at.needsUpdate = true;
    }

    ctx.starMat.uniforms.uPx.value = tune.px;
    ctx.starMat.uniforms.uMinPx.value = tune.minPx;
    ctx.starMat.uniforms.uMaxPx.value = tune.maxPx;
    ctx.starMat.uniforms.uBright.value = tune.bright;
    // 辉光层：基准点径跟星核同级（再由 uGlowScale 放大），DPR / 参考距离同步
    ctx.glowMat.uniforms.uPx.value = tune.px;
    ctx.glowMat.uniforms.uDPR.value = ctx.renderer.getPixelRatio();
    const dpr = ctx.renderer.getPixelRatio();
    ctx.starMat.uniforms.uFeather.value = Math.min(0.32, Math.max(0.02, 1 / (tune.px * dpr)));
  }

  function disposeLabels(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const it of ctx.labels) {
      ctx.labelGroup.remove(it.sprite);
      it.sprite.material.dispose();
    }
    ctx.labels = [];
    ctx.labelsShown = 0;
    ctx.labelsTotal = 0;
  }

  /**
   * 标签贴图缓存：同一个标签的「裸文字」与「带底板」两套贴图各缓存一份，
   * 悬停/选中时只 swap map，不重新画 canvas（切换开销 = 0）。
   */
  function texFor(it: LabelItem, plated: boolean): ReturnType<typeof makeLabelTexture> {
    const cache = labelTexRef.current;
    const key = [it.text, it.sub, it.sizeCss, it.color, it.border, it.kind, plated ? 'p' : 'n'].join('|');
    let t = cache.get(key);
    if (!t) {
      t = makeLabelTexture(it.text, it.sub, {
        size: it.sizeCss,
        weight: it.kind === 'major' ? 700 : 600,
        color: it.color,
        subColor: 'rgba(190,205,235,0.92)',
        border: it.border,
        bg: it.kind === 'word' ? 'rgba(6,9,18,0.72)' : 'rgba(6,9,18,0.86)',
        plain: !plated,
      });
      cache.set(key, t);
    }
    return t;
  }

  /** 悬停/选中时给标签加底板，其它时候是裸文字 */
  function setLabelPlated(it: LabelItem, plated: boolean): void {
    const ctx = ctxRef.current;
    if (!ctx || it.plated === plated) return;
    const tex = texFor(it, plated);
    const mat = it.sprite.material as THREE.SpriteMaterial;
    // 只换 map：不写 needsUpdate（那会触发材质重评估/程序重编译，是另一类"闪"的来源）
    mat.map = tex.texture;
    it.plated = plated;
    it.w = tex.w;
    it.h = tex.h;
    const vh = ctx.renderer.domElement.clientHeight || ctx.heightCss;
    it.sprite.scale.set(scaleForPixels(tex.w, vh, FOV), scaleForPixels(tex.h, vh, FOV), 1);
  }

  function addLabel(
    key: string,
    kind: 'major' | 'minor' | 'word',
    text: string,
    sub: string,
    pos: THREE.Vector3,
    px: number,
    centerY: number,
    color: string,
    border: string,
    basePriority = 1e6,
    pinned = false,
    related = false,
  ): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const item = {
      key, kind, text, sub, sizeCss: px, color, border,
      related, plated: false, pinned,
    } as unknown as LabelItem;
    const tex = texFor({ ...item, sprite: null as unknown as THREE.Sprite }, false);
    // ★ 预烘焙"悬停态（带底板）"贴图：hover 时只换 map，绝不重绘 canvas ——
    //   否则首次悬停某个标签会新建贴图并上传，高帧率下表现为"整个界面闪一下"。
    texFor({ ...item, sprite: null as unknown as THREE.Sprite }, true);
    const mat = new THREE.SpriteMaterial({
      map: tex.texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      sizeAttenuation: false,
      // 标签退到次要位置：默认半透明，悬停/选中才提亮到 1
      opacity: kind === 'word' ? 0.5 : 0.62,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(pos);
    sp.center.set(0.5, centerY);
    sp.renderOrder = 10;
    // 单词标签先隐藏，等每帧的屏幕空间避让决定谁出现
    if (kind === 'word') sp.visible = false;
    // 立刻按像素换算尺寸：sizeAttenuation=false 的 sprite 默认 scale=1 会变成巨大贴图
    const vh = ctx.renderer.domElement.clientHeight || ctx.heightCss;
    sp.scale.set(scaleForPixels(tex.w, vh, FOV), scaleForPixels(tex.h, vh, FOV), 1);
    ctx.labelGroup.add(sp);
    ctx.labels.push({
      ...item,
      sprite: sp, w: tex.w, h: tex.h, centerY, pos: pos.clone(), basePriority, forced: false,
    });
  }

  function rebuildLabels(): void {
    const ctx = ctxRef.current;
    if (!ctx || !ctx.stars.length) return;
    disposeLabels();
    const st = useWV.getState();
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    if (st.level === 0) {
      // L0 星团标签直接用当前星相的 clusters[]（词根布局就是 duct / pose …）
      // 性能：96 个家族全建贴图是浪费（避让最多也就显示 30-60 个），只给最大的 N 个家族建候选
      const fams = st.clusters.filter((c) => (c.kind || 'family') === 'family').sort((a, b) => b.count - a.count);
      const keep = new Set(fams.slice(0, STYLE.clusterCandidates).map((c) => c.key));
      for (const c0 of st.clusters) {
        const c = ctx.majorCenter[c0.key];
        if (!c) continue;
        const kind = c0.kind || 'family';
        if (kind === 'family') {
          if (!keep.has(c0.key)) continue;
          // 命名家族：大族优先（basePriority 越小越先放）
          addLabel(
            c0.key, 'major', c0.zh || c0.key, '· ' + c0.count, c, 18, 0.5,
            '#eef4ff', 'rgba(140,170,235,0.5)',
            1e7 - Math.min(1e7, c0.count),
          );
        } else {
          // 兜底星云：灰色小字、永远显示（pinned）、不计入家族标签预算
          addLabel(
            c0.key, 'major', c0.zh || c0.key, '· ' + c0.count, c, 13, 0.5,
            'rgba(198,206,224,0.7)', 'rgba(120,140,175,0.26)',
            -1e9, true,
          );
        }
      }
      return;
    }
    if (st.level < wordsLevel) {
      const m = st.majors.find((x) => x.key === st.majorKey);
      if (!m) return;
      for (const mi of m.minors) {
        const c = ctx.minorCenter[mi.key];
        if (!c) continue;
        addLabel(mi.key, 'minor', mi.zh || mi.key, '· ' + mi.count, c, 15.5, 0.5, '#e8f0ff', 'rgba(140,170,235,0.4)');
      }
      // 这一级不再画大区标签：大区中心常常就是某个子类中心，两个标签会完全重叠
      return;
    }
    // 单词级：depth=2 取当前子类，depth=1 取当前星团
    const inMinor = depth2
      ? st.stars.filter((s) => s.minor === st.minorKey)
      : ctx.byGroup[st.majorKey || ''] || [];
    const score = (s: Star) => (s.frq && s.frq > 0 ? s.frq : Number.MAX_SAFE_INTEGER);
    const sorted = inMinor.slice().sort((a, b) => {
      if (a.lit !== b.lit) return b.lit - a.lit;
      return score(a) - score(b);
    });
    const picked: Star[] = sorted.slice(0, WORD_LABEL_CANDIDATES);
    const sel = st.selected ? st.starByLemma[st.selected] : undefined;
    const selInScope = sel ? (depth2 ? sel.minor === st.minorKey : sel.group === st.majorKey) : false;
    if (sel && selInScope && !picked.some((s) => s.id === sel.id)) picked.unshift(sel);
    const seen = new Set<string>();
    for (const s of picked) {
      const p = ctx.sky.posById.get(s.id);
      if (!p) continue;
      const isSel = sel && sel.id === s.id;
      seen.add(s.lemma);
      addLabel(
        s.lemma,
        'word',
        s.lemma,
        '',
        p,
        isSel ? 13.5 : 12,
        0,
        isSel ? '#ffffff' : s.lit ? '#ffe0a0' : 'rgba(214,226,250,0.95)',
        isSel ? 'rgba(120,220,255,0.95)' : s.lit ? 'rgba(255,190,90,0.55)' : 'rgba(110,140,200,0.35)',
        // 优先级：lit < 非 lit，其次词频序号（越小越常用）
        (s.lit ? 0 : 1) * 1e7 + (s.frq && s.frq > 0 ? s.frq : 999999),
      );
    }
    // 联系词：**必须带标签**。用户不看右侧面板也要知道连过来的是什么词。
    // 它们可能不在当前星团里，所以单独补，并按关系层着色（青=语义 / 紫=词根 / 橙=情景）。
    let relCount = 0;
    if (sel) {
      for (const item of focusedRelations()) {
        const s = item.star;
        if (s.id === sel.id || seen.has(s.lemma)) continue;
        const p = ctx.sky.posById.get(s.id);
        if (!p) continue;
        seen.add(s.lemma);
        relCount += 1;
        addLabel(
          s.lemma,
          'word',
          s.lemma,
          '',
          p,
          11.5,
          0,
          item.layer === 'semantic' ? '#bfefff' : item.layer === 'morphology' ? '#dcc4ff' : '#ffe0b0',
          'rgba(110,140,200,0.3)',
          0,
          false,
          true,
        );
      }
    }
    layoutLabels();
    ctx.labelsShown = 0;
    ctx.labelsTotal = picked.length + relCount;
  }

  /** 簇晕：让远景下的星团有体积感（解析式，无贴图） */
  function rebuildHalos(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (ctx.haloMesh) {
      ctx.scene.remove(ctx.haloMesh);
      ctx.haloMesh.geometry.dispose();
      (ctx.haloMesh.material as THREE.Material).dispose();
      ctx.haloMesh = null;
    }
    const st = useWV.getState();
    if (!ctx.stars.length) return;
    const items: Array<{ center: THREE.Vector3; radius: number; color: THREE.Color; opacity: number }> = [];
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    if (st.level === 0) {
      // 兜底星云本身就已经是几万个点的雾，再叠一层大尺寸加法混合的晕纯属浪费填充率
      // L0 的簇晕就是"整屏一层雾"的根源：10 个加法混合的大柔光互相重叠，把星团之间的黑底填满了。
      // 所以 L0 默认完全不画晕，只给"当前悬停/正在看的那个簇"一点柔光；其它层级照旧。
      const fams = ctx.haloKey ? st.clusters.filter((c) => c.key === ctx.haloKey) : [];
      for (const c0 of fams) {
        const c = ctx.majorCenter[c0.key];
        const r = ctx.majorRadius[c0.key];
        if (!c || !r) continue;
        // L0 取景拉远后晕会显得很大，收一档避免整片发灰
        items.push({
          center: c,
          // 只给当前簇一点柔光，不做全屏铺开
          radius: r * 1.05 + 0.012,
          color: colorForMajor(c0.key, ctx.colorTable),
          opacity: 0.12,
        });
      }
    } else if (st.level < wordsLevel && st.majorKey) {
      const c = ctx.majorCenter[st.majorKey];
      const r = ctx.majorRadius[st.majorKey];
      if (c && r) {
        items.push({ center: c, radius: r * 1.12 + 0.015, color: colorForMajor(st.majorKey, ctx.colorTable), opacity: 0.08 });
      }
      const mj = st.majors.find((x) => x.key === st.majorKey);
      for (const mi of mj ? mj.minors : []) {
        const mc = ctx.minorCenter[mi.key];
        const mr = ctx.minorRadius[mi.key];
        if (mc && mr) items.push({ center: mc, radius: mr * 1.2 + 0.012, color: colorForMajor(st.majorKey, ctx.colorTable), opacity: 0.07 });
      }
    } else if (depth2 && st.minorKey) {
      const c = ctx.minorCenter[st.minorKey];
      const r = ctx.minorRadius[st.minorKey];
      if (c && r) {
        items.push({ center: c, radius: r * 1.2 + 0.01, color: colorForMajor(st.majorKey || '', ctx.colorTable), opacity: 0.07 });
      }
    } else if (st.majorKey) {
      const c = ctx.majorCenter[st.majorKey];
      const r = ctx.majorRadius[st.majorKey];
      if (c && r) {
        items.push({ center: c, radius: r * 1.15 + 0.01, color: colorForMajor(st.majorKey, ctx.colorTable), opacity: 0.07 });
      }
    }
    const mesh = makeHaloMesh(items);
    if (!mesh) return;
    mesh.renderOrder = 0;
    ctx.scene.add(mesh);
    ctx.haloMesh = mesh;
    updateHaloBillboard(mesh, ctx.camera);
  }

  /** 选中的词必须在场景里有标签（即使它原本不在候选里） */
  function ensureSelectedLabel(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    if (st.level < wordsLevel || !st.selected) return;
    if (ctx.labels.some((l) => l.kind === 'word' && l.key === st.selected)) return;
    const star = st.starByLemma[st.selected];
    if (!star) return;
    if (depth2 ? star.minor !== st.minorKey : star.group !== st.majorKey) return;
    const p = ctx.sky.posById.get(star.id);
    if (!p) return;
    addLabel(star.lemma, 'word', star.lemma, '', p, 13.5, 0, '#ffffff', 'rgba(120,220,255,0.95)',
      (star.lit ? 0 : 1) * 1e7 + (star.frq && star.frq > 0 ? star.frq : 999999));
    ctx.labelsTotal = ctx.labels.filter((l) => l.kind === 'word').length;
    layoutLabels();
  }

  function layoutLabels(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const h = ctx.renderer.domElement.clientHeight || ctx.heightCss;
    for (const it of ctx.labels) {
      it.sprite.scale.set(scaleForPixels(it.w, h, FOV), scaleForPixels(it.h, h, FOV), 1);
    }
  }

  /** 让 project() 用上当前帧的相机矩阵 */
  function syncCamera(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.camera.updateMatrixWorld(true);
    ctx.camera.matrixWorldInverse.copy(ctx.camera.matrixWorld).invert();
  }

  /**
   * 屏幕空间标签避让（每帧跑一次）：
   *  1) 兜底星云的标签 pinned，永远显示、先占位、不参与预算竞争（否则 96 个家族标签会被两片大云挤掉）；
   *  2) 命名家族标签按「大族优先 + 靠屏幕中心」贪心放置，受预算限制（放大后自然能看到更多）；
   *  3) 单词标签按「选中/悬停 > lit > frq 小」贪心放置，受 MAX_VISIBLE_WORD_LABELS 限制。
   */
  function declutter(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    syncCamera();
    const st = useWV.getState();
    const forced = new Set<string>();
    if (st.selected) forced.add(st.selected);
    if (ctx.hoverLemma) forced.add(ctx.hoverLemma);

    const cx = ctx.widthCss / 2;
    const cy = ctx.heightCss / 2;
    // 选中词在屏幕上的位置：联系词标签沿这个中心向外推
    const selStarD = st.selected ? st.starByLemma[st.selected] : undefined;
    const selPosD = selStarD ? ctx.sky.posById.get(selStarD.id) : undefined;
    let relCx = cx;
    let relCy = cy;
    if (selPosD) {
      tmpProj.copy(selPosD).project(ctx.camera);
      relCx = (tmpProj.x * 0.5 + 0.5) * ctx.widthCss;
      relCy = (-tmpProj.y * 0.5 + 0.5) * ctx.heightCss;
    }
    let relRow = 0;
    const placed: number[] = [];
    const pinned: LabelItem[] = [];
    const clusters: LabelItem[] = [];
    const words: LabelItem[] = [];
    const s = { x: 0, y: 0, z: 0 };
    const pad = 3;
    let shown = 0;

    const rectFor = (it: LabelItem, px: number, py: number): number[] => {
      const top = it.centerY === 0 ? py - it.h : py - it.h / 2;
      if (it.related) {
        // 联系词：沿"离选中词的径向"外推；内外两圈交替，同一角度方向能放下两倍标签
        const dx = px - relCx;
        const dy = py - relCy;
        const len = Math.hypot(dx, dy) || 1;
        const push = it.h * (relRow % 2 === 0 ? 0.55 : 1.95);
        relRow += 1;
        const qx = px + (dx / len) * push;
        const qy = py + (dy / len) * push;
        const t2 = qy - it.h;
        return [qx - it.w / 2 - 1, t2 - 1, qx + it.w / 2 + 1, t2 + it.h + 1];
      }
      return [px - it.w / 2 - pad, top - pad, px + it.w / 2 + pad, top + it.h + pad];
    };
    const hits = (r: number[]): boolean => {
      for (let i = 0; i < placed.length; i += 4) {
        if (!(r[2] < placed[i] || r[0] > placed[i + 2] || r[3] < placed[i + 1] || r[1] > placed[i + 3])) return true;
      }
      return false;
    };

    for (const it of ctx.labels) {
      if (it.kind === 'word') words.push(it);
      else if (it.pinned) pinned.push(it);
      else clusters.push(it);
    }

    // 1) 兜底星云：永远显示
    for (const it of pinned) {
      it.sprite.visible = true;
      shown += 1;
      if (project(it.pos, s)) placed.push(...rectFor(it, s.x, s.y));
    }

    // 2) 命名家族：贪心 + 预算（放大到半径 < 1.4 时放宽，能看到更多家族）
    const zoomedIn = ctx.cam.getState().radius < 1.4;
    const clusterBudget = zoomedIn ? Math.round(STYLE.clusterBudget * 1.8) : STYLE.clusterBudget;
    let clusterShown = 0;
    const cOrder = clusters
      .map((it) => {
        const ok = project(it.pos, s);
        const px = s.x;
        const py = s.y;
        const dist = ok ? Math.hypot(px - cx, py - cy) : 1e9;
        return { it, ok, px, py, key: it.basePriority + dist };
      })
      .sort((a, b) => a.key - b.key);
    for (const o of cOrder) {
      if (!o.ok) {
        o.it.sprite.visible = false;
        continue;
      }
      const r = rectFor(o.it, o.px, o.py);
      if (hits(r) || clusterShown >= clusterBudget) {
        o.it.sprite.visible = false;
        continue;
      }
      o.it.sprite.visible = true;
      placed.push(...r);
      clusterShown += 1;
      shown += 1;
    }

    // 3) 单词标签。顺序：选中/悬停（强制）> 联系词（不占预算）> 普通词（受预算）
    const order = words
      .map((it) => {
        const ok = project(it.pos, s);
        const px = s.x;
        const py = s.y;
        const dist = ok ? Math.hypot(px - cx, py - cy) : 1e9;
        // 强制项最优先；联系词排第二档（比普通词高，比选中/悬停低）
        const tier = forced.has(it.key) ? -1e9 : it.related ? -5e8 : 0;
        return { it, ok, px, py, key: tier + it.basePriority + dist };
      })
      .sort((a, b) => a.key - b.key);

    let wordBudgetUsed = 0;
    for (const o of order) {
      const it = o.it;
      const isForced = forced.has(it.key);
      const isRel = it.related && !isForced;
      if (!o.ok) {
        it.sprite.visible = false;
        continue;
      }
      const r = rectFor(it, o.px, o.py);
      // 联系词一律显示（它们就是这一屏要回答的问题"连过来的是哪些词"）：
      // 只放弃重叠判定的"淘汰权"，但仍然占位，避免后面的普通词压上来。
      // 联系词虽然"强制显示"，但彼此之间仍要避让：走同一套贪心判定（优先级最高、不占预算），
      // 实在放不下的才隐藏 —— 目标是不重叠，而不是全部硬叠在一起。
      const skipOverlap = isForced;
      const hit = !skipOverlap && hits(r);
      // 联系词不占单词预算（只受重叠约束），否则 40 个联系词会把它们自己挤掉
      const overBudget = !skipOverlap && !isRel && wordBudgetUsed >= MAX_VISIBLE_WORD_LABELS;
      if (hit || overBudget) {
        it.sprite.visible = false;
        continue;
      }
      it.sprite.visible = true;
      it.forced = isForced;
      it.sprite.material.opacity = isForced ? 1 : it.related ? 0.78 : it.kind === 'word' ? 0.5 : 0.62;
      // 悬停/选中的标签给底板，其余裸文字
      setLabelPlated(it, isForced);
      if (!isRel) wordBudgetUsed += 1;
      placed.push(...r);
      shown += 1;
    }
    ctx.labelsShown = shown;
  }

  /** 层级切换 / 相机开始飞行时清掉悬停卡与悬停环；飞行落地后会按最后一次鼠标位置重新拾取 */
  function clearHover(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    ctx.hoverStar = null;
    ctx.hoverLemma = null;
    // 让恢复后第一帧强制重算（绕过 2px 位移判定）
    ctx.hoverLastX = -1e5;
    ctx.hoverLastY = -1e5;
    ctx.hoverResumeAt = performance.now() + 900;
    useWV.getState().setHover(null);
  }

  /** 每帧最多做一次悬停拾取；鼠标不动、或在飞行中就不做 */
  function processPendingHover(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const ph = ctx.pendingHover;
    if (!ph) {
      if (ctx.hoverStar || ctx.hoverLemma) {
        ctx.hoverStar = null;
        ctx.hoverLemma = null;
        useWV.getState().setHover(null);
      }
      return;
    }
    // 相机飞行期间不拾取（鼠标底下已经换了一颗星），落地后再补
    if (performance.now() < ctx.hoverResumeAt) return;
    if (Math.abs(ph.x - ctx.hoverLastX) < 2 && Math.abs(ph.y - ctx.hoverLastY) < 2) return;
    ctx.hoverLastX = ph.x;
    ctx.hoverLastY = ph.y;
    hoverAt(ph.x, ph.y);
  }

  /** 悬停拾取：只在当前层级范围内、只在当前子类/大区的星点里找 */
  function hoverAt(x: number, y: number): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    if (y < 96) {
      // 落在顶栏/面包屑区域，不算悬停星点
      if (ctx.hoverStar) {
        ctx.hoverStar = null;
        ctx.hoverLemma = null;
        useWV.getState().setHover(null);
      }
      return;
    }
    syncCamera();
    // 只在当前层级的范围里拾取：单词级（子类或星团）/ 上一层 / 全量
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    // 联系词可能不在当前星团里，但用户一定会去悬停它们 —— 所以把它们并进候选集合
    const relStars = focusedRelations().map((r) => r.star);
    const inScope: Star[] =
      st.level >= wordsLevel
        ? depth2
          ? ctx.byMinor[st.minorKey || ''] || []
          : ctx.byGroup[st.majorKey || ''] || []
        : st.level >= 1
          ? ctx.byMajor[st.majorKey || ''] || []
          : st.stars;
    const candidates: Star[] = relStars.length ? inScope.concat(relStars) : inScope;
    const s = { x: 0, y: 0, z: 0 };
    let best: Star | null = null;
    let bestD = 11;
    for (const star of candidates) {
      const p = ctx.sky.posById.get(star.id);
      if (!p) continue;
      if (!project(p, s)) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestD) {
        bestD = d;
        best = star;
      }
    }
    ctx.hoverStar = best;
    const lemma = best ? best.lemma : null;
    ctx.hoverLemma = lemma;
    useWV.getState().setHover(lemma);
  }

  /** 当前层级下"合适"的相机距离 */
  function levelRadius(): number {
    const ctx = ctxRef.current;
    const st = useWV.getState();
    if (!ctx) return 2.95;
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    if (st.level >= wordsLevel && st.majorKey) {
      const r = depth2
        ? ctx.minorRadius90[st.minorKey || ''] || ctx.minorRadius[st.minorKey || ''] || 0.3
        : ctx.majorRadius90[st.majorKey] || ctx.majorRadius[st.majorKey] || 0.3;
      return Math.min(1.9, Math.max(0.14, r * 1.5 + 0.07));
    }
    if (st.level >= 1 && st.majorKey) {
      const r = ctx.majorRadius90[st.majorKey] || ctx.majorRadius[st.majorKey] || 0.4;
      return Math.min(2.6, Math.max(0.28, r * 1.62 + 0.16));
    }
    return 2.95;
  }

  /**
   * 保证「选中的那颗星」在视野中心 ±15% 以内：
   * 任何别的相机动作把它挤走（或飞行未收敛就被打断）时，自动再定位一次。
   * 用户自己拖拽/缩放之后 1.5s 内不抢相机；每次选中最多自校正 3 次。
   */
  function enforceFocusCentered(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    const star = st.selected ? st.starByLemma[st.selected] : undefined;
    if (!star) return;
    const now = performance.now();
    if (now - ctx.selectedAt < 700) return;
    // 选中之后用户自己拖拽/缩放过，就认为他是在自由探索，不再抢相机
    if (ctx.cam.lastUserInput() > ctx.selectedAt) return;
    if (now - ctx.reassertAt < 1500) return;
    if (ctx.reassertCount >= 3) return;
    const p = ctx.sky.posById.get(star.id);
    if (!p) return;
    syncCamera();
    const s = { x: 0, y: 0, z: 0 };
    const visible = project(p, s);
    const minSide = Math.min(ctx.widthCss, ctx.heightCss);
    // 用"可见区中心"（右侧面板盖住的部分不算），否则自校正会把星推到面板底下
    const off = visible
      ? Math.hypot(s.x - ctx.viewCenterX, s.y - ctx.heightCss / 2) / minSide
      : 1;
    if (off <= 0.32) return;
    ctx.reassertAt = now;
    ctx.reassertCount += 1;
    // 优先重新框住"选中词 + 联系词"这一组，没有联系词时再退回居中该词
    if (!frameSelection()) ctx.cam.flyTo(p.x, p.y, p.z, levelRadius());
  }

  /** 悬停环 + 选中环（解析式，无贴图） */
  function updateHighlights(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    const tune = LEVEL_TUNE[Math.min(2, st.level)];
    const spec = (star: Star | null | undefined, color: THREE.Color, core: number, ring: number): HighlightSpec | null => {
      if (!star) return null;
      const p = ctx.sky.posById.get(star.id);
      if (!p) return null;
      const base = Math.min(tune.maxPx, Math.max(tune.minPx, starPointSize(star) * tune.px));
      return { pos: p, sizePx: Math.min(46, Math.max(15, base * 2)), color, core, ring };
    };
    const sel = st.selected ? st.starByLemma[st.selected] : undefined;
    const hover = ctx.hoverStar;
    setHighlightPoint(ctx.hlPoints, 0, hover && (!sel || sel.id !== hover.id) ? spec(hover, HL_HOVER, 0.45, 0.9) : null);
    setHighlightPoint(ctx.hlPoints, 1, spec(sel || null, HL_SELECT, 0.5, 1));
    // 联系词：细环 + 提亮 + 略放大，环色跟随关系层
    let i = 2;
    if (sel) {
      for (const item of focusedRelations()) {
        if (item.star.id === sel.id || i >= HIGHLIGHT_SLOTS) continue;
        const p = ctx.sky.posById.get(item.star.id);
        if (!p) continue;
        const base = Math.min(tune.maxPx, Math.max(tune.minPx, starPointSize(item.star) * tune.px));
        // 环要略大于被放大的星点：实心核负责"提亮放大"，细环负责"标记"
        const sizePx = Math.min(34, Math.max(12, base * 1.15));
        setHighlightPoint(ctx.hlPoints, i, {
          pos: p,
          sizePx,
          color: HL_REL[item.layer],
          core: 0.85,
          ring: 0.9,
        });
        i += 1;
      }
    }
    for (let k = i; k < Math.max(i, ctx.hlPrev); k += 1) setHighlightPoint(ctx.hlPoints, k, null);
    ctx.hlPrev = i;
    ctx.focusRelated = Math.max(0, i - 2);
    // 硬指标：连线对应端点里有几个真的落在画面内（不能只看画面里的像素！）
    if (sel) {
      syncCamera();
      const ss = { x: 0, y: 0, z: 0 };
      let onScreen = 0;
      for (const item of focusedRelations()) {
        const p = ctx.sky.posById.get(item.star.id);
        if (!p) continue;
        if (!project(p, ss)) continue;
        if (ss.x < 0 || ss.x > ctx.widthCss || ss.y < 0 || ss.y > ctx.heightCss) continue;
        onScreen += 1;
      }
      ctx.focusOnScreen = onScreen;
    } else {
      ctx.focusOnScreen = 0;
    }
    (ctx.hlPoints.material as THREE.ShaderMaterial).uniforms.uDPR.value = ctx.renderer.getPixelRatio();
  }

  /**
   * 把「选中词 + 它的联系词」整体框进视野：用这些点的包围球定相机中心与距离，
   * 否则连线会跑到屏幕外，用户还是看不见。
   */
  /** 联系词的目标位置：向选中词收拢到 35%，并受「不超过层级半径一半」的硬上限约束 */
  function relatedTargets(): Map<number, THREE.Vector3> {
    const ctx = ctxRef.current;
    const out = new Map<number, THREE.Vector3>();
    if (!ctx) return out;
    const st = useWV.getState();
    const sel = st.selected ? st.starByLemma[st.selected] : undefined;
    if (!sel) return out;
    const p0 = ctx.sky.posById.get(sel.id);
    if (!p0) return out;
    // 层级半径在新数据下可能很小（家族半径按词数^0.35 编码），0.5× 会把 20-30 个联系词挤成一坨、
    // 标签全被重叠判掉。这里给一个绝对下限，保证拉近之后仍然铺得开、标签看得见。
    const cap = Math.max(0.17, levelRadius() * PULL_CAP);
    for (const item of focusedRelations()) {
      // 必须用「原始坐标」算目标：聚焦效果可能触发多次，用当前位置会越拉越近、最后叠成一团
      const idx = ctx.posIndex.get(item.star.id);
      if (idx === undefined || !ctx.basePos) continue;
      const base = new THREE.Vector3(ctx.basePos[idx * 3], ctx.basePos[idx * 3 + 1], ctx.basePos[idx * 3 + 2]);
      const dir = new THREE.Vector3().subVectors(base, p0);
      const d = dir.length() || 1e-6;
      dir.setLength(Math.min(d * PULL_RATIO, cap));
      out.set(item.star.id, new THREE.Vector3().addVectors(p0, dir));
    }
    return out;
  }

  /** 启动一次动画：没有实际位移就直接结束；有位移则按"落位后"的位置框景 */
  function beginMotion(targets: Map<number, THREE.Vector3>): void {
    const ctx = ctxRef.current;
    if (!ctx || !ctx.starBuf) return;
    const posAttr = ctx.starBuf.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const entries: Ctx['motion'] = [];
    for (const [id, to] of targets) {
      const idx = ctx.posIndex.get(id);
      if (idx === undefined) continue;
      const from = new THREE.Vector3(arr[idx * 3], arr[idx * 3 + 1], arr[idx * 3 + 2]);
      if (from.distanceToSquared(to) < 1e-9) continue;
      entries.push({ id, idx, from, to });
    }
    ctx.motion = entries;
    ctx.motionStart = performance.now();
    ctx.motionActive = entries.length > 0;
    ctx.motionStarts += 1; // 诊断：这个数一直涨就说明补间被反复重启
    frameSelection(true);
  }

  /**
   * 立即把**上一轮被移动过的所有星**复位到该星相的原始坐标（瞬移，不做动画）。
   * 这一步是"跳转后画面怪异"的核心修复：以前 relatedTargets() 直接覆盖 motionTargets，
   * 上一轮被拉向 A、又不属于 B 关系集的那批星就永远停在半路上。
   */
  function resetMovedStars(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    // ★ 无条件清空："被移动的星"的唯一真相源。任何一次选中变化都必须先清空旧集合再重建，
    //   否则"新关系集为空（数据未就绪 / 该词没有关系词 / 异常路径）"时旧集合就会残留 ——
    //   这是"临时状态没清干净"这类 bug 的又一个入口，一行堵住。
    const moved = ctx.motionTargets;
    ctx.motionTargets = new Map();
    ctx.motion = [];
    ctx.motionActive = false;
    if (moved.size === 0) return;
    if (!ctx.starBuf || !ctx.basePos) {
      rebuildFocus();
      return;
    }
    const posAttr = ctx.starBuf.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const st = useWV.getState();
    let touched = false;
    for (const id of moved.keys()) {
      const idx = ctx.posIndex.get(id);
      if (idx === undefined) continue;
      const x = ctx.basePos[idx * 3];
      const y = ctx.basePos[idx * 3 + 1];
      const z = ctx.basePos[idx * 3 + 2];
      arr[idx * 3] = x;
      arr[idx * 3 + 1] = y;
      arr[idx * 3 + 2] = z;
      const v = ctx.sky.posById.get(id);
      if (v) v.set(x, y, z);
      touched = true;
    }
    if (!touched) return;
    // 标签也跟着回原位（否则词名会留在半路）
    for (const it of ctx.labels) {
      if (it.kind !== 'word') continue;
      const star = st.starByLemma[it.key];
      if (!star || !moved.has(star.id)) continue;
      const p = ctx.sky.posById.get(star.id);
      if (!p) continue;
      it.pos.copy(p);
      it.sprite.position.copy(p);
    }
    posAttr.needsUpdate = true;
    rebuildFocus();
    updateHighlights();
  }

  /** 选中变化 → 先复位上一轮，再让新一批联系词飞过去；取消选中 → 复位即结束 */
  function startFocusMotion(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    if (!st.selected) {
      resetMovedStars();
      ctx.focusStartedFor = '';
      return;
    }
    // ★ 幂等锁：这个 effect 的依赖含 details / stars（关系数据与星图会分几次到达），
    //   每来一次就重启一次补间 → motionActive 永远为真（heroAlign 永远被 moving 挡住），
    //   而且会反复用"半途的目标位置"去 frameSelection(true) → 相机越收越近、端点全部出框。
    //   键 = 选中词 + 联系词数：数据补齐后会再启动一次，之后就不再重启。
    const key = st.selected + '#' + focusedRelations().length;
    if (ctx.focusStartedFor === key) return;
    ctx.focusStartedFor = key;
    // ① 复位必须先完成，再开始新的拉近：两个动画绝不重叠
    resetMovedStars();
    // ② 新的拉近：motionTargets 按当前选中词重建（不累加）
    ctx.motionTargets = relatedTargets();
    beginMotion(ctx.motionTargets);
  }

  /** 每帧推进动画：只动联系词，其它星点不动 */
  function stepMotion(now: number): void {
    const ctx = ctxRef.current;
    if (!ctx || !ctx.motionActive || !ctx.starBuf) return;
    const k = Math.min(1, (now - ctx.motionStart) / MOTION_MS);
    // easeInOutCubic：起步慢、中段快、收尾稳
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const posAttr = ctx.starBuf.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const moving = new Set<number>();
    for (const m of ctx.motion) {
      const x = m.from.x + (m.to.x - m.from.x) * e;
      const y = m.from.y + (m.to.y - m.from.y) * e;
      const z = m.from.z + (m.to.z - m.from.z) * e;
      arr[m.idx * 3] = x;
      arr[m.idx * 3 + 1] = y;
      arr[m.idx * 3 + 2] = z;
      const v = ctx.sky.posById.get(m.id);
      if (v) v.set(x, y, z);
      moving.add(m.id);
    }
    posAttr.needsUpdate = true;
    // 标签跟着走，否则连线在动、词名留在原地
    const st = useWV.getState();
    for (const it of ctx.labels) {
      if (it.kind !== 'word') continue;
      const star = st.starByLemma[it.key];
      if (!star || !moving.has(star.id)) continue;
      const p = ctx.sky.posById.get(star.id);
      if (!p) continue;
      it.pos.copy(p);
      it.sprite.position.copy(p);
    }
    // 连线跟着动（隔帧重建就够，省一半开销）
    ctx.motionTick += 1;
    if (ctx.motionTick % 2 === 0) refreshFocusLines();
    if (k >= 1) {
      ctx.motionActive = false;
      ctx.motion = [];
      frameSelection(false); // 落位后用真实位置再框一次，确保所有联系词都在画面内
    }
  }

  function frameSelection(useTargets = false): boolean {
    const ctx = ctxRef.current;
    if (!ctx) return false;
    const st = useWV.getState();
    const selStar = st.selected ? st.starByLemma[st.selected] : undefined;
    if (!selStar) return false;
    // ---- 1) 主角 = 选中词 + 联系词：**只有它们决定画面中心** ----
    const hero: THREE.Vector3[] = [];
    const p0 = ctx.sky.posById.get(selStar.id);
    if (p0) hero.push(p0);
    for (const item of focusedRelations()) {
      const t = useTargets ? ctx.motionTargets.get(item.star.id) : undefined;
      const p = t || ctx.sky.posById.get(item.star.id);
      if (p) hero.push(p);
    }
    if (hero.length <= 1) return false; // 没有联系词就不动相机（保持已定位到该词）
    const c = new THREE.Vector3();
    for (const p of hero) c.add(p);
    c.multiplyScalar(1 / hero.length);
    // ★ 画面中心必须以"选中的那个词"为主：c 是"选中词 + 联系词"的算术平均，
    //   联系词在空间上偏向一侧时，选中的词本身就会偏出可见区中心
    //   （用户看到的就是"点进去的那个词不在视野中心"；面板 chip 跳转同样会偏）。
    c.multiplyScalar(1 - HERO_CENTER_W).addScaledVector(hero[0], HERO_CENTER_W);

    // 主角半径：用**最大值**（不是分位数）—— 用分位等于故意把最远的若干个甩出画面，
    // 表现就是"连线飘出屏幕、线头看不见"。这里按最大距离 + 10% 边距取景。
    const ds = hero.map((p) => c.distanceTo(p)).sort((a, b) => a - b);
    const heroR = Math.max(ds[ds.length - 1] || 0, 0.06);

    // ---- 2) 距离：保证主角（含最远的联系词）全部落在画面内，并且至少占 HERO_FRAME ----
    const tan = Math.tan((FOV * Math.PI) / 180 / 2);
    // 按最大距离取景（保证一条线都不飘出去）；HERO_FRAME 只用来给"主角不要太小"设一个下限
    let d = Math.max((heroR * 1.1) / tan, (heroR * 0.9) / (HERO_FRAME * tan));

    // ---- 3) 星团范围只作为"必须落在画面内"的约束：不够就拉远，**不平移** ----
    const depth2f = (st.layoutMeta?.depth ?? 2) === 2;
    const clusterKey = depth2f ? st.minorKey : st.majorKey;
    if (clusterKey) {
      const cc = (depth2f ? ctx.minorCenter : ctx.majorCenter)[clusterKey];
      const cr = (depth2f ? ctx.minorRadius : ctx.majorRadius)[clusterKey] || 0;
      if (cc) {
        const need = c.distanceTo(cc) + cr;
        d = Math.max(d, (need * 1.04) / tan);
      }
    }
    d = Math.min(6, Math.max(0.14, d));

    // ---- 4) 选中词落在画面中心偏下 1/3：把注视点沿 +Y 抬一点 ----
    const target = c.clone();
    target.y += HERO_BIAS * d * tan;
    ctx.frameRadius = d; // 词层取景也回写，否则 HUD 的"取景 r"在词层是过期值
    ctx.cam.flyTo(target.x, target.y, target.z, d);
    return true;
  }

  /** 保持选中态连线的像素宽度（resize / DPR 变化后重新同步） */
  function syncFocusLineWidth(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const dpr = ctx.renderer.getPixelRatio();
    for (const l of ctx.focusLines) {
      syncThickLine(l.seg, ctx.widthCss, ctx.heightCss, dpr, l.style.width);
    }
  }

  function updateLineResolution(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const v = new THREE.Vector2();
    ctx.renderer.getDrawingBufferSize(v);
    for (const g of [ctx.focusGroup]) {
      for (const child of g.children) {
        const m = (child as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        if (m && m.uniforms && m.uniforms.uResolution) (m.uniforms.uResolution.value as THREE.Vector2).copy(v);
      }
    }
  }

  /**
   * L0 全景取景：用当前星相所有星团中心算包围球，保证整张星空都进画面
   * （可见半高 = d·tan(fov/2)，取 2.25 倍半径再留余量）。
   */
  function panoFrame(): { target: THREE.Vector3; radius: number } {
    const ctx = ctxRef.current;
    const st = useWV.getState();
    const target = new THREE.Vector3();
    if (!ctx) return { target, radius: 2.95 };
    // 1) 取景中心：所有星团中心的质心（用于把画面中心放到星空正中）
    const pts: THREE.Vector3[] = [];
    for (const c of st.clusters) {
      const p = ctx.majorCenter[c.key];
      if (p) pts.push(p);
    }
    if (pts.length >= 2) {
      for (const p of pts) target.add(p);
      target.multiplyScalar(1 / pts.length);
    }
    // 2) 取景距离：按"星点铺到多远"（98 分位半径）留 14% 边距，
    //    可见半高 = d·tan(fov/2)，所以 d = 半径 / tan(fov/2)。
    const half = Math.tan((FOV * Math.PI) / 180 / 2);
    const ext = Math.max(0.15, ctx.starP98) * 1.14;
    const d = ext / half + Math.max(0, target.length());
    return { target, radius: Math.min(9, Math.max(0.9, d)) };
  }

  function applyCamera(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const st = useWV.getState();
    if (st.level === 0) {
      // 旋转沿用上次记忆，但中心与距离一律按"所有星团都装得下"重算
      const frame = panoFrame();
      ctx.frameRadius = frame.radius;
      const p = readPano();
      if (p) ctx.cam.setView(p.theta, p.phi, frame.radius, frame.target);
      else ctx.cam.flyTo(frame.target.x, frame.target.y, frame.target.z, frame.radius);
      return;
    }
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    if (st.level >= wordsLevel) {
      // 目标用真实质心（声明中心对铺满整片天的大团是空心的）
      const c = depth2
        ? ctx.minorCentroid[st.minorKey || ''] || ctx.minorCenter[st.minorKey || '']
        : ctx.majorCentroid[st.majorKey || ''] || ctx.majorCenter[st.majorKey || ''];
      ctx.frameRadius = levelRadius();
      if (c) ctx.cam.flyTo(c.x, c.y, c.z, ctx.frameRadius);
      return;
    }
    if (st.level >= 1 && st.majorKey) {
      const c = ctx.majorCentroid[st.majorKey] || ctx.majorCenter[st.majorKey];
      // p90：避免 outlier 把整团推到远处（L0 早就用 p98 了，这里之前漏了）
      const r = ctx.majorRadius90[st.majorKey] || ctx.majorRadius[st.majorKey] || 0.4;
      const rad = Math.min(2.6, Math.max(0.28, r * 1.62 + 0.16));
      ctx.frameRadius = rad;
      if (c) ctx.cam.flyTo(c.x, c.y, c.z, rad);
    }
  }

  /**
   * 当前要画的关系层 = 当前星相对应的那一层 + 用户用顶部开关额外打开的各层。
   * 例如词根家族星相默认画 morphology，用户再打开"语义"就两层都画。
   */
  function focusLayers(): RelLayer[] {
    const st = useWV.getState();
    const base = st.layoutMeta?.edgesLayer;
    const order: RelLayer[] = ['semantic', 'morphology', 'scenario'];
    return order.filter((l) => l === base || st.layers[l]);
  }

  /** 选中词的联系词（按权重降序，最多 MAX_FOCUS_EDGES 条） */
  function focusedRelations(): { layer: RelLayer; rel: Rel; star: Star }[] {
    const st = useWV.getState();
    if (!st.selected) return [];
    const detail = st.details[st.selected];
    if (!detail) return [];
    const on = focusLayers();
    const all: { layer: RelLayer; rel: Rel; star: Star }[] = [];
    for (const layer of on) {
      const list = detail.relations[layer] as Rel[] | undefined;
      for (const rel of list || []) {
        const star = st.starById[rel.id];
        if (!star) continue;
        all.push({ layer, rel, star });
      }
    }
    all.sort((a, b) => (b.rel.weight || 0) - (a.rel.weight || 0));
    return all.slice(0, MAX_FOCUS_EDGES);
  }

  /** 按当前坐标把某一桶的折线顶点算出来 */
  function focusBucketPoints(b: { style: EdgeStyle; pairs: [number, number][] }): Float32Array {
    const ctx = ctxRef.current;
    const out: number[] = [];
    if (!ctx) return new Float32Array(out);
    for (const [a, b2] of b.pairs) {
      const A = ctx.sky.posById.get(a);
      const B = ctx.sky.posById.get(b2);
      if (!A || !B) continue;
      pushEdge(out, A, B, b.style.arc, b.style.bulge, 14);
    }
    return new Float32Array(out);
  }

  /** 动画期间：只更新顶点，不重建几何/材质（每帧新建 LineSegments2 是没必要的开销） */
  function refreshFocusLines(): void {
    const ctx = ctxRef.current;
    if (!ctx || !ctx.focusLines.length) return;
    for (const b of ctx.focusLines) {
      const pts = focusBucketPoints(b);
      if (pts.length >= 6) b.seg.geometry.setPositions(pts);
    }
  }

  function rebuildFocus(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;
    disposeGroup(ctx.focusGroup);
    ctx.focusLines = [];
    ctx.focusEdges = 0;
    ctx.focusRelated = 0;
    const st = useWV.getState();
    if (!st.selected) return;
    const star = st.starByLemma[st.selected];
    if (!star) return;
    if (!ctx.sky.posById.has(star.id)) return;
    const groups = new Map<string, { style: EdgeStyle; pairs: [number, number][] }>();
    for (const item of focusedRelations()) {
      if (!ctx.sky.posById.has(item.star.id)) continue;
      // 线宽压到 1.2-1.5 像素：星是主角，线只是提示
      const w = item.rel.weight >= 0.8 ? 1.5 : item.rel.weight >= 0.5 ? 1.35 : 1.2;
      const style = styleFor(item.layer, item.rel.kind, false, w);
      const key = style.color + '|' + style.opacity + '|' + style.arc + '|' + style.width;
      let g = groups.get(key);
      if (!g) {
        g = { style, pairs: [] };
        groups.set(key, g);
      }
      g.pairs.push([star.id, item.star.id]);
      ctx.focusEdges += 1;
    }
    for (const g of groups.values()) {
      const pts = focusBucketPoints(g);
      if (pts.length < 6) continue;
      const seg = makeThickLines(Array.from(pts), g.style.color, g.style.opacity, g.style.width);
      ctx.focusGroup.add(seg);
      ctx.focusLines.push({ seg, style: g.style, pairs: g.pairs });
    }
    syncFocusLineWidth();
    updateLineResolution();
  }

  function project(p: THREE.Vector3, out: { x: number; y: number; z: number }): boolean {
    const ctx = ctxRef.current;
    if (!ctx) return false;
    const v = tmpProj.copy(p).project(ctx.camera);
    if (v.z < -1 || v.z > 1) return false;
    out.x = (v.x * 0.5 + 0.5) * ctx.widthCss;
    out.y = (-v.y * 0.5 + 0.5) * ctx.heightCss;
    out.z = v.z;
    return true;
  }

  function pickLabel(px: number, py: number): LabelItem | null {
    const ctx = ctxRef.current;
    if (!ctx) return null;
    syncCamera();
    const s = { x: 0, y: 0, z: 0 };
    let best: LabelItem | null = null;
    for (const it of ctx.labels) {
      if (!it.sprite.visible) continue; // 被避让隐藏的标签不参与点击
      if (!project(it.pos, s)) continue;
      const top = it.centerY === 0 ? s.y - it.h : s.y - it.h / 2;
      const pad = 4;
      if (px >= s.x - it.w / 2 - pad && px <= s.x + it.w / 2 + pad && py >= top - pad && py <= top + it.h + pad) {
        if (!best || it.forced) best = it;
      }
    }
    return best;
  }

  function pickStar(px: number, py: number): Star | null {
    const ctx = ctxRef.current;
    if (!ctx) return null;
    syncCamera();
    const st = useWV.getState();
    const s = { x: 0, y: 0, z: 0 };
    let best: Star | null = null;
    let bestD = 14;
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    const relPick = new Set(focusedRelations().map((r) => r.star.id));
    for (const star of st.stars) {
      const isRel = relPick.has(star.id);
      if (!isRel && st.level >= 1 && st.level < wordsLevel && star.major !== st.majorKey) continue;
      if (!isRel && st.level >= wordsLevel && depth2 && star.minor !== st.minorKey) continue;
      if (!isRel && st.level >= wordsLevel && !depth2 && star.group !== st.majorKey) continue;
      const p = ctx.sky.posById.get(star.id);
      if (!p) continue;
      if (!project(p, s)) continue;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < bestD) {
        bestD = d;
        best = star;
      }
    }
    return best;
  }

  function handleTap(x: number, y: number): void {
    const st = useWV.getState();
    const lab = pickLabel(x, y);
    if (lab) {
      if (lab.kind === 'major') {
        if (st.level === 0) st.enterMajor(lab.key);
        else st.goTo(1);
      } else if (lab.kind === 'minor') st.enterMinor(lab.key);
      else st.select(lab.key, false);
      return;
    }
    const star = pickStar(x, y);
    if (!star) {
      if (st.selected) st.select(null);
      else st.goUp();
      return;
    }
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel = depth2 ? 2 : 1;
    if (st.level === 0) st.enterMajor(depth2 ? star.major : star.group);
    else if (st.level < wordsLevel) st.enterMinor(star.minor);
    else st.select(star.lemma, false);
  }

  // Esc 返回上一级
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // Alt+← 回退上一个查看的词（Esc 仍然只用于返回上一级）
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        useWV.getState().backWord();
        return;
      }
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      useWV.getState().goUp();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const loadingSky = useWV((s) => s.loadingSky);
  const skyError = useWV((s) => s.skyError);

  return (
    <div className="sky-view" ref={mountRef}>
      <div className="sky-hud" ref={hudRef}>
        {loadingSky ? '正在读取星空…' : ''}
      </div>
      <div className="sky-help">
        分级：星团 → 子类 → 单词 → 词条。点标签或星团逐级进入，Esc / 点空白返回上一级。
        <br />
        选中单词后，与它有关的词会按当前星相的关系层高亮并连线（青=语义 / 紫=词根 / 橙=情景）。
        <br />
        拖拽旋转 · 滚轮缩放 · 顶部「星相」切换整张星空的相位。
      </div>
      {glError ? (
        <div className="sky-empty">
          <div className="sky-empty-title">当前环境不支持 WebGL</div>
          <div className="sky-empty-sub">{glError}</div>
          <div className="sky-empty-sub">星空需要 WebGL；请开启浏览器硬件加速后刷新。其余功能（复习 / 统计 / 搜索）仍可通过顶栏使用。</div>
        </div>
      ) : null}
      {!glError && skyError ? (
        <div className="sky-empty">
          <div className="sky-empty-title">暂无星空数据</div>
          <div className="sky-empty-sub">{skyError}</div>
          <div className="sky-empty-sub">请先启动后端（默认 http://127.0.0.1:8787）并生成数据管线；接口恢复后点右上角「重连」。</div>
        </div>
      ) : null}
    </div>
  );
}
