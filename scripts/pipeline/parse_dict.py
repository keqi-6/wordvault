"""把 ECDICT 词典与 KyleBing 词表合并成统一词条库。

输出: data/build/dictionary.json
"""
from __future__ import annotations

import csv
import sys
from collections import OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BUILD, CET4_JSON, CET6_JSON, DICT_JSON, KAOYAN_JSON,
    ensure_dirs, extract_pos, is_simple_word, iter_ecdict, log, norm_word,
    clean_translation, normalize_phonetic, read_json, split_translation, strip_pos, write_json,
)


def load_kylebing(path: Path, tag: str) -> dict[str, dict]:
    data = read_json(path, [])
    if isinstance(data, dict):
        data = [{"word": k, **(v if isinstance(v, dict) else {"translations": [v]})} for k, v in data.items()]
    out: dict[str, dict] = {}
    for item in data or []:
        if not isinstance(item, dict):
            continue
        w = norm_word(item.get("word") or item.get("name") or "")
        if not w:
            continue
        translations = []
        for t in item.get("translations") or []:
            if isinstance(t, dict):
                translations.append({
                    "translation": (t.get("translation") or "").strip(),
                    "type": (t.get("type") or "").strip(),
                })
            elif isinstance(t, str):
                translations.append({"translation": t.strip(), "type": ""})
        phrases = []
        for p in item.get("phrases") or []:
            if isinstance(p, dict):
                ph = (p.get("phrase") or "").strip()
                if ph:
                    phrases.append({"phrase": ph, "translation": (p.get("translation") or "").strip()})
        out.setdefault(w, {"translations": [], "phrases": [], "tags": []})
        out[w]["translations"].extend(translations)
        out[w]["phrases"].extend(phrases)
        if tag not in out[w]["tags"]:
            out[w]["tags"].append(tag)
    return out


def main() -> None:
    ensure_dirs()

    kb: dict[str, dict] = {}
    for path, tag in ((CET6_JSON, "cet6"), (CET4_JSON, "cet4"), (KAOYAN_JSON, "kaoyan")):
        if path.exists():
            part = load_kylebing(path, tag)
            log(f"  KyleBing {path.name}: {len(part)} 词")
            for w, v in part.items():
                slot = kb.setdefault(w, {"translations": [], "phrases": [], "tags": []})
                slot["translations"].extend(v["translations"])
                slot["phrases"].extend(v["phrases"])
                for t in v["tags"]:
                    if t not in slot["tags"]:
                        slot["tags"].append(t)
    log(f"KyleBing 合计: {len(kb)} 词")

    cet6 = {w for w, v in kb.items() if "cet6" in v["tags"]}
    log(f"六级词表: {len(cet6)} 词")

    # 收集所有需要入库的词：六级词表 + 所有 KyleBing 词 + ECDICT 里的中文常用词
    wanted = set(kb) | cet6

    words: "OrderedDict[str, dict]" = OrderedDict()
    total = 0
    if True:
        for row in iter_ecdict():
            total += 1
            w = norm_word(row.get("word") or "")
            if not w:
                continue
            # 只保留单词（跳过词组、专有名词形式）
            if not is_simple_word(w):
                continue
            tags = set((row.get("tag") or "").split())
            if not tags:
                # 没有考试标签的词，只在 KyleBing 收录时才要
                if w not in kb:
                    continue
            entry = {
                "lemma": w,
                "phonetic": normalize_phonetic(row.get("phonetic")),
                "definition": (row.get("definition") or "").strip(),
                "translation": clean_translation(row.get("translation")),
                "pos": (row.get("pos") or "").strip(),
                "collins": _int(row.get("collins")),
                "oxford": _int(row.get("oxford")),
                "tag": " ".join(sorted(tags)),
                "bnc": _int(row.get("bnc")),
                "frq": _int(row.get("frq")),
                "exchange": (row.get("exchange") or "").strip(),
                "detail": (row.get("detail") or "").strip(),
                "audio": _int(row.get("audio")),
                "in_cet6": 1 if (w in cet6 or "cet6" in tags) else 0,
                "senses": [],
                "phrases": [],
            }
            senses = []
            for t in kb.get(w, {}).get("translations", []):
                if t["translation"]:
                    senses.append({"pos": t["type"], "translation": t["translation"]})
            if not senses:
                for s in split_translation(entry["translation"])[:8]:
                    senses.append({"pos": extract_pos(s).rstrip("."), "translation": strip_pos(s)})
            entry["senses"] = senses[:12]
            entry["phrases"] = kb.get(w, {}).get("phrases", [])[:20]
            if w in kb:
                for t in kb[w]["tags"]:
                    if t not in tags:
                        tags.add(t)
                entry["tag"] = " ".join(sorted(tags))
            words[w] = entry

    log(f"ECDICT 读取 {total} 行，选中 {len(words)} 词")

    lit = sorted((e for e in words.values() if e["in_cet6"]), key=lambda e: (e["frq"] or 99999))
    out = {
        "generated_from": ["ECDICT", "KyleBing/english-vocabulary"],
        "cet6_count": sum(1 for e in words.values() if e["in_cet6"]),
        "total": len(words),
        "freq_order_preview": [e["lemma"] for e in lit[:30]],
        "words": list(words.values()),
    }
    write_json(DICT_JSON, out)
    log(f"写出 {DICT_JSON}  共 {len(words)} 词（六级 {out['cet6_count']}）")
    log("词频前 30: " + ", ".join(out["freq_order_preview"]))


def _int(v) -> int:
    try:
        return int(str(v).strip() or 0)
    except ValueError:
        return 0


if __name__ == "__main__":
    main()
