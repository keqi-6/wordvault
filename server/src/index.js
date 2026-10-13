// 词穹 WordVault —— 本地后端
import express from 'express';
// Node 22.5+ 自带 sqlite，省掉 better-sqlite3 的原生编译依赖（本机 Node 24 上 gyp 编译失败）
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LEVEL_DAYS, MAX_LEVEL, ITEM_ERROR,
  nextLevel, dueAt, strengthOf, pickItemTypes, isoUtc,
} from './srs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.WORDVAULT_DB || path.join(ROOT, 'data', 'wordvault.db');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

if (!fs.existsSync(DB_PATH)) {
  console.error('[wordvault] 找不到数据库: ' + DB_PATH);
  console.error('           请先运行 scripts\\run_pipeline.ps1 生成数据。');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// node:sqlite 没有 better-sqlite3 的 transaction() 包装，自己实现一个
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

const firstLine = (s) => String(s || '').split('\n')[0];

const q = {
  word: db.prepare('SELECT * FROM words WHERE lemma = ?'),
  senses: db.prepare('SELECT * FROM senses WHERE word_id = ? ORDER BY ordinal'),
  phrases: db.prepare('SELECT * FROM phrases WHERE word_id = ? LIMIT 40'),
  examples: db.prepare('SELECT * FROM examples WHERE word_id = ? LIMIT 6'),
  rel: db.prepare('SELECT r.kind, r.layer, r.weight, r.note, w.id, w.lemma, w.translation, ' +
                  'w.scenario_major, w.scenario_minor, rs.strength, rs.level, w.lit ' +
                  'FROM relations r JOIN words w ON w.id = r.dst_id ' +
                  'LEFT JOIN review_states rs ON rs.word_id = w.id ' +
                  'WHERE r.src_id = ? ORDER BY r.layer, r.weight DESC LIMIT 200'),
  state: db.prepare('SELECT * FROM review_states WHERE word_id = ?'),
  errors: db.prepare('SELECT error_type, cnt FROM error_stats WHERE word_id = ? ORDER BY cnt DESC'),
  zhGloss: db.prepare('SELECT zh, src FROM zh_gloss WHERE word_id = ? LIMIT 12'),
  skyAll: db.prepare('SELECT w.id, w.lemma, w.x, w.y, w.z, w.scenario_major, w.scenario_minor, ' +
                     'w.frq, w.lit, w.is_satellite, w.translation, ' +
                     'rs.strength, rs.level, rs.due_at ' +
                     'FROM words w LEFT JOIN review_states rs ON rs.word_id = w.id'),
};

// ---------------------------------------------------------------- 基础
app.get('/api/health', (req, res) => {
  const words = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  const lit = db.prepare('SELECT COUNT(*) c FROM words WHERE lit = 1').get().c;
  const builtAt = db.prepare("SELECT value FROM settings WHERE key='built_at'").get();
  res.json({ ok: true, words, lit, builtAt: builtAt ? builtAt.value : '', db: DB_PATH });
});

app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  res.json({ levelDays: LEVEL_DAYS, settings: Object.fromEntries(rows.map(r => [r.key, r.value])) });
});

// ---------------------------------------------------------------- 星空
// 所有星相（布局）：情景分区 / 词根家族 / 前缀家族 / 后缀家族 / 语义场
app.get('/api/layouts', (req, res) => {
  const metas = db.prepare('SELECT * FROM layout_meta').all();
  const out = metas.map(m => ({
    key: m.layout, zh: m.zh, desc: m.descr, depth: m.depth, edgesLayer: m.edges_layer,
    clusterCount: m.cluster_count, wordCount: m.word_count,
    clusters: db.prepare('SELECT cluster, zh, cnt, cx, cy, cz, kind FROM layout_clusters WHERE layout = ? ORDER BY cnt DESC')
      .all(m.layout).map(c => ({ key: c.cluster, zh: c.zh, count: c.cnt, kind: c.kind, center: [c.cx, c.cy, c.cz] })),
  }));
  res.json({ layouts: out });
});

