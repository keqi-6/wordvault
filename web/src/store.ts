// 词穹 WordVault —— 全局状态（zustand）
import { create } from 'zustand';
import { api, BackendDownError, errText } from './api';
import type { ClusterInfo, LayoutInfo, LayoutMeta, Major, Star, Stats, WordDetail } from './types';
import type { DisplayMode } from './three/starfield';

export type View = 'sky' | 'review' | 'stats' | 'assessment';
export type LayerKey = 'semantic' | 'morphology' | 'scenario';
export type Layers = Record<LayerKey, boolean>;
/** 0 全景 / 1 大区 / 2 子类（可见单词星） */
export type Level = 0 | 1 | 2;

export interface CamState {
  theta: number;
  phi: number;
  radius: number;
  target: [number, number, number];
}

export interface FocusRequest {
  x: number;
  y: number;
  z: number;
  radius: number | null;
  nonce: number;
  /** 带回退历史时用：直接把相机放回这个状态（平滑过渡） */
  cam?: CamState;
}

/** 浏览历史的一项：词 + 星相 + 层级 + 相机 + 面板滚动位置，回退时整份还原 */
export interface HistEntry {
  lemma: string;
  layoutKey: string;
  level: Level;
  majorKey: string | null;
  minorKey: string | null;
  cam: CamState | null;
  scroll: number;
}

/**
 * 不入 store 的运行时引用（写它不会触发 React 渲染）：
 * SkyView 每帧写当前相机，WordPanel 注册滚动读写。
 */
export const runtimeRefs: {
  cam: CamState | null;
  getPanelScroll: () => number;
  setPanelScroll: (top: number) => void;
} = {
  cam: null,
  getPanelScroll: () => 0,
  setPanelScroll: () => undefined,
};

const LAYER_KEY = 'wv.layers';

function readLayers(): Layers {
  try {
    const raw = localStorage.getItem(LAYER_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Layers>;
      return { semantic: !!j.semantic, morphology: !!j.morphology, scenario: !!j.scenario };
    }
  } catch {
    /* 忽略损坏的本地设置 */
  }
  return { semantic: true, morphology: true, scenario: true };
}

// 默认「全亮」：星图一开始就应该像拼图封面一样是完整的，不体现谁背过谁没背
const MODE_KEY = 'wv.displayMode';

function readMode(): DisplayMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (raw === 'strength' || raw === 'bright') return raw;
  } catch {
    /* 忽略损坏的本地设置 */
  }
  return 'bright';
}

interface WVState {
  backend: 'unknown' | 'up' | 'down';
  backendMsg: string;
  builtAt: string;
  wordCount: number;

  /** 星相（布局） */
  layouts: LayoutInfo[];
  layoutKey: string;
  layoutMeta: LayoutMeta | null;
  clusters: ClusterInfo[];

  stars: Star[];
  majors: Major[];
  litCount: number;
  starById: Record<number, Star>;
  starByLemma: Record<string, Star>;
  starsVersion: number;
  loadingSky: boolean;
  skyError: string;

  stats: Stats | null;
  statsError: string;
  dueCount: number;

  /** 分级状态 */
  level: Level;
  majorKey: string | null;
  minorKey: string | null;
  selected: string | null;
  /** 鼠标悬停到的单词（面包屑小卡用；与选中的 selected 区分） */
  hoverLemma: string | null;
  /** 浏览历史（回退用） */
  history: HistEntry[];
  /** 当前选中的词不在 /api/sky 星表里（不在星空布局中） */
  layoutMissing: boolean;
  /** 回退时要还原的面板滚动位置，由 WordPanel 消费后清空 */
  scrollRestore: number | null;
  layers: Layers;
  /** 显示模式：bright=全亮（默认，所有人一样亮） / strength=记忆强度 */
  displayMode: DisplayMode;

  details: Record<string, WordDetail | null>;
  detailLoading: string | null;
  detailError: string;

  focus: FocusRequest | null;
  view: View;
  toast: string | null;

