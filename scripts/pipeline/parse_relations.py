"""生成三层关系边 + 卫星星。

语义层不再依赖 nltk：直接解析 WordNet 的 data.* 文件，
避免把整条管线绑定在重依赖上（本机 pip 走境外源很慢）。

输入: data/build/dictionary.json, data/nltk_data/corpora/wordnet/**, data/raw/MorphoLex-en/**
输出: data/build/relations.json, data/build/wordnet_zh.json
"""
from __future__ import annotations

import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BUILD, DICT_JSON, MORPHOLEX_DIR, NLTK_DATA, REL_JSON,
    clean_translation, ensure_dirs, is_simple_word, iter_ecdict, log, norm_word, normalize_phonetic,
    read_json, write_json,
)

WN_DIR = NLTK_DATA / "corpora" / "wordnet"
WN_FILES = {"n": "data.noun", "v": "data.verb", "a": "data.adj", "r": "data.adv"}
OMW_CMN = NLTK_DATA / "corpora" / "omw-1.4" / "cow" / "wn-data-cmn.tab"
ZH_JSON = BUILD / "wordnet_zh.json"

SATELLITE_CAP = 3        # 每个词最多保留 3 个词表外卫星（控制星空密度）
SCENARIO_LINKS = 3
ROOT_FAMILY_MAX = 12
MORPH_ROOT_MIN_WORDS = 2
SYNSET_PER_WORD = 6
NEAR_PER_HYPERNYM = 8


# ---------------------------------------------------------------- WordNet
def parse_wordnet() -> tuple[dict, dict]:
    synsets: dict[str, dict] = {}
    lemma_index: dict[str, list[str]] = defaultdict(list)
    for pos, fname in WN_FILES.items():
        path = WN_DIR / fname
        if not path.exists():
            log("  缺少 " + str(path))
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line or line[0] not in "0123456789":
                    continue
                data_part, _, gloss = line.partition("|")
                toks = data_part.split()
                if len(toks) < 6:
                    continue
                offset = toks[0]
                try:
                    w_cnt = int(toks[3], 16)
                except ValueError:
                    continue
                idx = 4
                lemmas = []
                for _ in range(w_cnt):
                    if idx >= len(toks):
                        break
                    lemmas.append(toks[idx])
                    idx += 2
                ptrs = []
                if idx < len(toks):
                    try:
                        p_cnt = int(toks[idx])
                    except ValueError:
                        p_cnt = 0
                    idx += 1
                    for _ in range(p_cnt):
                        if idx + 3 >= len(toks):
                            break
                        ptrs.append((toks[idx], toks[idx + 1], toks[idx + 2], toks[idx + 3]))
                        idx += 4
                synsets[offset] = {"pos": pos, "lemmas": lemmas, "ptrs": ptrs, "gloss": gloss.strip()}
                for l in lemmas:
                    lemma_index[l.lower()].append(offset)
    log("  WordNet synset: " + str(len(synsets)) + "，词面: " + str(len(lemma_index)))
    return synsets, lemma_index