// stars 支持按星相取不同坐标：/api/sky?layout=root
app.get('/api/sky', (req, res) => {
  const layout = String(req.query.layout || 'scenario');
  const major = req.query.major, minor = req.query.minor, litOnly = req.query.litOnly;
  const metaRow = db.prepare('SELECT * FROM layout_meta WHERE layout = ?').get(layout);
  if (!metaRow) return res.status(404).json({ error: 'unknown layout: ' + layout });

  let stars;
  if (layout === 'scenario') {
    let rows = q.skyAll.all();
    if (major) rows = rows.filter(r => r.scenario_major === major);
    if (minor) rows = rows.filter(r => r.scenario_minor === minor);
    if (litOnly === '1') rows = rows.filter(r => r.lit === 1);
    stars = rows.map(r => ({
      id: r.id, lemma: r.lemma, x: r.x, y: r.y, z: r.z,
      group: r.scenario_major, groupZh: '', major: r.scenario_major, minor: r.scenario_minor,
      frq: r.frq, lit: r.lit, satellite: r.is_satellite,
      strength: r.strength == null ? 0 : r.strength, level: r.level == null ? 0 : r.level,
      due: r.due_at, translation: firstLine(r.translation),
    }));
    const zhOf = {};
    for (const m of db.prepare('SELECT DISTINCT major, major_zh FROM scenarios').all()) zhOf[m.major] = m.major_zh;
    for (const s of stars) s.groupZh = zhOf[s.group] || s.group;
  } else {
    let rows = db.prepare(
      'SELECT w.id, w.lemma, l.x AS x, l.y AS y, l.z AS z, l.cluster AS cluster, l.cluster_zh AS cluster_zh, ' +
      'w.frq, w.lit, w.is_satellite, w.translation, w.scenario_major, w.scenario_minor, ' +
      'rs.strength, rs.level, rs.due_at ' +
      'FROM layouts l JOIN words w ON w.id = l.word_id ' +
      'LEFT JOIN review_states rs ON rs.word_id = w.id WHERE l.layout = ?').all(layout);
    if (major) rows = rows.filter(r => r.cluster === major);
    if (litOnly === '1') rows = rows.filter(r => r.lit === 1);
    stars = rows.map(r => ({
      id: r.id, lemma: r.lemma, x: r.x, y: r.y, z: r.z,
      group: r.cluster, groupZh: r.cluster_zh, major: r.cluster, minor: '',
      frq: r.frq, lit: r.lit, satellite: r.is_satellite,
      strength: r.strength == null ? 0 : r.strength, level: r.level == null ? 0 : r.level,
      due: r.due_at, translation: firstLine(r.translation),
    }));
  }

  const clusters = db.prepare('SELECT cluster, zh, cnt, cx, cy, cz, kind FROM layout_clusters WHERE layout = ? ORDER BY cnt DESC')
    .all(layout).map(c => ({ key: c.cluster, zh: c.zh, count: c.cnt, kind: c.kind, center: [c.cx, c.cy, c.cz] }));
  const kindOf = Object.fromEntries(clusters.map(c => [c.key, c.kind]));
  for (const s of stars) s.groupKind = kindOf[s.group] || 'family';

  const scRows = db.prepare('SELECT * FROM scenarios').all();
  const majors = {};
  for (const m of scRows) {
    if (!majors[m.major]) majors[m.major] = { key: m.major, zh: m.major_zh, center: [m.cx, m.cy, m.cz], minors: [] };
    majors[m.major].minors.push({ key: m.minor, zh: m.minor_zh, center: [m.cx, m.cy, m.cz], count: m.cnt });
  }

  res.json({
    layout,
    meta: { key: layout, zh: metaRow.zh, desc: metaRow.descr, depth: metaRow.depth, edgesLayer: metaRow.edges_layer },
    clusters,
    majors: Object.values(majors),
    stars,
    litCount: stars.filter(s => s.lit).length,
  });
});