  init: () => Promise<void>;
  reloadAll: () => Promise<void>;
  loadSky: (layout?: string) => Promise<void>;
  setLayout: (key: string) => Promise<void>;
  /** 当前星相下"能看到单词"的层级（depth=2 是 2，depth=1 是 1） */
  wordLevel: () => Level;
  setView: (v: View) => void;
  setToast: (t: string | null) => void;
  select: (lemma: string | null, fly?: boolean) => void;
  setHover: (lemma: string | null) => void;
  /** 统一定位入口：解析目标词的 major/minor，切层级 + 搬相机 + 金色高亮 + 可选入栈 */
  visitWord: (lemma: string, opts?: { fly?: boolean; push?: boolean }) => void;
  pushHistory: () => void;
  backWord: () => void;
  clearScrollRestore: () => void;
  loadDetail: (lemma: string) => Promise<void>;
  patchStrength: (id: number, strength: number, level: number) => void;
  setLayer: (k: LayerKey, v: boolean) => void;
  setDisplayMode: (m: DisplayMode) => void;
  flyToStar: (star: Star, radius?: number | null) => void;
  flyToPoint: (x: number, y: number, z: number, radius?: number | null) => void;
  loadStats: () => Promise<void>;
  // 分级导航
  enterMajor: (key: string) => void;
  enterMinor: (key: string) => void;
  goUp: () => void;
  goTo: (level: Level) => void;
  openWord: (lemma: string) => void;
}

