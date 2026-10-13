// 间隔规则表：阶梯 1/2/4/7/15/30 天，答对升一级，答错退一级。
export const LEVEL_DAYS = [0, 1, 2, 4, 7, 15, 30];
export const MAX_LEVEL = 6;

// 题型与错误类型的对应
export const ITEM_ERROR = {
  meaning_en2zh: "meaning",
  meaning_zh2en: "meaning",
  context: "meaning",
  spelling: "spelling",
  listening: "listening",
  collocation: "collocation",
  register: "register",
};

// 每种错误类型对应的补练题型
export const ERROR_REMEDY = {
  meaning: ["meaning_en2zh", "context", "meaning_zh2en"],
  spelling: ["spelling"],
  listening: ["listening"],
  collocation: ["collocation"],
  register: ["collocation"],
};

export function nextLevel(level, correct) {
  const lv = Number(level) || 0;
  return correct ? Math.min(lv + 1, MAX_LEVEL) : Math.max(lv - 1, 0);
}

// 统一成 UTC 的 YYYY-MM-DDTHH:MM:SSZ（不带毫秒），否则和数据库里的字符串比较会错位
export function isoUtc(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function dueAt(level, from = new Date()) {
  const days = LEVEL_DAYS[Math.max(0, Math.min(MAX_LEVEL, Number(level) || 0))];
  return isoUtc(new Date(from.getTime() + days * 86400000));
}

// 记忆强度 = 星光亮度（0..1）
export function strengthOf(level, streak, correct) {
  const lv = Math.max(0, Math.min(MAX_LEVEL, Number(level) || 0));
  const st = Math.max(0, Math.min(3, Number(streak) || 0));
  let s = (lv / MAX_LEVEL) * 0.75 + (st / 3) * 0.25;
  if (correct === false) s = Math.max(0.05, s * 0.6);
  return Math.max(0, Math.min(1, Number(s.toFixed(4))));
}

// 根据错误历史为某个词挑选本轮的 2-3 道题
export function pickItemTypes(weakest, base = ["meaning_en2zh", "spelling", "collocation"]) {
  const types = [...base];
  for (const err of weakest) {
    const rem = ERROR_REMEDY[err] || [];
    for (const r of rem) {
      if (!types.includes(r)) types.push(r);
    }
  }
  return types.slice(0, 3);
}
