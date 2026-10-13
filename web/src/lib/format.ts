// 展示用的小工具
// 释义里既有真实换行，也有字面量 "\n"（ECDICT 转储留下的），两种都要当换行处理
export const LINE_BREAK_RE = /\r?\n|\\n/;

export function firstLine(s: string | null | undefined): string {
  if (!s) return '';
  const i = s.search(LINE_BREAK_RE);
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

export function fmtPct(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '—';
  return (x * 100).toFixed(digits) + '%';
}

export function fmtDue(due: string | null | undefined): string {
  if (!due) return '未安排';
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return String(due);
  const diff = d.getTime() - Date.now();
  const day = Math.round(diff / 86400000);
  const stamp = d.toLocaleString('zh-CN', { hour12: false });
  if (diff <= 0) return '已到期 · ' + stamp;
  if (day <= 0) return '今天 ' + d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  return day + ' 天后 · ' + stamp;
}

export const ERROR_TYPE_ZH: Record<string, string> = {
  meaning: '词义',
  spelling: '拼写',
  listening: '听音',
  collocation: '搭配',
  context: '语境',
  synonym: '近义辨析',
};

export function errZh(t: string): string {
  return ERROR_TYPE_ZH[t] || t;
}

export const ITEM_TYPE_ZH: Record<string, string> = {
  meaning_en2zh: '英译中选义',
  meaning_zh2en: '中译英选词',
  spelling: '看义拼写',
  listening: '听音选词',
  collocation: '搭配填空',
  context: '真题语境',
};

export function itemZh(t: string): string {
  return ITEM_TYPE_ZH[t] || t;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