app.get('/api/scenarios', (req, res) => {
  const rows = db.prepare('SELECT * FROM scenarios ORDER BY major, minor').all();
  const majors = {};
  for (const r of rows) {
    if (!majors[r.major]) majors[r.major] = { key: r.major, zh: r.major_zh, minors: [] };
    majors[r.major].minors.push({ key: r.minor, zh: r.minor_zh, count: r.cnt, center: [r.cx, r.cy, r.cz] });
  }
  res.json({ majors: Object.values(majors) });
});

// 全图边表：给前端「按层全量显示边」用，避免逐词请求
app.get('/api/graph', (req, res) => {
  const layer = req.query.layer;
  const major = req.query.major;
  const clauses = [];
  const params = [];
  if (layer) { clauses.push('r.layer = ?'); params.push(layer); }
  if (major) { clauses.push('ws.scenario_major = ?'); params.push(major); }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(
    'SELECT r.src_id AS a, r.dst_id AS b, r.layer, r.kind, r.weight, r.note ' +
    'FROM relations r JOIN words ws ON ws.id = r.src_id' + where).all(...params);
  const byLayer = {};
  for (const r of rows) byLayer[r.layer] = (byLayer[r.layer] || 0) + 1;
  res.json({ count: rows.length, byLayer, edges: rows });
});

// ---------------------------------------------------------------- 词条
app.get('/api/word/:lemma', (req, res) => {
  const w = q.word.get(String(req.params.lemma || '').toLowerCase());
  if (!w) return res.status(404).json({ error: 'not found' });
  const sides = { semantic: [], morphology: [], scenario: [] };
  for (const r of q.rel.all(w.id)) {
    const bucket = sides[r.layer] || (sides[r.layer] = []);
    bucket.push({
      id: r.id, lemma: r.lemma, translation: firstLine(r.translation),
      kind: r.kind, weight: r.weight, note: r.note,
      strength: r.strength == null ? 0 : r.strength, level: r.level == null ? 0 : r.level, lit: r.lit,
    });
  }
  res.json({
    word: w,
    senses: q.senses.all(w.id),
    phrases: q.phrases.all(w.id),
    examples: q.examples.all(w.id),
    relations: sides,
    review: q.state.get(w.id) || null,
    errors: q.errors.all(w.id),
    zhGloss: q.zhGloss.all(w.id),
  });
});

app.get('/api/search', (req, res) => {
  const qq = String(req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit || 30), 200);
  if (!qq) return res.json({ results: [] });
  const like = '%' + qq + '%';
  const rows = db.prepare(
    'SELECT w.id, w.lemma, w.translation, w.scenario_major, w.scenario_minor, w.lit, w.frq, ' +
    '       rs.strength, rs.level, ' +
    '       CASE WHEN w.lemma = ? THEN 0 WHEN w.lemma LIKE ? THEN 1 ELSE 2 END AS rank ' +
    '  FROM words w LEFT JOIN review_states rs ON rs.word_id = w.id ' +
    ' WHERE w.lemma LIKE ? OR w.translation LIKE ? ' +
    '    OR EXISTS (SELECT 1 FROM zh_gloss z WHERE z.word_id = w.id AND z.zh LIKE ?) ' +
    ' ORDER BY rank, CASE WHEN w.frq = 0 THEN 999999 ELSE w.frq END LIMIT ?')
    .all(qq, qq + '%', like, like, like, limit);
  res.json({ results: rows.map(r => ({ ...r, translation: firstLine(r.translation) })) });
});

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM words WHERE lit = 1').get().c;
  const touched = db.prepare('SELECT COUNT(*) c FROM review_states WHERE total_reviews > 0').get().c;
  const mastering = db.prepare('SELECT COUNT(*) c FROM review_states WHERE level >= 5').get().c;
  const nowISO = isoUtc();
  const due = db.prepare('SELECT COUNT(*) c FROM review_states s JOIN words w ON w.id = s.word_id ' +
                         'WHERE s.due_at <= ? AND w.lit = 1').get(nowISO).c;
  const reviews = db.prepare('SELECT COUNT(*) c FROM review_logs').get().c;
  const correct = db.prepare('SELECT COUNT(*) c FROM review_logs WHERE correct = 1').get().c;
  const byError = db.prepare('SELECT error_type, SUM(cnt) c FROM error_stats GROUP BY error_type ORDER BY c DESC').all();
  const byMajor = db.prepare('SELECT w.scenario_major m, COUNT(*) n, ' +
    'SUM(CASE WHEN s.total_reviews > 0 THEN 1 ELSE 0 END) touched, ' +
    'AVG(COALESCE(s.strength,0)) avg_strength ' +
    'FROM words w JOIN review_states s ON s.word_id = w.id WHERE w.lit = 1 GROUP BY w.scenario_major').all();
  res.json({ total, touched, mastering, due, reviews, correct,
             accuracy: reviews ? correct / reviews : 0, byError, byMajor });
});

