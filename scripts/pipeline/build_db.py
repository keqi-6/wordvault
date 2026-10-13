"""把 build/*.json 装配成 SQLite 数据库。

输入: build/dictionary.json, relations.json, exam.json, scenarios.json, vectors.json
输出: data/wordvault.db
"""
from __future__ import annotations

import bz2
import hashlib
import json
import random
import re
import sqlite3
import sys
import tarfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tatoeba_zh  # noqa: E402
from common import (  # noqa: E402
    BUILD, DB_PATH, DICT_JSON, EXAM_JSON, GEN_JSON, REL_JSON, SCEN_JSON, TATOEBA_DIR, VEC_JSON,
    ensure_dirs, extract_pos, log, norm_word, read_json, split_translation, strip_pos,
)

SCHEMA = """
PRAGMA journal_mode = WAL;
CREATE TABLE words(
  id INTEGER PRIMARY KEY,
  lemma TEXT UNIQUE NOT NULL,
  phonetic TEXT DEFAULT '',
  definition TEXT DEFAULT '',
  translation TEXT DEFAULT '',
  pos TEXT DEFAULT '',
  collins INTEGER DEFAULT 0,
  oxford INTEGER DEFAULT 0,
  tag TEXT DEFAULT '',
  bnc INTEGER DEFAULT 0,
  frq INTEGER DEFAULT 0,
  exchange TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  audio INTEGER DEFAULT 0,
  in_cet6 INTEGER DEFAULT 0,
  lit INTEGER DEFAULT 0,
  exam_freq INTEGER DEFAULT 0,
  is_satellite INTEGER DEFAULT 0,
  scenario_major TEXT DEFAULT '',
  scenario_minor TEXT DEFAULT '',
  x REAL DEFAULT 0, y REAL DEFAULT 0, z REAL DEFAULT 0,
  prefix TEXT DEFAULT '', root TEXT DEFAULT '', suffix TEXT DEFAULT '',
  gen_syntax TEXT DEFAULT '', gen_register TEXT DEFAULT '', gen_concept TEXT DEFAULT ''
);
CREATE TABLE senses(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL, ordinal INTEGER,
  pos TEXT DEFAULT '', translation TEXT DEFAULT '', definition TEXT DEFAULT '');
CREATE TABLE phrases(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL,
  phrase TEXT, translation TEXT DEFAULT '', source TEXT DEFAULT 'kylebing');
CREATE TABLE examples(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL,
  en TEXT, zh TEXT DEFAULT '', source TEXT DEFAULT '', source_ref TEXT DEFAULT '', is_machine INTEGER DEFAULT 0);
CREATE TABLE relations(id INTEGER PRIMARY KEY, src_id INTEGER NOT NULL, dst_id INTEGER NOT NULL,
  layer TEXT NOT NULL, kind TEXT NOT NULL, weight REAL DEFAULT 1.0, note TEXT DEFAULT '', source TEXT DEFAULT '');
CREATE TABLE scenarios(id INTEGER PRIMARY KEY, major TEXT, major_zh TEXT, minor TEXT, minor_zh TEXT,
  cx REAL, cy REAL, cz REAL, cnt INTEGER DEFAULT 0);
CREATE TABLE review_states(word_id INTEGER PRIMARY KEY,
  level INTEGER DEFAULT 0, streak INTEGER DEFAULT 0, due_at TEXT, last_review_at TEXT,
  total_reviews INTEGER DEFAULT 0, total_correct INTEGER DEFAULT 0,
  strength REAL DEFAULT 0, pre_known INTEGER DEFAULT 0, mastering INTEGER DEFAULT 0);
CREATE TABLE review_logs(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL, reviewed_at TEXT,
  item_type TEXT, correct INTEGER, elapsed_ms INTEGER DEFAULT 0, hinted INTEGER DEFAULT 0,
  error_type TEXT DEFAULT '', level_before INTEGER DEFAULT 0, level_after INTEGER DEFAULT 0);
CREATE TABLE error_stats(word_id INTEGER NOT NULL, error_type TEXT NOT NULL,
  cnt INTEGER DEFAULT 0, PRIMARY KEY(word_id, error_type));
CREATE TABLE quiz_items(id INTEGER PRIMARY KEY, word_id INTEGER NOT NULL, item_type TEXT NOT NULL,
  prompt TEXT, options TEXT DEFAULT '[]', answer TEXT DEFAULT '', source TEXT DEFAULT '',
  source_ref TEXT DEFAULT '', generated INTEGER DEFAULT 0);
CREATE TABLE zh_gloss(word_id INTEGER NOT NULL, zh TEXT NOT NULL, src TEXT DEFAULT 'omw');
CREATE TABLE layouts(layout TEXT NOT NULL, word_id INTEGER NOT NULL, cluster TEXT, cluster_zh TEXT,
  x REAL, y REAL, z REAL);
CREATE TABLE layout_meta(layout TEXT PRIMARY KEY, zh TEXT, descr TEXT, depth INTEGER,
  edges_layer TEXT, cluster_count INTEGER, word_count INTEGER);
CREATE TABLE layout_clusters(layout TEXT NOT NULL, cluster TEXT, zh TEXT, cnt INTEGER,
  cx REAL, cy REAL, cz REAL, kind TEXT DEFAULT 'family');
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX idx_words_major ON words(scenario_major);
CREATE INDEX idx_words_lit ON words(lit);
CREATE INDEX idx_rel_src ON relations(src_id);
CREATE INDEX idx_rel_dst ON relations(dst_id);
CREATE INDEX idx_rel_layer ON relations(layer);
CREATE INDEX idx_quiz_word ON quiz_items(word_id, item_type);
CREATE INDEX idx_states_due ON review_states(due_at);
CREATE INDEX idx_zh_word ON zh_gloss(word_id);
CREATE INDEX idx_layout_lookup ON layouts(layout, word_id);
CREATE INDEX idx_layout_cluster ON layouts(layout, cluster);
"""