def parse_omw_cmn(synsets: dict) -> dict:
    """OMW 中文词面: synset_offset-pos -> [中文词]"""
    zh: dict[str, list[str]] = defaultdict(list)
    if not OMW_CMN.exists():
        log("  未找到 OMW 中文文件，跳过中文词面")
        return zh
    with open(OMW_CMN, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not line or line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2:
                continue
            key = parts[0].strip()
            if "-" not in key:
                continue
            offset = key.split("-")[0]
            # 格式: synset_offset-pos \t cmn:lemma \t 中文词
            word = parts[-1].strip()
            if not word or word.startswith("cmn:"):
                continue
            if offset in synsets and word not in zh[offset] and len(zh[offset]) < 12:
                zh[offset].append(word)
    log("  中文词面覆盖 synset: " + str(len(zh)))
    return zh


def wordnet_edges(vocab: set[str], synsets: dict, lemma_index: dict, zh: dict) -> tuple[list[dict], dict]:
    edges: list[dict] = []
    zh_out: dict[str, list[str]] = defaultdict(list)
    hypernym_of: dict[str, list[str]] = defaultdict(list)
    for offset, s in synsets.items():
        for sym, target, _tpos, _st in s["ptrs"]:
            if sym in ("@", "@i") and target in synsets:
                hypernym_of[target].append(offset)

    for w in sorted(vocab):
        offsets = [o for o in lemma_index.get(w, []) if o in synsets][:SYNSET_PER_WORD]
        if not offsets:
            continue
        seen_syn: set[str] = set()
        for o in offsets:
            s = synsets[o]
            for other in s["lemmas"]:
                a = norm_word(other)
                if a == w or "_" in a or not a.isascii() or not is_simple_word(a):
                    continue
                edges.append({"src": w, "dst": a, "layer": "semantic", "kind": "synonym",
                              "weight": 1.0, "source": "wordnet", "note": str(o)})
            for cmn in zh.get(o, []):
                if cmn not in zh_out[w] and len(zh_out[w]) < 6:
                    zh_out[w].append(cmn)
            # 反义
            for sym, target, _tpos, st in s["ptrs"]:
                if sym != "!" or target not in synsets:
                    continue
                t = synsets[target]
                si, ti = 0, 0
                try:
                    if len(st) == 4:
                        si = max(0, int(st[:2], 16) - 1)
                        ti = max(0, int(st[2:], 16) - 1)
                except ValueError:
                    pass
                if si < len(s["lemmas"]) and ti < len(t["lemmas"]):
                    a = norm_word(t["lemmas"][ti])
                    if a != w and a.isascii() and "_" not in a:
                        edges.append({"src": w, "dst": a, "layer": "semantic", "kind": "antonym",
                                      "weight": 1.0, "source": "wordnet", "note": t["lemmas"][ti]})
            # 派生形态关系（WordNet '+': derivationally related form）
            # 这是 MorphoLex 不可用时的形态层底座：analyse / analysis / analytical 这类派生对
            for sym, target, _tpos, st in s["ptrs"]:
                if sym not in ("+", "\\") or target not in synsets:
                    continue
                t = synsets[target]
                si, ti = 0, 0
                try:
                    if len(st) == 4:
                        si = max(0, int(st[:2], 16) - 1)
                        ti = max(0, int(st[2:], 16) - 1)
                except ValueError:
                    pass
                if si < len(s["lemmas"]) and ti < len(t["lemmas"]):
                    a = norm_word(t["lemmas"][ti])
                    if a != w and a.isascii() and "_" not in a and is_simple_word(a):
                        edges.append({"src": w, "dst": a, "layer": "morphology",
                                      "kind": "derivational", "weight": 0.9,
                                      "source": "wordnet", "note": t["lemmas"][ti]})
            # 近义：共享上位词
            for h in hypernym_of.get(o, [])[:3]:
                hs = synsets.get(h)
                if not hs:
                    continue
                for other in hs["lemmas"][:1]:
                    pass
                for sib_off in hypernym_of.get(h, [])[:NEAR_PER_HYPERNYM]:
                    if sib_off == o:
                        continue
                    sib = synsets.get(sib_off)
                    if not sib:
                        continue
                    key = h + ":" + sib_off
                    if key in seen_syn:
                        continue
                    seen_syn.add(key)
                    for other in sib["lemmas"][:3]:
                        a = norm_word(other)
                        if a == w or "_" in a or not a.isascii() or not is_simple_word(a):
                            continue
                        edges.append({"src": w, "dst": a, "layer": "semantic", "kind": "near",
                                      "weight": 0.55, "source": "wordnet", "note": h})
    log("  WordNet 边: " + str(len(edges)) + "，带中文词面的词: " + str(len(zh_out)))
    return edges, dict(zh_out)


# ---------------------------------------------------------------- MorphoLex
def _find_morpholex_file() -> Path | None:
    if not MORPHOLEX_DIR.exists():
        return None
    for exts in ((".csv", ".tsv", ".txt"), (".xlsx", ".xls")):
        cands = [p for p in MORPHOLEX_DIR.rglob("*") if p.suffix.lower() in exts]
        cands = [p for p in cands if p.stat().st_size > 1000]
        if cands:
            cands.sort(key=lambda p: -p.stat().st_size)
            return cands[0]
    return None


_SEG_PRE = re.compile(r"<([^<>()]*)<")
_SEG_ROOT = re.compile(r"\(([^()]*)\)")
_SEG_SUF = re.compile(r">([^<>()]*)>")


def _parse_segment(seg: str) -> dict:
    """把 MorphoLexSegm 形如 {<a<(line)} 拆成前缀/词根/后缀。"""
    if not seg:
        return {}
    return {
        "prefix": ",".join(x for x in _SEG_PRE.findall(seg) if x)[:40],
        "root": ",".join(x for x in _SEG_ROOT.findall(seg) if x)[:60],
        "suffix": ",".join(x for x in _SEG_SUF.findall(seg) if x)[:40],
    }


def _load_morpholex_rows(path: Path):
    """产出 (word, {prefix, root, suffix})。支持 xlsx 与 csv。"""
    if path.suffix.lower() in (".xlsx", ".xls"):
        import pandas as pd
        xl = pd.ExcelFile(path)
        sheets = [s for s in xl.sheet_names if s and s[0].isdigit()]
        if not sheets:
            sheets = xl.sheet_names[1:] or xl.sheet_names
        log("  MorphoLex 数据表: " + str(len(sheets)) + " 个")
        for s in sheets:
            df = xl.parse(s)
            cols = {str(c).strip().lower(): c for c in df.columns}
            wc = cols.get("word")
            sc = cols.get("morpholexsegm") or cols.get("morpholexsegmentation")
            if wc is None:
                continue
            for _, row in df.iterrows():
                w = row.get(wc)
                if not isinstance(w, str):
                    continue
                seg = row.get(sc) if sc is not None else ""
                yield norm_word(w), _parse_segment(seg if isinstance(seg, str) else "")
        return
    delim = "\t" if path.suffix.lower() == ".tsv" else ","
    with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh, delimiter=delim)
        cols = {str(c).strip().lower(): c for c in (reader.fieldnames or []) if c}
        wc = cols.get("word")
        sc = cols.get("morpholexsegm") or cols.get("morpholexsegmentation")
        for row in reader:
            if wc is None:
                break
            yield norm_word(row.get(wc) or ""), _parse_segment(str(row.get(sc) or ""))