// ---------------------------------------------------------------- 初始自评
const BANDS = [[1, 1000], [1001, 2000], [2001, 3000], [3001, 5000], [5001, 8000], [8001, 999999]];

// 干扰项要挑得像：同词性优先、释义长度接近、同情景优先。
// 纯随机挑会给出「学术的」对「性别」这种一眼就能排除的选项。
function distractorTranslations(wordRow, n) {
  const want = n || 3;
  const correct = firstLine(wordRow.translation);
  const len = correct.length;
  const lo = Math.max(2, Math.floor(len * 0.55));
  const hi = Math.max(lo + 2, Math.ceil(len * 1.7));
  const out = [];
  const pick = (sql, params) => {
    for (const row of db.prepare(sql).all(...params)) {
      const t = firstLine(row.translation);
      if (t && t !== correct && !out.includes(t)) out.push(t);
      if (out.length >= want) return;
    }
  };
  pick('SELECT translation FROM words WHERE id != ? AND translation != \'\' AND scenario_major = ? ' +
       'AND pos = ? AND LENGTH(translation) BETWEEN ? AND ? ' +
       'ORDER BY ABS(LENGTH(translation) - ?), RANDOM() LIMIT 12',
       [wordRow.id, wordRow.scenario_major, wordRow.pos || '', lo, hi, len]);
  pick('SELECT translation FROM words WHERE id != ? AND translation != \'\' AND scenario_major = ? ' +
       'AND LENGTH(translation) BETWEEN ? AND ? ' +
       'ORDER BY ABS(LENGTH(translation) - ?), RANDOM() LIMIT 12',
       [wordRow.id, wordRow.scenario_major, lo, hi, len]);
  pick('SELECT translation FROM words WHERE id != ? AND translation != \'\' AND pos = ? ' +
       'ORDER BY ABS(LENGTH(translation) - ?), RANDOM() LIMIT 12',
       [wordRow.id, wordRow.pos || '', len]);
  let guard = 0;
  while (out.length < want && guard++ < 12) {
    const r = db.prepare('SELECT translation FROM words WHERE id != ? AND translation != \'\' ORDER BY RANDOM() LIMIT 1').get(wordRow.id);
    if (!r) break;
    const t = firstLine(r.translation);
    if (t && t !== correct && !out.includes(t)) out.push(t);
  }
  return out.slice(0, want);
}

app.get('/api/assessment', (req, res) => {
  const count = Math.min(Number(req.query.count || 60), 200);
  const per = Math.max(1, Math.ceil(count / BANDS.length));
  const picked = [];
  const seen = new Set();
  for (const band of BANDS) {
    if (picked.length >= count) break;
    const rows = db.prepare('SELECT * FROM words WHERE in_cet6 = 1 AND translation != \'\' ' +
                            'AND (frq = 0 OR (frq >= ? AND frq <= ?)) ORDER BY RANDOM() LIMIT ?')
      .all(band[0], band[1], per * 4);
    for (const r of rows) {
      if (picked.length >= count) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push(r);
    }
  }
  let guard = 0;
  while (picked.length < count && guard++ < 12) {
    const rows = db.prepare('SELECT * FROM words WHERE in_cet6 = 1 AND translation != \'\' ORDER BY RANDOM() LIMIT ?')
      .all(count * 2);
    for (const r of rows) {
      if (picked.length >= count) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push(r);
    }
  }
  const questions = picked.map(w => {
    const correct = firstLine(w.translation);
    const opts = [correct].concat(distractorTranslations(w, 3));
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [opts[i], opts[j]] = [opts[j], opts[i]];
    }
    return { word_id: w.id, lemma: w.lemma, item_type: 'meaning_en2zh',
             prompt: w.lemma, options: opts, answer: correct };
  });
  res.json({ questions, count: questions.length });
});