LEVEL_DAYS = [0, 1, 2, 4, 7, 15, 30]
ITEM_ROTATION = ["meaning_en2zh", "spelling", "collocation", "listening", "meaning_zh2en"]


# ---- 数据清洗（2026-09 数据审计后加入）----
_SENSE_NOISE = re.compile(r"[\s，,；;、。.·：:!！?？]+")


def dedupe_senses(senses: list[dict]) -> list[dict]:
    """去掉重复义项。

    义项来自多个源（KyleBing / ECDICT / WordNet 中文），合并后大量重复：
    实测 5,793 个词有冗余，占全部义项的 33%。规则：
      - 两条归一化后完全相同 → 保留先出现的；
      - 一条被另一条**包含** → 保留更完整的那条。
    """
    norm = [_SENSE_NOISE.sub("", (s.get("translation") or "")) for s in senses]
    keep: list[dict] = []
    for i, s in enumerate(senses):
        a = norm[i]
        if not a:
            continue
        drop = False
        for j, b in enumerate(norm):
            if i == j or not b:
                continue
            if a == b and j < i:
                drop = True
                break
            if a != b and a in b:
                drop = True
                break
        if not drop:
            keep.append(s)
    return keep


def clean_root(root: str, lemma: str) -> str:
    """MorphoLex 有时把整个词当成词根（abandon → root=abandon），这种没有信息量。

    实测 7,642 个词（28.7%）的 root 等于词本身。
    """
    if not root:
        return ""
    parts = [p for p in root.split(",") if p and p.lower() != lemma.lower()]
    return ",".join(parts)


def clean_example(en: str) -> str:
    """真题例句常带题号/选项标记残留（实测 1,294 条以编号结尾）。"""
    t = (en or "").strip()
    t = re.sub(r"\s+\d{1,3}\s*[.．]?\s*$", "", t)      # 结尾的题号
    t = re.sub(r"^\s*\(?[A-Da-d]\s*[).．]\s*", "", t)   # 开头的选项标记
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


def iso(dt: datetime) -> str:
    """统一成 UTC 的 YYYY-MM-DDTHH:MM:SSZ，和前端/后端字符串比较口径一致。"""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now() -> str:
    return iso(datetime.now(timezone.utc))