def morpholex_edges(vocab: set[str]) -> tuple[list[dict], dict[str, dict]]:
    path = _find_morpholex_file()
    if not path:
        log("  MorphoLex: 未找到数据文件，形态层跳过")
        return [], {}
    log("  MorphoLex 文件: " + str(path))
    roots: dict[str, list[str]] = defaultdict(list)
    details: dict[str, dict] = {}
    for w, detail in _load_morpholex_rows(path):
        if not w or not is_simple_word(w):
            continue
        parts = [v for v in detail.values() if v and v not in ("-", "none", "0")]
        if not parts:
            continue
        details[w] = detail
        for r in parts:
            for one in str(r).split(","):
                one = one.strip()
                if one:
                    roots[one].append(w)

    edges: list[dict] = []
    families = 0
    for r, members in roots.items():
        members = sorted(set(members))
        if len(members) < MORPH_ROOT_MIN_WORDS:
            continue
        families += 1
        head = members[:ROOT_FAMILY_MAX]
        for i, a in enumerate(head):
            for b in head[i + 1:]:
                if a not in vocab and b not in vocab:
                    continue
                edges.append({"src": a, "dst": b, "layer": "morphology",
                              "kind": "root_family", "weight": 1.0,
                              "source": "morpholex", "note": r})
    log("  MorphoLex: " + str(families) + " 个构词单元, " + str(len(edges)) + " 条边, " + str(len(details)) + " 词有分解")
    return edges, details


