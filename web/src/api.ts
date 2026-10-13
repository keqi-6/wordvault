// 词穹 WordVault —— 接口封装。失败一律抛错，由调用方渲染「后端未启动」等提示，绝不返回假数据。
import type {
  AssessmentData, GraphData, Health, LayoutInfo, ReviewQueue, ReviewResult, SearchResult, SkyData, Stats,
  WordDetail,
} from './types';

export const API_BASE = '/api';

export class BackendDownError extends Error {
  constructor(message = '无法连接到后端（http://127.0.0.1:8787）') {
    super(message);
    this.name = 'BackendDownError';
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const TIMEOUT_MS = 20000;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    const headers: Record<string, string> = { ...(init && init.headers ? (init.headers as Record<string, string>) : {}) };
    if (init && init.body) headers['Content-Type'] = 'application/json';
    res = await fetch(API_BASE + path, { ...init, headers, signal: ctrl.signal });
  } catch (err) {
    window.clearTimeout(timer);
    throw new BackendDownError();
  }
  window.clearTimeout(timer);
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j && j.error) msg = j.error;
    } catch {
      /* 非 JSON 错误体，沿用状态码文本 */
    }
    throw new HttpError(res.status, msg);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new HttpError(res.status, '接口返回的不是 JSON（可能被开发服务器的 SPA 回退吃掉了 /api 请求）');
  }
}

export const api = {
  health: () => req<Health>('/health'),
  sky: (layout?: string) => req<SkyData>('/sky' + (layout ? '?layout=' + encodeURIComponent(layout) : '')),
  layouts: () => req<{ layouts: LayoutInfo[] }>('/layouts'),
  word: (lemma: string) => req<WordDetail>('/word/' + encodeURIComponent(lemma)),
  // 全图边表；major 可选，用于按当前选中大区收窄
  graph: (major?: string | null) =>
    req<GraphData>('/graph' + (major ? '?major=' + encodeURIComponent(major) : '')),
  search: (q: string, limit = 30) =>
    req<{ results: SearchResult[] }>('/search?q=' + encodeURIComponent(q) + '&limit=' + limit),
  stats: () => req<Stats>('/stats'),
  assessment: (count = 60) => req<AssessmentData>('/assessment?count=' + count),
  submitAssessment: (answers: { word_id: number; correct: boolean }[]) =>
    req<{ ok: boolean; total: number; preKnown: number }>('/assessment/submit', {
      method: 'POST',
      body: JSON.stringify({ answers }),
    }),
  reviewQueue: (size = 20) => req<ReviewQueue>('/review/queue?size=' + size),
  submitReview: (body: {
    word_id: number;
    item_type: string;
    correct: boolean;
    elapsed_ms: number;
    hinted: boolean;
  }) => req<ReviewResult>('/review/submit', { method: 'POST', body: JSON.stringify(body) }),
  exportCsvUrl: () => API_BASE + '/export/csv',
};

export function errText(err: unknown): string {
  // BackendDownError 用自己的文案（更具体）；外层会再加「后端未启动」标题
  if (err instanceof BackendDownError) return err.message;
  if (err instanceof HttpError) return '接口错误 ' + err.status + '：' + err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