app.post('/api/assessment/submit', (req, res) => {
  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  const upd = db.prepare('UPDATE review_states SET pre_known = ?, level = ?, strength = ?, ' +
                         'due_at = ?, last_review_at = ? WHERE word_id = ?');
  const nowISO = isoUtc();
  let known = 0;
  tx(() => {
    for (const a of answers) {
      const lv = a.correct ? 2 : 0;
      if (a.correct) known += 1;
      upd.run(a.correct ? 1 : 0, lv, a.correct ? 0.55 : 0.05, dueAt(lv), nowISO, a.word_id);
    }
  });
  res.json({ ok: true, total: answers.length, preKnown: known });
});

// ---------------------------------------------------------------- 复习
function itemsForWord(w, baseTypes) {
  const weak = q.errors.all(w.id).map(e => e.error_type);
  const chosen = pickItemTypes(weak, baseTypes);
  const out = [];
  for (const t of chosen) {
    const row = db.prepare('SELECT * FROM quiz_items WHERE word_id = ? AND item_type = ? LIMIT 1').get(w.id, t);
    if (row) {
      out.push({ item_type: row.item_type, prompt: row.prompt,
                 options: JSON.parse(row.options || '[]'), answer: row.answer,
                 source: row.source, source_ref: row.source_ref });
      continue;
    }
    if (t === 'meaning_en2zh' || t === 'context') {
      const correct = firstLine(w.translation);
      if (!correct) continue;
      const opts = [correct].concat(distractorTranslations(w, 3));
      for (let i = opts.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [opts[i], opts[j]] = [opts[j], opts[i]];
      }
      out.push({ item_type: 'meaning_en2zh', prompt: w.lemma, options: opts,
                 answer: correct, source: 'glossary', source_ref: '' });
    } else if (t === 'spelling') {
      out.push({ item_type: 'spelling', prompt: firstLine(w.translation), options: [],
                 answer: w.lemma, source: 'glossary', source_ref: w.phonetic || '' });
    }
  }
  return out;
}

app.get('/api/review/queue', (req, res) => {
  const size = Math.min(Number(req.query.size || 20), 100);
  const nowISO = isoUtc();
  const rows = db.prepare('SELECT w.* FROM words w JOIN review_states s ON s.word_id = w.id ' +
                          'WHERE s.due_at <= ? AND (w.lit = 1 OR s.total_reviews > 0 OR s.pre_known = 1) ' +
                          'ORDER BY s.due_at ASC LIMIT ?').all(nowISO, size);
  const dueTotal = db.prepare('SELECT COUNT(*) c FROM words w JOIN review_states s ON s.word_id = w.id ' +
                              'WHERE s.due_at <= ? AND (w.lit = 1 OR s.total_reviews > 0 OR s.pre_known = 1)')
    .get(nowISO).c;
  const words = rows.map(w => {
    const st = q.state.get(w.id) || {};
    return {
      id: w.id, lemma: w.lemma, phonetic: w.phonetic, translation: w.translation,
      scenario_major: w.scenario_major, scenario_minor: w.scenario_minor,
      x: w.x, y: w.y, z: w.z,
      strength: st.strength == null ? 0 : st.strength,
      level: st.level == null ? 0 : st.level,
      examples: q.examples.all(w.id).slice(0, 1),
      items: itemsForWord(w, ['meaning_en2zh', 'spelling', 'collocation']),
    };
  });
  res.json({ dueTotal, batchSize: words.length, words });
});