# ---------------------------------------------------------------- 频次（挑卫星用）
def scan_freq(needed: set[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not needed:
        return out
    if True:
        for row in iter_ecdict():
            w = norm_word(row.get("word") or "")
            if w in needed and w not in out:
                out[w] = {
                    "lemma": w,
                    "phonetic": normalize_phonetic(row.get("phonetic")),
                    "translation": clean_translation(row.get("translation")),
                    "definition": (row.get("definition") or "").strip(),
                    "pos": (row.get("pos") or "").strip(),
                    "frq": _int(row.get("frq")), "bnc": _int(row.get("bnc")),
                    "tag": (row.get("tag") or "").strip(),
                    "exchange": (row.get("exchange") or "").strip(),
                    "collins": _int(row.get("collins")), "oxford": _int(row.get("oxford")),
                    "detail": (row.get("detail") or "").strip(),
                    "audio": _int(row.get("audio")),
                }
                if len(out) >= len(needed):
                    break
    return out


def _int(v) -> int:
    try:
        return int(str(v).strip() or 0)
    except (ValueError, TypeError):
        return 0


def main() -> None:
    ensure_dirs()
    doc = read_json(DICT_JSON)
    if not doc:
        raise SystemExit("请先运行 parse_dict.py")
    words = doc["words"]
    vocab = {w["lemma"] for w in words}
    log("词库 " + str(len(vocab)) + " 词，开始生成关系")

    synsets, lemma_index = parse_wordnet()
    zh_map = parse_omw_cmn(synsets)

    edges: list[dict] = []
    wn_edges, wn_zh = wordnet_edges(vocab, synsets, lemma_index, zh_map)
    edges.extend(wn_edges)

    morph_edges, morph_detail = morpholex_edges(vocab)
    edges.extend(morph_edges)

    collo = 0
    for w in words:
        for ph in w.get("phrases", []):
            for t in [norm_word(x) for x in str(ph.get("phrase", "")).split()]:
                if t and t != w["lemma"] and t in vocab:
                    edges.append({"src": w["lemma"], "dst": t, "layer": "scenario",
                                  "kind": "collocation", "weight": 1.2,
                                  "source": "kylebing", "note": ph.get("phrase", "")})
                    collo += 1
    log("  搭配边: " + str(collo))
    log("关系边合计（未裁剪）: " + str(len(edges)))

    seen = set()
    dedup: list[dict] = []
    for e in edges:
        key = (e["src"], e["dst"], e["layer"], e["kind"])
        if key in seen:
            continue
        seen.add(key)
        dedup.append(e)

    undirected = {"synonym", "near", "root_family", "collocation"}
    final: list[dict] = []
    used = set()
    for e in dedup:
        if e["kind"] in undirected:
            a, b = sorted((e["src"], e["dst"]))
            k = (a, b, e["layer"], e["kind"])
            if k in used:
                continue
            used.add(k)
        final.append(e)
    log("去重后: " + str(len(final)))

    # 卫星只挂在六级词上：否则 1.5 万个带考试标签的词各自引 3 个表外词，
    # 星空会被稀释成几万个点，反而看不见重点。
    cet6_words = {w["lemma"] for w in words if w.get("in_cet6")}
    satellites_needed = set()
    per_src_sat: dict[str, list[dict]] = defaultdict(list)
    kept: list[dict] = []
    for e in final:
        if e["dst"] in vocab:
            kept.append(e)
        elif e["src"] in cet6_words:
            per_src_sat[e["src"]].append(e)
    for src, items in per_src_sat.items():
        for e in items[:SATELLITE_CAP]:
            kept.append(e)
            satellites_needed.add(e["dst"])
    log("卫星候选词: " + str(len(satellites_needed)))

    sat_entries = scan_freq(satellites_needed)
    final_kept = [e for e in kept if e["dst"] in vocab or e["dst"] in sat_entries]
    log("裁剪后边数: " + str(len(final_kept)) + "  卫星入库: " + str(len(sat_entries)))

    out = {
        "edges": final_kept,
        "satellites": list(sat_entries.values()),
        "morphology": morph_detail,
        "wordnet_zh": wn_zh,
        "stats": {
            "edges": len(final_kept),
            "by_layer": _count_by(final_kept, "layer"),
            "by_kind": _count_by(final_kept, "kind"),
            "satellites": len(sat_entries),
        },
    }
    write_json(REL_JSON, out)
    write_json(ZH_JSON, wn_zh)
    log("写出 " + str(REL_JSON))
    log("分层统计: " + str(out["stats"]["by_layer"]))
    log("类型统计: " + str(out["stats"]["by_kind"]))


def _count_by(items: list[dict], key: str) -> dict:
    d: dict[str, int] = defaultdict(int)
    for it in items:
        d[it.get(key, "?")] += 1
    return dict(sorted(d.items(), key=lambda kv: -kv[1]))


if __name__ == "__main__":
    main()
