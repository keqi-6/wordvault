"""Tatoeba 中英对照例句提取（2026-09 重写）。

旧实现的问题：
  1. 先筛"含目标词的英文句"（上限 150 万，其中绝大多数没有中文配对），
     再去找配对 —— 候选池被无配对的句子占满，最终只有 35% 的六级词拿到翻译；
  2. links.csv 是**通用翻译链接、不区分语言**，早先把"任何出边"当成中文配对，只剩 3%。

新结构（只处理真正有中文配对的句子，总共约 7 万条，内存完全放得下）：
  1. 读全部中文句 → cmn_all {id: 文本}
  2. 扫 links → eng2cmn {英文句 id: 中文句 id}（只认目标在 cmn_all 里的）
  3. 扫英文句 → **只保留 eng2cmn 里的**，按目标词建索引
  4. 组装：每个词取前 N 条，全部自带中文翻译
"""
from __future__ import annotations

import bz2
import re
import tarfile
from collections import defaultdict

TOKEN = re.compile(r"[A-Za-z][A-Za-z'\-]*")

# Tatoeba 的中文语料繁简混杂（实测相当一部分是繁体），大陆用户读起来有障碍。
# opencc 是纯 Python 包，装不上时自动跳过（不影响主流程）。
try:
    from opencc import OpenCC

    _T2S = OpenCC("t2s")
except Exception:  # noqa: BLE001
    _T2S = None


def to_simplified(text: str) -> str:
    if not text or _T2S is None:
        return text
    try:
        return _T2S.convert(text)
    except Exception:  # noqa: BLE001
        return text


def build_examples(eng_f, cmn_f, links_f, targets: set[str], per_word: int = 3) -> dict[str, list[dict]]:
    """返回 {词: [例句...]}，每条例句都带中文翻译。"""
    # ---- 1) 全部中文句 ----
    cmn_all: dict[str, str] = {}
    with bz2.open(cmn_f, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) >= 3:
                cmn_all[p[0]] = p[2]
    print(f"    中文句总数 {len(cmn_all)}")

    # ---- 2) 英 -> 中 配对 ----
    eng2cmn: dict[str, str] = {}
    with tarfile.open(links_f, "r:bz2") as tf:
        member = next((m for m in tf.getmembers() if m.name.endswith("links.csv")), None)
        if member is None:
            print("    links.csv 未找到")
            return {}
        fh = tf.extractfile(member)
        assert fh is not None
        for raw in fh:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line or line[0] not in "0123456789":
                continue
            a, _, b = line.partition("\t")
            if b in cmn_all:
                eng2cmn[a] = b
    print(f"    有中文配对的英文句 {len(eng2cmn)}")

    # ---- 3) 扫英文句，只留有配对的 ----
    hits: dict[str, list[tuple[str, str]]] = defaultdict(list)
    kept = 0
    with bz2.open(eng_f, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            p = line.rstrip("\n").split("\t")
            if len(p) < 3:
                continue
            sid, text = p[0], p[2]
            if sid not in eng2cmn:
                continue
            if not (20 <= len(text) <= 200):
                continue
            kept += 1
            zh = cmn_all[eng2cmn[sid]]
            seen: set[str] = set()
            for t in TOKEN.findall(text):
                w = t.lower()
                if w in targets and w not in seen:
                    seen.add(w)
                    if len(hits[w]) < per_word * 6:
                        hits[w].append((text, zh))
    print(f"    可用中英对照句 {kept}，涉及 {len(hits)} 个词")

    # ---- 4) 组装 ----
    out: dict[str, list[dict]] = defaultdict(list)
    for w, pairs in hits.items():
        seen_text: set[str] = set()
        for text, zh in pairs:
            if len(out[w]) >= per_word:
                break
            if text in seen_text:
                continue
            seen_text.add(text)
            out[w].append({"en": text, "zh": to_simplified(zh), "source": "tatoeba"})
    return out