export const useWV = create<WVState>((set, get) => ({
  backend: 'unknown',
  backendMsg: '',
  builtAt: '',
  wordCount: 0,

  layouts: [],
  layoutKey: 'scenario',
  layoutMeta: null,
  clusters: [],
  stars: [],
  majors: [],
  litCount: 0,
  starById: {},
  starByLemma: {},
  starsVersion: 0,
  loadingSky: false,
  skyError: '',

  stats: null,
  statsError: '',
  dueCount: 0,

  level: 0,
  majorKey: null,
  minorKey: null,
  selected: null,
  hoverLemma: null,
  history: [],
  layoutMissing: false,
  scrollRestore: null,
  layers: readLayers(),
  displayMode: readMode(),

  details: {},
  detailLoading: null,
  detailError: '',

  focus: null,
  view: 'sky',
  toast: null,

  init: async () => {
    set({ loadingSky: true, skyError: '' });
    const [healthRes, layoutsRes] = await Promise.allSettled([api.health(), api.layouts()]);
    if (healthRes.status === 'fulfilled') {
      set({ backend: 'up', backendMsg: '', wordCount: healthRes.value.words, builtAt: healthRes.value.builtAt || '' });
    } else {
      set({ backend: 'down', backendMsg: errText(healthRes.reason), loadingSky: false });
    }
    if (layoutsRes.status === 'fulfilled') {
      const list = layoutsRes.value.layouts || [];
      const cur = get().layoutKey;
      set({ layouts: list, layoutKey: list.some((l) => l.key === cur) ? cur : (list[0] ? list[0].key : cur) });
    }
    await get().loadSky(get().layoutKey);
    await get().loadStats();
  },

  wordLevel: () => ((get().layoutMeta?.depth ?? 2) === 2 ? 2 : 1),

  /** 拉取某一套星相（布局）的星图；不传则用当前星相 */
  loadSky: async (layout) => {
    const key = layout || get().layoutKey;
    set({ loadingSky: true, skyError: '' });
    try {
      const sky = await api.sky(key);
      const byId: Record<number, Star> = {};
      const byLemma: Record<string, Star> = {};
      for (const s of sky.stars) {
        byId[s.id] = s;
        byLemma[s.lemma] = s;
      }
      set({
        layoutKey: sky.layout || key,
        layoutMeta: sky.meta || null,
        clusters: sky.clusters || [],
        stars: sky.stars,
        majors: sky.majors || [],
        litCount: sky.litCount,
        starById: byId,
        starByLemma: byLemma,
        starsVersion: get().starsVersion + 1,
        loadingSky: false,
        skyError: '',
        backend: 'up',
      });
    } catch (err) {
      const e = errText(err);
      set({ loadingSky: false, skyError: '后端未启动 · ' + e, backend: 'down', backendMsg: e });
    }
  },

  /** 切换星相：整张星图重排，回到该星相的全景，清空选中 */
  setLayout: async (key) => {
    const st = get();
    if (st.layoutKey === key && st.stars.length) return;
    set({
      layoutKey: key,
      level: 0,
      majorKey: null,
      minorKey: null,
      selected: null,
      layoutMissing: false,
      history: [],
    });
    await get().loadSky(key);
    get().setToast('已切换到星相「' + (get().layoutMeta?.zh || key) + '」');
  },

  reloadAll: async () => {
    await get().init();
  },

  setView: (v) => set({ view: v }),
  setToast: (t) => set({ toast: t }),

  select: (lemma, fly) => {
    if (!lemma) {
      set({ selected: null });
      return;
    }
    // 任何入口选中一个词，都走同一条「定位到词」的路径（切层级 + 搬相机 + 入栈）
    get().visitWord(lemma, { fly: fly !== false, push: true });
  },

  visitWord: (lemma, opts) => {
    const st = get();
    const fly = opts?.fly !== false;
    const push = opts?.push !== false;
    if (!lemma) return;
    if (push && st.selected && st.selected !== lemma) get().pushHistory();
    const star = st.starByLemma[lemma];
    void get().loadDetail(lemma);
    if (!star) {
      // 不在星空布局里：只换面板，不动层级与相机，并给出可见提示
      set({ selected: lemma, layoutMissing: true });
      get().setToast('「' + lemma + '」未纳入星空布局，仅显示词条');
      return;
    }
    const depth2 = (st.layoutMeta?.depth ?? 2) === 2;
    const wordsLevel: Level = depth2 ? 2 : 1;
    const majorKey = depth2 ? star.major : star.group;
    const minorKey = depth2 ? star.minor : '';
    const scopeChanged = st.level !== wordsLevel || st.majorKey !== majorKey || st.minorKey !== minorKey;
    set({
      selected: lemma,
      layoutMissing: false,
      level: wordsLevel,
      majorKey,
      minorKey,
    });
    // 换分支时必须搬相机；同分支内的点选保持当前视角（半径按当前层级算，保证目标在视野里）
    if (fly || scopeChanged) get().flyToStar(star, null);
  },

  pushHistory: () => {
    const st = get();
    if (!st.selected) return;
    const cam = runtimeRefs.cam;
    const entry: HistEntry = {
      lemma: st.selected,
      layoutKey: st.layoutKey,
      level: st.level,
      majorKey: st.majorKey,
      minorKey: st.minorKey,
      cam: cam ? { theta: cam.theta, phi: cam.phi, radius: cam.radius, target: [...cam.target] as [number, number, number] } : null,
      scroll: runtimeRefs.getPanelScroll(),
    };
    const history = st.history.concat([entry]).slice(-50);
    set({ history });
  },

  backWord: () => {
    const st = get();
    if (!st.history.length) return;
    const h = st.history[st.history.length - 1];
    set({ history: st.history.slice(0, -1) });
    void (async () => {
      // 跨星相回退：先把那套星图拉回来（星图不同 → 场景坐标不同）
      if (h.layoutKey && h.layoutKey !== get().layoutKey) {
        await get().loadSky(h.layoutKey);
      }
      const star = get().starByLemma[h.lemma];
      set({
        selected: h.lemma,
        level: h.level,
        majorKey: h.majorKey,
        minorKey: h.minorKey,
        layoutMissing: !star,
        scrollRestore: h.scroll,
      });
      void get().loadDetail(h.lemma);
      // 相机整份还原（平滑过渡到最后的位置）
      if (h.cam) {
        set({
          focus: {
            x: h.cam.target[0],
            y: h.cam.target[1],
            z: h.cam.target[2],
            radius: h.cam.radius,
            nonce: Date.now() + Math.random(),
            cam: h.cam,
          },
        });
      } else if (star) {
        get().flyToStar(star, null);
      }
    })();
  },

  clearScrollRestore: () => set({ scrollRestore: null }),

  setHover: (lemma) => {
    if (get().hoverLemma !== lemma) set({ hoverLemma: lemma });
  },

  loadDetail: async (lemma) => {
    const cached = get().details[lemma];
    if (cached) return;
    set({ detailLoading: lemma, detailError: '' });
    try {
      const d = await api.word(lemma);
      set({
        details: { ...get().details, [lemma]: d },
        detailLoading: get().detailLoading === lemma ? null : get().detailLoading,
      });
    } catch (err) {
      if (get().detailLoading === lemma) set({ detailLoading: null });
      set({
        details: { ...get().details, [lemma]: null },
        detailError: errText(err),
        backend: err instanceof BackendDownError ? 'down' : get().backend,
      });
    }
  },

  patchStrength: (id, strength, level) => {
    const byId = get().starById;
    const star = byId[id];
    if (!star) return;
    const next: Star = { ...star, strength, level };
    const stars = get().stars.map((s) => (s.id === id ? next : s));
    set({
      stars,
      starById: { ...byId, [id]: next },
      starByLemma: { ...get().starByLemma, [next.lemma]: next },
      starsVersion: get().starsVersion + 1,
    });
  },

  setLayer: (k, v) => {
    const layers: Layers = { ...get().layers, [k]: v };
    set({ layers });
    try {
      localStorage.setItem(LAYER_KEY, JSON.stringify(layers));
    } catch {
      /* 存储不可用时忽略 */
    }
  },

  setDisplayMode: (m) => {
    set({ displayMode: m });
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* 存储不可用时忽略 */
    }
  },

  flyToStar: (star, radius) => {
    set({ focus: { x: star.x, y: star.y, z: star.z, radius: radius ?? null, nonce: Date.now() + Math.random() } });
  },

  flyToPoint: (x, y, z, radius) => {
    set({ focus: { x, y, z, radius: radius ?? null, nonce: Date.now() + Math.random() } });
  },

  loadStats: async () => {
    try {
      const s = await api.stats();
      set({ stats: s, statsError: '', dueCount: s.due, backend: 'up' });
    } catch (err) {
      set({ statsError: errText(err) });
      if (err instanceof BackendDownError) set({ backend: 'down', backendMsg: errText(err) });
    }
  },

  // ---------------------------------------------------------------- 分级导航（depth=1 只有两级）
  enterMajor: (key) => {
    // depth=1 的星相里，点星团直接进入"能看单词"的那一级
    const level: Level = (get().layoutMeta?.depth ?? 2) === 2 ? 1 : 1;
    set({ level, majorKey: key, minorKey: null, selected: null });
  },

  enterMinor: (key) => {
    set({ level: 2, minorKey: key, selected: null });
  },

  goUp: () => {
    const st = get();
    if (st.selected) {
      set({ selected: null });
      return;
    }
    const wordsLevel = get().wordLevel();
    if (st.level >= wordsLevel) {
      if (wordsLevel === 2) set({ level: 1, minorKey: null });
      else set({ level: 0, majorKey: null, minorKey: null });
    } else if (st.level === 1) {
      set({ level: 0, majorKey: null, minorKey: null });
    }
  },

  goTo: (level) => {
    const wordsLevel = get().wordLevel();
    const lv = (level > wordsLevel ? wordsLevel : level) as Level;
    if (lv === 0) set({ level: 0, majorKey: null, minorKey: null, selected: null });
    else if (lv === 1) set({ level: 1, minorKey: null, selected: null });
  },

  openWord: (lemma: string) => {
    // 搜索结果跳转 = 同一套定位逻辑（major/minor 从星表解析，比搜索结果的字段更可靠）
    get().visitWord(lemma, { fly: true, push: true });
  },
}));