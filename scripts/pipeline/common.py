"""词穹 WordVault 数据管线 —— 公共路径与工具。"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
RAW = DATA / "raw"
BUILD = DATA / "build"
NLTK_DATA = DATA / "nltk_data"
DB_PATH = DATA / "wordvault.db"

ECDICT_CSV = RAW / "ecdict.csv"
ECDICT_SQLITE = RAW / "ecdict-hf" / "ecdict.sqlite"
LEMMA_TXT = RAW / "lemma.en.txt"
CET6_JSON = RAW / "kylebing" / "4-CET6.json"
CET4_JSON = RAW / "kylebing" / "3-CET4.json"
KAOYAN_JSON = RAW / "kylebing" / "5-kaoyan.json"
MORPHOLEX_DIR = RAW / "MorphoLex-en"
EXAM_DIR = RAW / "cet6-resources"
TATOEBA_DIR = RAW / "tatoeba"
GLOVE_ZIP = RAW / "glove.6B.zip"
GLOVE_TXT = RAW / "glove.6B.300d.txt"

DICT_JSON = BUILD / "dictionary.json"
REL_JSON = BUILD / "relations.json"
EXAM_JSON = BUILD / "exam.json"
VEC_JSON = BUILD / "vectors.json"
SCEN_JSON = BUILD / "scenarios.json"
GEN_JSON = BUILD / "gen_dims.json"

LIT_LIMIT = 500


def log(msg: str) -> None:
    print(msg, flush=True)


def ensure_dirs() -> None:
    for d in (DATA, RAW, BUILD, NLTK_DATA):
        d.mkdir(parents=True, exist_ok=True)


def read_json(path, default=None):
    p = Path(path)
    if not p.exists():
        return default
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, obj) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


_SIMPLE = re.compile(r"^[a-z][a-z'\-]*$")


def norm_word(w: str) -> str:
    return unicodedata.normalize("NFKC", (w or "")).strip().lower()


def is_simple_word(w: str) -> bool:
    return bool(_SIMPLE.match(w))


def iter_ecdict():
    """逐行产出 ECDICT 词条（dict）。优先用 SQLite 包，其次用原始 CSV。

    SQLite 包来自 HuggingFace 镜像上的 ECDICT 离线分发（770,611 条），
    下载约 49 MB / 80 秒；原始 ecdict.csv 是 66 MB，本机实测只有 20-40 KB/s。
    注意：SQLite 版本没有 detail / audio 两列，缺失时按空值处理。
    """
    if ECDICT_SQLITE.exists():
        import sqlite3
        conn = sqlite3.connect(str(ECDICT_SQLITE))
        conn.row_factory = sqlite3.Row
        cols = "word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange"
        for row in conn.execute("SELECT " + cols + " FROM entries"):
            rec = {k: row[k] for k in row.keys()}
            rec.setdefault("detail", "")
            rec.setdefault("audio", 0)
            yield rec
        conn.close()
        return
    import csv
    if not ECDICT_CSV.exists():
        raise SystemExit("既没有 " + str(ECDICT_SQLITE) + " 也没有 " + str(ECDICT_CSV))
    with open(ECDICT_CSV, "r", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            yield row


DICT_MARK = re.compile(r"\[[^\]]{1,8}\]\s*")

# ---- 音标规范化 ----
# ECDICT 的 phonetic 是"伪 IPA"：混进西里尔/希腊字母、用 ASCII 字符代替 IPA 符号。
# 下表来自**实际字符统计 + 抽样验证**（不是猜的）：
#   ә(U+04D9 西里尔 schwa) x16433 → ə
#   ^  x268  实际是损坏的 g（categorize 的音标应为 ˈkætɪɡəraɪz）
#   反斜杠 x240 实际是损坏的 ɜ（conversely 的音标应为 ˈkɒnvɜːsli）
#   : x7034 → ː（长音符）;  ' x20181 → ˈ（主重音）;  . x2374 → ˌ（次重音）
#   є(U+0454)/ε(U+03B5) → ɛ ;  (?@) 是"又作"标记 → ；
PHON_CHAR_MAP = {
    "ә": "ə", "є": "ɛ", "ε": "ɛ",
    "^": "ɡ", chr(92): "ɜ", "g": "ɡ",
    ":": "ː", "'": "ˈ", ".": "ˌ",
}
PHON_DIGRAPHS = [("ai", "aɪ"), ("ei", "eɪ"), ("au", "aʊ"), ("əu", "əʊ"), ("ɔi", "ɔɪ"), ("ou", "əʊ")]


def normalize_phonetic(raw: str | None) -> str:
    """把 ECDICT 的"伪 IPA"规范化成真正的 IPA。

    只做字符级映射 + 双元音改写，**不改动音节结构**（`,` `-` `()` 等一律保留，
    因为抽样显示它们在不同词里含义不一，动它们风险大于收益）。
    """
    if not raw:
        return ""
    t = str(raw).strip().replace("(?@)", "；")
    for bad, good in PHON_CHAR_MAP.items():
        t = t.replace(bad, good)
    for bad, good in PHON_DIGRAPHS:
        t = t.replace(bad, good)
    t = re.sub(r"[@?]+", "", t)
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def clean_translation(raw: str | None, keep_newlines: bool = True) -> str:
    """清洗 ECDICT 的释义串。

    两个坑：
      1. 换行是用**转义的 \\n（反斜杠 + n）**存的，直接展示会露出字面量 "\n"；
      2. 夹着 [经] [计] [医] 这类词典领域标记，对学习者没意义。
    这里还原真换行、去掉标记、丢掉空行。
    """
    if not raw:
        return ""
    text = str(raw).replace("\\r", "").replace("\\n", "\n")
    lines = []
    for line in text.split("\n"):
        line = DICT_MARK.sub("", line).strip()
        if line:
            lines.append(line)
    return ("\n" if keep_newlines else "；").join(lines).strip()


def split_translation(raw: str | None) -> list[str]:
    """把 ECDICT 与 KyleBing 的中文释义串切成义项列表。"""
    if not raw:
        return []
    text = raw.replace("\\n", "\n")
    parts: list[str] = []
    for chunk in text.split("\n"):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk.startswith("[") and chunk.endswith("]"):
            continue
        for piece in re.split(r"[；;]", chunk):
            piece = piece.strip()
            if piece:
                parts.append(piece)
    return parts


def extract_pos(translation: str) -> str:
    """从 'n. 能力' / 'vt.& vi. 跑' 里取出词性前缀。"""
    m = re.match(r"^([a-zA-Z]{1,5}(?:\.[a-zA-Z]{1,5})*\.)\s*", translation or "")
    return m.group(1) if m else ""


def strip_pos(translation: str) -> str:
    m = re.match(r"^([a-zA-Z]{1,5}(?:\.[a-zA-Z]{1,5})*\.)\s*", translation or "")
    return translation[m.end():].strip() if m else (translation or "").strip()
