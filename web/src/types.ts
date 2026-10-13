// 词穹 WordVault —— 后端接口数据模型
// 注意：所有字段名严格对应 server/src/index.js 中实际返回的 JSON，不做任何前端臆造。

export type ClusterKind = 'family' | 'other' | 'none';

export interface ClusterInfo {
  key: string;
  zh: string;
  count: number;
  center: [number, number, number];
  /** family=命名家族；other=有归类但家族太小；none=该维度下没有归类（后两者是兜底星云） */
  kind?: ClusterKind;
}

export interface LayoutInfo {
  key: string;
  zh: string;
  desc: string;
  depth: 1 | 2;
  edgesLayer: 'semantic' | 'morphology' | 'scenario';
  clusterCount: number;
  wordCount: number;
  clusters: ClusterInfo[];
}

export interface LayoutMeta {
  key: string;
  zh: string;
  desc: string;
  depth: 1 | 2;
  edgesLayer: 'semantic' | 'morphology' | 'scenario';
}

export interface Star {
  id: number;
  lemma: string;
  x: number;
  y: number;
  z: number;
  /** 当前星相下的星团（情景布局 = 大区 key） */
  group: string;
  groupZh: string;
  groupKind?: ClusterKind;
  major: string;
  minor: string;
  frq: number;
  lit: 0 | 1;
  satellite: 0 | 1;
  strength: number;
  level: number;
  due: string | null;
  translation: string;
}

export interface Minor {
  key: string;
  zh: string;
  center: [number, number, number];
  count: number;
}

export interface Major {
  key: string;
  zh: string;
  center: [number, number, number];
  minors: Minor[];
}

export interface SkyData {
  layout: string;
  meta: LayoutMeta;
  clusters: ClusterInfo[];
  stars: Star[];
  majors: Major[];
  litCount: number;
}

export interface Health {
  ok: boolean;
  words: number;
  lit: number;
  builtAt: string;
}

export interface WordRow {
  id: number;
  lemma: string;
  phonetic: string | null;
  definition: string | null;
  translation: string | null;
  pos: string | null;
  collins: number | null;
  oxford: number | null;
  tag: string | null;
  bnc: number | null;
  frq: number | null;
  exchange: string | null;
  detail: string | null;
  audio: string | null;
  in_cet6: number | null;
  lit: number | null;
  exam_freq: number | null;
  is_satellite: number | null;
  scenario_major: string | null;
  scenario_minor: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  prefix: string | null;
  root: string | null;
  suffix: string | null;
  gen_syntax: string | null;
  gen_register: string | null;
  gen_concept: string | null;
}

export interface Sense {
  id: number;
  word_id: number;
  ordinal: number;
  pos: string | null;
  translation: string | null;
  definition: string | null;
}

export interface Phrase {
  id: number;
  word_id: number;
  phrase: string;
  translation: string | null;
  source: string | null;
}

export interface Example {
  id: number;
  word_id: number;
  en: string;
  zh: string | null;
  source: string | null;
  source_ref: string | null;
  is_machine: number | null;
}

export type RelLayer = 'semantic' | 'morphology' | 'scenario';

// GET /api/graph 返回的全图边表（a/b 是 words.id，与 /api/sky 的 star.id 同一套）
export interface GraphEdge {
  a: number;
  b: number;
  layer: RelLayer;
  kind: string;
  weight: number;
  note: string | null;
}

export interface GraphData {
  count: number;
  byLayer: Record<string, number>;
  edges: GraphEdge[];
}

export interface Rel {
  id: number;
  lemma: string;
  translation: string;
  kind: string;
  weight: number;
  note: string | null;
  strength: number;
  level: number;
  lit: number;
}

export interface ReviewState {
  word_id: number;
  level: number;
  streak: number;
  due_at: string | null;
  last_review_at: string | null;
  total_reviews: number;
  total_correct: number;
  strength: number;
  pre_known: number;
  mastering: number;
}

export interface ErrorStat {
  error_type: string;
  cnt: number;
}

export interface WordDetail {
  word: WordRow;
  senses: Sense[];
  phrases: Phrase[];
  examples: Example[];
  relations: Record<RelLayer, Rel[]>;
  review: ReviewState | null;
  errors: ErrorStat[];
}

export interface SearchResult {
  id: number;
  lemma: string;
  translation: string;
  scenario_major: string;
  scenario_minor: string;
  lit: number;
  frq: number;
  strength: number | null;
  level: number | null;
  rank: number;
}

export interface Stats {
  total: number;
  touched: number;
  mastering: number;
  due: number;
  reviews: number;
  correct: number;
  accuracy: number;
  byError: { error_type: string; c: number }[];
  byMajor: { m: string; n: number; touched: number; avg_strength: number }[];
}

export interface AssessmentQuestion {
  word_id: number;
  lemma: string;
  item_type: string;
  prompt: string;
  options: string[];
  answer: string;
}

export interface AssessmentData {
  questions: AssessmentQuestion[];
  count: number;
}

export type ItemType =
  | 'meaning_en2zh'
  | 'meaning_zh2en'
  | 'spelling'
  | 'listening'
  | 'collocation'
  | 'context';

export interface QuizItem {
  item_type: ItemType | string;
  prompt: string;
  options: string[];
  answer: string;
  source: string | null;
  source_ref: string | null;
}

export interface QueueWord {
  id: number;
  lemma: string;
  phonetic: string | null;
  translation: string | null;
  scenario_major: string | null;
  scenario_minor: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  strength: number;
  level: number;
  examples: Example[];
  items: QuizItem[];
}

export interface ReviewQueue {
  dueTotal: number;
  batchSize: number;
  words: QueueWord[];
}

export interface ReviewResult {
  ok: boolean;
  level: number;
  levelBefore: number;
  streak: number;
  strength: number;
  due_at: string;
  errorType: string;
}