app.post('/api/review/submit', (req, res) => {
  const body = req.body || {};
  const wordId = body.word_id;
  const itemType = body.item_type || '';
  const correct = !!body.correct;
  const elapsed = Number(body.elapsed_ms || 0);
  const hinted = body.hinted ? 1 : 0;
  if (!wordId) return res.status(400).json({ error: 'word_id required' });
  const st = q.state.get(wordId);
  if (!st) return res.status(404).json({ error: 'state not found' });
  const lvBefore = st.level;
  const lv = nextLevel(st.level, correct);
  const streak = correct ? (st.streak || 0) + 1 : 0;
  const strength = strengthOf(lv, streak, correct);
  const due = dueAt(lv);
  const nowISO = isoUtc();
  const errType = correct ? '' : (ITEM_ERROR[itemType] || 'meaning');
  tx(() => {
    db.prepare('UPDATE review_states SET level=?, streak=?, due_at=?, last_review_at=?, ' +
               'total_reviews=total_reviews+1, total_correct=total_correct+?, strength=?, ' +
               'mastering=CASE WHEN ?>=5 THEN 1 ELSE mastering END WHERE word_id=?')
      .run(lv, streak, due, nowISO, correct ? 1 : 0, strength, lv, wordId);
    db.prepare('INSERT INTO review_logs(word_id, reviewed_at, item_type, correct, elapsed_ms, ' +
               'hinted, error_type, level_before, level_after) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(wordId, nowISO, itemType, correct ? 1 : 0, elapsed, hinted, errType, lvBefore, lv);
    if (!correct) {
      db.prepare('INSERT INTO error_stats(word_id, error_type, cnt) VALUES(?,?,1) ' +
                 'ON CONFLICT(word_id, error_type) DO UPDATE SET cnt = cnt + 1').run(wordId, errType);
    }
  });
  res.json({ ok: true, level: lv, levelBefore: lvBefore, streak, strength, due_at: due, errorType: errType });
});

// ---------------------------------------------------------------- 导出
app.get('/api/export/csv', (req, res) => {
  const rows = db.prepare('SELECT w.lemma, w.phonetic, w.translation, w.scenario_major, w.scenario_minor, ' +
    's.level, s.streak, s.strength, s.due_at, s.last_review_at, s.total_reviews, s.total_correct, s.pre_known, ' +
    '(SELECT GROUP_CONCAT(error_type || \':\' || cnt, \'|\') FROM error_stats e WHERE e.word_id = w.id) AS errors ' +
    'FROM words w JOIN review_states s ON s.word_id = w.id ' +
    'WHERE s.total_reviews > 0 OR s.pre_known = 1 ORDER BY w.lemma').all();
  const head = ['lemma', 'phonetic', 'translation', 'major', 'minor', 'level', 'streak', 'strength',
                'due_at', 'last_review_at', 'total_reviews', 'total_correct', 'pre_known', 'errors'];
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const lines = [head.join(',')];
  for (const r of rows) lines.push(head.map(h => esc(r[h])).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wordvault-progress.csv"');
  res.send('\ufeff' + lines.join('\n'));
});

app.get('/api/export/json', (req, res) => {
  const rows = db.prepare('SELECT w.lemma, s.* FROM words w JOIN review_states s ON s.word_id = w.id ' +
                          'WHERE s.total_reviews > 0 OR s.pre_known = 1').all();
  res.setHeader('Content-Disposition', 'attachment; filename="wordvault-progress.json"');
  res.json({ exportedAt: new Date().toISOString(), count: rows.length, rows });
});

// ---------------------------------------------------------------- 静态前端
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (req, res) => res.type('html').send(
    '<meta charset="utf-8"><body style="font-family:system-ui;background:#05060c;color:#dfe7ff;padding:40px">' +
    '<h2>词穹 WordVault 后端已启动</h2><p>前端还没构建：在 <code>web/</code> 下运行 <code>npm install</code> 后 <code>npm run build</code>。</p>' +
    '<p>健康检查：<a style="color:#8ab4ff" href="/api/health">/api/health</a></p></body>'));
}

app.listen(PORT, HOST, () => {
  const words = db.prepare('SELECT COUNT(*) c FROM words').get().c;
  console.log('[wordvault] http://' + HOST + ':' + PORT + '  词条 ' + words + '  数据库 ' + DB_PATH);
});