def tatoeba_examples(targets: set[str], per_word: int = 2) -> dict[str, list[dict]]:
    """三遍扫描：英文句 -> 链接 -> 中文句。"""
    d = TATOEBA_DIR
    eng_f, cmn_f, links_f = d / "eng_sentences.tsv.bz2", d / "cmn_sentences.tsv.bz2", d / "links.tar.bz2"
    need = {eng_f: 20_000_000, cmn_f: 1_000_000, links_f: 100_000_000}
    for p, min_size in need.items():
        size = p.stat().st_size if p.exists() else 0
        if size < min_size:
            log(f"  Tatoeba 文件不完整（{p.name} {size/1e6:.1f}MB < {min_size/1e6:.0f}MB，可能还在下载），跳过例句")
            return {}
    import re
    tok = re.compile(r"[A-Za-z][A-Za-z'\-]*")

    # **关键**：Tatoeba 的 links.csv 是"通用翻译链接"，**不区分语言**——
    # 一条英文句可能连到法语/日语。早先直接把"任何出边"都当成中文配对，
    # 于是筛出来的 3% 就名不副实了。这里先把中文句 id 全读进来（文件只有 1.2MB），
    # 后面筛 links 时只认目标在中文集合里的。
    cmn_all: dict[str, str] = {}
    with bz2.open(cmn_f, "rt", encoding="utf-8", errors="replace") as cf:
        for line in cf:
            p = line.rstrip("\n").split("\t")
            if len(p) >= 3:
                cmn_all[p[0]] = p[2]
    log(f"    中文句总数 {len(cmn_all)}")

    kept: dict[str, dict] = {}
    hits: dict[str, list[str]] = defaultdict(list)
    log("  Tatoeba 第一遍：筛英文句")
    with bz2.open(eng_f, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            sid, _lang, text = parts[0], parts[1], parts[2]
            if not (40 <= len(text) <= 220):
                continue
            ws = {norm_word(t) for t in tok.findall(text)}
            hit = [w for w in ws if w in targets]
            if not hit:
                continue
            # 到达上限必须**同时停止写入 kept 与 hits**：
            # 只限 kept 会把 sid 加进 hits 却不在 kept 里，第四遍取 kept[sid] 时 KeyError。
            if len(kept) >= 1500000:
                break
            kept[sid] = {"en": text}
            for w in hit[:3]:
                if len(hits[w]) < per_word * 30:   # 带中文配对的句子稀少，候选池要放宽
                    hits[w].append(sid)
    log(f"    候选英文句 {len(kept)}，涉及 {len(hits)} 个词")

    log("  Tatoeba 第二遍：找中文对照")
    need_cmn: set[str] = set()
    pairs: dict[str, list[str]] = defaultdict(list)
    with tarfile.open(links_f, "r:bz2") as tf:
        member = next((m for m in tf.getmembers() if m.name.endswith("links.csv")), None)
        if member is None:
            log("    links.csv 未找到")
            return {}
        fh = tf.extractfile(member)
        assert fh is not None
        for raw in fh:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line or line[0] not in "0123456789":
                continue
            a, _, b = line.partition("\t")
            if a in kept and b in cmn_all:      # 只认目标是中文的配对
                pairs[a].append(b)
                need_cmn.add(b)
    log(f"    需要中文句 {len(need_cmn)}")

    log("  Tatoeba 第三遍：取中文句")
    cmn_text: dict[str, str] = {}
    with bz2.open(cmn_f, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3 and parts[0] in need_cmn:
                cmn_text[parts[0]] = parts[2]
                if len(cmn_text) >= len(need_cmn):
                    break
    log(f"    取到中文句 {len(cmn_text)}")

    # Tatoeba 的价值就在「中英对照」：没有中文配对的直接不要
    # （真题例句已经提供了大量英文例句，不需要再来一堆无翻译的）
    out: dict[str, list[dict]] = defaultdict(list)
    for w, sids in hits.items():
        # **优先取有中文配对的**：Tatoeba 的中英对照是这个源最大的价值，
        # 而带中文的英文句占比很低（约 3%），按文件顺序取会几乎全是无翻译的。
        # **只保留真正有中文配对的**：用户明确要求例句要有翻译，
        # 没有翻译的例句对学习没有价值（真题例句另走 exam 通道）。
        ordered = [s for s in sids if pairs.get(s)]
        for sid in ordered:
            if len(out[w]) >= per_word:
                break
            zh = ""
            for cid in pairs.get(sid, [])[:3]:
                if cid in cmn_text:
                    zh = cmn_text[cid]
                    break
            # 不再要求必须有中文配对：有配对的优先，没有的也留下（zh 为空）
            out[w].append({"en": kept[sid]["en"], "zh": zh, "source": "tatoeba", "ref": sid})
    log(f"    得到例句的词: {len(out)}")
    return out


def build_quiz_items(wid: int, entry: dict, pool: list[dict], rng: random.Random) -> list[dict]:
    items: list[dict] = []
    senses = entry.get("senses") or []
    if not senses:
        return items
    zh = senses[0]["translation"]
    en = entry["lemma"]
    if not zh:
        return items
    pos = senses[0].get("pos") or entry.get("pos") or ""

    # 干扰项要挑得像：同词性优先、释义长度接近，其次才是情景相近。
    # 纯随机挑会给出「学院的」对「性别」这种一眼就能排除的选项。
    cand: list[dict] = []
    for p in pool:
        ps = (p.get("senses") or [{}])[0]
        pz = ps.get("translation", "")
        if not pz or pz == zh or p["lemma"] == en:
            continue
        ppos = ps.get("pos") or p.get("pos") or ""
        cand.append({"zh": pz, "en": p["lemma"],
                     "same_pos": 0 if (pos and ppos and ppos != pos) else 1,
                     "dlen": abs(len(pz) - len(zh))})
    cand.sort(key=lambda c: (-c["same_pos"], c["dlen"]))

    def distractors(key: str, n: int = 3) -> list[str]:
        out: list[str] = []
        for c in cand:
            v = c[key]
            if v in out:
                continue
            out.append(v)
            if len(out) >= n:
                break
        return out

    # 1 英 -> 中
    opts = [zh] + distractors("zh")
    rng.shuffle(opts)
    items.append({"item_type": "meaning_en2zh", "prompt": en, "options": opts, "answer": zh,
                  "source": "glossary", "source_ref": ""})
    # 2 中 -> 英
    opts = [en] + distractors("en")
    rng.shuffle(opts)
    items.append({"item_type": "meaning_zh2en", "prompt": zh, "options": opts, "answer": en,
                  "source": "glossary", "source_ref": ""})
    # 3 拼写
    items.append({"item_type": "spelling", "prompt": zh, "options": [],
                  "answer": en, "source": "glossary", "source_ref": entry.get("phonetic", "")})
    # 4 听音选词
    opts = [en] + distractors("en")
    rng.shuffle(opts)
    items.append({"item_type": "listening", "prompt": en, "options": opts, "answer": en,
                  "source": "tts", "source_ref": ""})
    # 5 搭配填空
    for ph in (entry.get("phrases") or [])[:3]:
        text = str(ph.get("phrase") or "")
        low = text.lower()
        if en in low:
            blanked = low.replace(en, "____", 1)
            if blanked != low:
                items.append({"item_type": "collocation", "prompt": blanked, "options": [],
                              "answer": en, "source": "kylebing",
                              "source_ref": ph.get("translation", "")})
                break
    return items


def main() -> None:
    ensure_dirs()
    doc = read_json(DICT_JSON)
    rel = read_json(REL_JSON, {"edges": [], "satellites": [], "morphology": {}})
    exam = read_json(EXAM_JSON, {"freq": {}, "sentences": {}, "lit": []})
    scen = read_json(SCEN_JSON, {"majors": [], "assignment": {}})
    coords = read_json(VEC_JSON, {})
    gen = read_json(GEN_JSON, {"items": {}}).get("items", {})
    if not doc:
        raise SystemExit("请先运行 parse_dict.py")

    try:
        if DB_PATH.exists():
            DB_PATH.unlink()
        for suffix in ("-wal", "-shm"):
            p = Path(str(DB_PATH) + suffix)
            if p.exists():
                p.unlink()
    except PermissionError:
        raise SystemExit(
            "数据库文件被占用，无法重建。请先停掉后端（关掉 node src/index.js 那个窗口）再运行。"
        )

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)

    lit_set = set(exam.get("lit", []))
    freq = exam.get("freq", {})
    assignment = scen.get("assignment", {})
    morph = rel.get("morphology", {})

    entries: list[dict] = []
    for w in doc["words"]:
        entries.append(w)
    for s in rel.get("satellites", []):
        s = dict(s)
        s["is_satellite"] = 1
        s.setdefault("senses", [])
        entries.append(s)

    log(f"待入库词条: {len(entries)}（卫星 {len(rel.get('satellites', []))}）")

    # ---- words ----
    wid: dict[str, int] = {}
    rows = []
    for e in entries:
        lemma = e["lemma"]
        a = assignment.get(lemma, {})
        c = coords.get(lemma, [0.0, 0.0, 0.0])
        m = morph.get(lemma, {})
        g = gen.get(lemma, {})
        rows.append((
            lemma, e.get("phonetic", ""), e.get("definition", ""), e.get("translation", ""),
            e.get("pos", ""), int(e.get("collins") or 0), int(e.get("oxford") or 0),
            e.get("tag", ""), int(e.get("bnc") or 0), int(e.get("frq") or 0),
            e.get("exchange", ""), e.get("detail", ""), int(e.get("audio") or 0),
            int(e.get("in_cet6") or 0), 1 if lemma in lit_set else 0,
            int(freq.get(lemma, 0)), int(e.get("is_satellite") or 0),
            a.get("major", ""), a.get("minor", ""),
            float(c[0]), float(c[1]), float(c[2]),
            m.get("prefix", ""), clean_root(m.get("root", ""), lemma), m.get("suffix", ""),
            g.get("syntax", ""), g.get("register", ""), g.get("concept", ""),
        ))
    conn.executemany(
        "INSERT INTO words(lemma,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,"
        "exchange,detail,audio,in_cet6,lit,exam_freq,is_satellite,scenario_major,scenario_minor,"
        "x,y,z,prefix,root,suffix,gen_syntax,gen_register,gen_concept) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    for i, e in enumerate(entries, start=1):
        wid[e["lemma"]] = i
    log(f"  words: {len(rows)}")

    # ---- senses ----
    # 卫星词原来是 scan_freq 直接捞出来的，没有 senses；
    # 但用户把卫星也纳入了学习范围，所以按同样的规则从 translation 拆出义项。
    srows = []
    for e in entries:
        senses = e.get("senses") or []
        if not senses and e.get("translation"):
            senses = [{"pos": extract_pos(x).rstrip("."), "translation": strip_pos(x)}
                      for x in split_translation(e["translation"])[:8]]
        senses = dedupe_senses(senses)
        for i, s in enumerate(senses):
            srows.append((wid[e["lemma"]], i, s.get("pos", ""), s.get("translation", ""), s.get("definition", "")))
    conn.executemany("INSERT INTO senses(word_id,ordinal,pos,translation,definition) VALUES(?,?,?,?,?)", srows)
    log(f"  senses: {len(srows)}")

    # ---- phrases ----
    prows = []
    seen_ph = set()
    for e in entries:
        for p in e.get("phrases") or []:
            key = (wid[e["lemma"]], p.get("phrase", ""))
            if key in seen_ph or not p.get("phrase"):
                continue
            seen_ph.add(key)
            prows.append((wid[e["lemma"]], p.get("phrase", ""), p.get("translation", ""), "kylebing"))
    conn.executemany("INSERT INTO phrases(word_id,phrase,translation,source) VALUES(?,?,?,?)", prows)
    log(f"  phrases: {len(prows)}")

    # ---- examples ----
    # **顺序即优先级**：有中文对照的放前面，面板默认先给用户看得懂的那些。
    erows = []
    tcount = 0
    try:
        tato_targets = {e["lemma"] for e in entries}
        log(f"  中英对照目标词: {len(tato_targets)}（全部词条）")
        tato = tatoeba_zh.build_examples(
            TATOEBA_DIR / "eng_sentences.tsv.bz2",
            TATOEBA_DIR / "cmn_sentences.tsv.bz2",
            TATOEBA_DIR / "links.tar.bz2",
            tato_targets, per_word=3)
    except Exception as exc:  # noqa: BLE001
        log(f"  Tatoeba 读取失败，跳过例句: {exc}")
        tato = {}
    for w, sents in tato.items():
        if w not in wid:
            continue
        for s in sents:
            erows.append((wid[w], s["en"], s.get("zh", ""), "tatoeba", "", 0))
            tcount += 1
    log(f"  中英对照例句: {tcount}")
    for w, sents in (exam.get("sentences") or {}).items():
        if w not in wid:
            continue
        for i, s in enumerate(sents[:3]):
            erows.append((wid[w], clean_example(s.get("en", "")), "", "exam", f"cet6-{i}", 0))
    log(f"  真题例句: {len(erows) - tcount}")
    conn.executemany(
        "INSERT INTO examples(word_id,en,zh,source,source_ref,is_machine) VALUES(?,?,?,?,?,?)", erows)
    log(f"  examples 合计: {len(erows)}（中英对照 {tcount}）")

    # ---- relations ----
    rrows = []
    for e in rel.get("edges", []):
        src = wid.get(e.get("src", ""))
        dst = wid.get(e.get("dst", "")) if e.get("dst") else None
        if src is None:
            continue
        if e.get("kind") == "zh_gloss":
            continue
        if dst is None:
            continue
        rrows.append((src, dst, e.get("layer", ""), e.get("kind", ""),
                      float(e.get("weight", 1.0)), e.get("note", ""), e.get("source", "")))
    conn.executemany(
        "INSERT INTO relations(src_id,dst_id,layer,kind,weight,note,source) VALUES(?,?,?,?,?,?,?)", rrows)
    log(f"  relations: {len(rrows)}")

    # ---- 多星相布局（情景 / 词根 / 前缀 / 后缀 / 语义场）----
    lay = read_json(BUILD / "layouts.json", {"layouts": [], "positions": {}, "membership": {}})
    lrows, mrows, crows = [], [], []
    for L in lay.get("layouts", []):
        key = L["key"]
        pos = lay["positions"].get(key, {})
        mem = lay["membership"].get(key, {})
        zh_of = {c["key"]: c["zh"] for c in L.get("clusters", [])}
        for lemma, p in pos.items():
            wid_ = wid.get(lemma)
            if wid_ is None:
                continue
            cl = mem.get(lemma, "")
            lrows.append((key, wid_, cl, zh_of.get(cl, cl), float(p[0]), float(p[1]), float(p[2])))
        for c in L.get("clusters", []):
            mrows.append((key, c["key"], c["zh"], int(c["count"]), float(c["center"][0]),
                          float(c["center"][1]), float(c["center"][2]), c.get("kind", "family")))
        crows.append((key, L["zh"], L["desc"], int(L["depth"]), L["edges_layer"], len(L.get("clusters", [])), len(pos)))
    conn.executemany("INSERT INTO layouts(layout,word_id,cluster,cluster_zh,x,y,z) VALUES(?,?,?,?,?,?,?)", lrows)
    conn.executemany("INSERT INTO layout_clusters(layout,cluster,zh,cnt,cx,cy,cz,kind) VALUES(?,?,?,?,?,?,?,?)", mrows)
    conn.executemany("INSERT INTO layout_meta(layout,zh,descr,depth,edges_layer,cluster_count,word_count) VALUES(?,?,?,?,?,?,?)", crows)
    log(f"  layouts: {len(crows)} 套 / {len(lrows)} 条星位 / {len(mrows)} 个星团")

    # ---- OMW 中文词面（用于中文反查与词条面板）----
    zrows = []
    for w, zhs in (rel.get("wordnet_zh") or {}).items():
        if w not in wid:
            continue
        for z in zhs[:8]:
            zrows.append((wid[w], z, "omw"))
    conn.executemany("INSERT INTO zh_gloss(word_id, zh, src) VALUES(?,?,?)", zrows)
    log(f"  zh_gloss: {len(zrows)}")

    # ---- scenarios ----
    srows2 = []
    for m in scen.get("majors", []):
        for mi in m.get("minors", []):
            srows2.append((m["key"], m["zh"], mi["key"], mi["zh"],
                           float(mi["center"][0]), float(mi["center"][1]), float(mi["center"][2]), 0))
    conn.executemany(
        "INSERT INTO scenarios(major,major_zh,minor,minor_zh,cx,cy,cz,cnt) VALUES(?,?,?,?,?,?,?,?)", srows2)
    conn.execute("""UPDATE scenarios SET cnt = (
        SELECT COUNT(*) FROM words w WHERE w.scenario_major = scenarios.major
          AND w.scenario_minor = scenarios.minor)""")
    log(f"  scenarios: {len(srows2)}")

    # ---- review states ----
    strows = []
    base_due = datetime.now(timezone.utc)
    for e in entries:
        # 首期点亮的词默认今天到期；其余排到 90 天后（不主动打扰）
        if e["lemma"] in lit_set:
            due = iso(base_due)
        else:
            due = iso(base_due + timedelta(days=90))
        strows.append((wid[e["lemma"]], 0, 0, due, None, 0, 0, 0.0, 0, 0))
    conn.executemany(
        "INSERT INTO review_states(word_id,level,streak,due_at,last_review_at,total_reviews,"
        "total_correct,strength,pre_known,mastering) VALUES(?,?,?,?,?,?,?,?,?,?)", strows)
    log(f"  review_states: {len(strows)}")

    # ---- quiz items ----
    qrows = []
    by_minor: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for e in entries:
        a = assignment.get(e["lemma"], {})
        by_minor[(a.get("major", ""), a.get("minor", ""))].append(e)
    lit_entries = [e for e in entries if e["lemma"] in lit_set]
    for e in lit_entries:
        a = assignment.get(e["lemma"], {})
        pool = by_minor.get((a.get("major", ""), a.get("minor", "")), [])
        if len(pool) < 4:
            pool = lit_entries
        seed = int(hashlib.md5(e["lemma"].encode("utf-8")).hexdigest()[:8], 16)
        rng = random.Random(seed)
        for it in build_quiz_items(wid[e["lemma"]], e, pool, rng):
            qrows.append((wid[e["lemma"]], it["item_type"], it["prompt"],
                          json.dumps(it["options"], ensure_ascii=False), it["answer"],
                          it["source"], it["source_ref"], 0))
    # 真题上下文题：句子里挖空
    for w, sents in (exam.get("sentences") or {}).items():
        if w not in wid or w not in lit_set or not sents:
            continue
        sent = sents[0]["en"]
        low = sent.lower()
        if w not in low:
            continue
        blanked = low.replace(w, "____", 1)
        qrows.append((wid[w], "context", blanked, "[]", w, "exam", "", 0))
    conn.executemany(
        "INSERT INTO quiz_items(word_id,item_type,prompt,options,answer,source,source_ref,generated) "
        "VALUES(?,?,?,?,?,?,?,?)", qrows)
    log(f"  quiz_items: {len(qrows)}")

    # ---- settings ----
    conn.executemany("INSERT INTO settings(key,value) VALUES(?,?)", [
        ("schema_version", "1"),
        ("built_at", now()),
        ("level_days", json.dumps(LEVEL_DAYS)),
        ("item_rotation", json.dumps(ITEM_ROTATION)),
        ("lit_limit", "500"),
        ("total_words", str(len(entries))),
        ("cet6_words", str(sum(1 for e in entries if e.get("in_cet6")))),
    ])
    conn.commit()
    conn.execute("ANALYZE")
    conn.commit()

    cur = conn.execute("SELECT COUNT(*) FROM words WHERE lit=1")
    log(f"  首期点亮: {cur.fetchone()[0]} 词")
    conn.close()
    log(f"数据库写出: {DB_PATH}  ({DB_PATH.stat().st_size/1024/1024:.1f} MB)")


if __name__ == "__main__":
    main()
