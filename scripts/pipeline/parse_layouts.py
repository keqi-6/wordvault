"""多种「星相」布局：按不同关系维度给星星重新分区与排布。

用户要的是：切换按钮 → 整张星空的相位重排，用来观察不同的联系。
  scenario  情景分区（现有的两级：大区 -> 子类）
  root      词根家族（MorphoLex 的词根）
  prefix    前缀家族
  suffix    后缀家族
  semantic  语义场（WordNet 的 lexname 领域）

每个布局：把词按聚类键分组 -> 取最大的 K 组当独立星团、其余归入「其他」
-> 星团锚点均匀分布在一个球面上 -> 词的位置 = 锚点 + (它在嵌入空间里相对本团质心的偏移)*比例
这样每个布局都是一张不同的星空，但同一个团内部仍然保留语义邻接。

输入: data/build/dictionary.json, relations.json, umap3d.json
输出: data/build/layouts.json
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BUILD, DICT_JSON, NLTK_DATA, REL_JSON, ensure_dirs, log, norm_word, read_json, write_json,
)

WN_DIR = NLTK_DATA / "corpora" / "wordnet"
WN_FILES = {"n": "data.noun", "v": "data.verb", "a": "data.adj", "r": "data.adv"}

RADIUS = 132.0            # 星团锚点所在的球面半径（锚点靠近些，星空才不会太空）
# 星团半径 ∝ 词数^0.35：面积大致随词数增长，又不会让两万词的巨云吃掉整张图。
# 之前用固定截断（LOCAL_MAX）导致「6064 词的团」和「889 词的团」在屏幕上一样大，
# 标签上的数字和画面完全对不上，这是编码失效。
# 星团还得"填得满"天空：10 个团铺在半径 190 的球面上，如果每个团半径只有 6-12，
# 画面 95% 是空的，看起来就是散点图而不是星空。基准按星团数自适应
# （团越多，每个团要越小才不会互相压叠）。
CLUSTER_BASE = 1.75
CLUSTER_EXP = 0.35
# 最小半径不能写死：10 个团时球面间距约 148，98 个团时只有 47。
# 写死 2.4 会让 96 个词根家族缩成看不见的小点，而没信息量的兜底云反而最大。
# 按「实际相邻间距的 13%」自适应。
MIN_SPACING_RATIO = 0.13
FALLBACK_SHRINK = 0.6    # 兜底云（其他 / 无归类）再收一点，别抢戏
TOP_CLUSTERS = 24
MIN_CLUSTER = 4

LEXNAME = {
    "adj.all": "形容词·通用", "adj.pert": "形容词·相关", "adv.all": "副词",
    "noun.Tops": "总类", "noun.act": "行为", "noun.animal": "动物", "noun.artifact": "人造物",
    "noun.attribute": "属性", "noun.body": "身体", "noun.cognition": "认知",
    "noun.communication": "交流", "noun.event": "事件", "noun.feeling": "情感",
    "noun.food": "食物", "noun.group": "群体", "noun.location": "位置", "noun.motive": "动机",
    "noun.object": "物体", "noun.person": "人", "noun.phenomenon": "现象", "noun.plant": "植物",
    "noun.possession": "占有", "noun.process": "过程", "noun.quantity": "数量",
    "noun.relation": "关系", "noun.shape": "形状", "noun.state": "状态", "noun.substance": "物质",
    "noun.time": "时间", "verb.body": "身体动作", "verb.change": "变化",
    "verb.cognition": "认知动作", "verb.communication": "交流动作", "verb.competition": "竞争",
    "verb.consumption": "消耗", "verb.contact": "接触", "verb.creation": "创造",
    "verb.emotion": "情绪动作", "verb.motion": "位移", "verb.perception": "感知",
    "verb.possession": "获得", "verb.social": "社交动作", "verb.stative": "状态动词",
    "verb.weather": "天气", "adj.ppl": "分词形容词",
}
LEX_FILES = {
    0: "adj.all", 1: "adj.pert", 2: "adv.all", 3: "noun.Tops", 4: "noun.act",
    5: "noun.animal", 6: "noun.artifact", 7: "noun.attribute", 8: "noun.body",
    9: "noun.cognition", 10: "noun.communication", 11: "noun.event", 12: "noun.feeling",
    13: "noun.food", 14: "noun.group", 15: "noun.location", 16: "noun.motive",
    17: "noun.object", 18: "noun.person", 19: "noun.phenomenon", 20: "noun.plant",
    21: "noun.possession", 22: "noun.process", 23: "noun.quantity", 24: "noun.relation",
    25: "noun.shape", 26: "noun.state", 27: "noun.substance", 28: "noun.time",
    29: "verb.body", 30: "verb.change", 31: "verb.cognition", 32: "verb.communication",
    33: "verb.competition", 34: "verb.consumption", 35: "verb.contact", 36: "verb.creation",
    37: "verb.emotion", 38: "verb.motion", 39: "verb.perception", 40: "verb.possession",
    41: "verb.social", 42: "verb.stative", 43: "verb.weather", 44: "adj.ppl",
}


def fibonacci_sphere(n: int, radius: float) -> list[tuple[float, float, float]]:
    pts = []
    golden = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(n):
        y = 1 - (i / float(max(n - 1, 1))) * 2
        r = math.sqrt(max(0.0, 1 - y * y))
        theta = golden * i
        pts.append((math.cos(theta) * r * radius, y * radius, math.sin(theta) * r * radius))
    return pts


def wordnet_lexname() -> dict[str, str]:
    """词 -> 它第一个 synset 的语义场（lexname）。"""
    first: dict[str, str] = {}
    for pos, fname in WN_FILES.items():
        path = WN_DIR / fname
        if not path.exists():
            continue
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line or line[0] not in "0123456789":
                    continue
                toks = line.split(" ", 5)
                if len(toks) < 5:
                    continue
                try:
                    lex = int(toks[1])
                except ValueError:
                    continue
                name = LEX_FILES.get(lex)
                if not name:
                    continue
                zh = LEXNAME.get(name, name)
                head = line.partition("|")[0].split()
                try:
                    w_cnt = int(head[3], 16)
                except (IndexError, ValueError):
                    continue
                idx = 4
                for _ in range(w_cnt):
                    if idx >= len(head):
                        break
                    w = norm_word(head[idx])
                    if w and w not in first:
                        first[w] = zh
                    idx += 2
    log(f"  WordNet 语义场覆盖: {len(first)} 词")
    return first


def build_layout(
    name: str,
    zh: str,
    desc: str,
    depth: int,
    groups: dict[str, list[str]],
    umap: dict[str, list[float]],
    labels: dict[str, str],
    edges_layer: str,
    universe: list[str],
    top_clusters: int = TOP_CLUSTERS,
    min_cluster: int = MIN_CLUSTER,
    missing_label: str = "未归类",
) -> dict:
    """groups: 聚类键 -> 词表；labels: 聚类键 -> 显示名。

    用户要求每张星图都要装得下所有词。所以这里分三类：
      family  家族够大的（独立星团，标签是词根/词缀本身）
      other   有归类但家族太小的（合成一片「其他」星云）
      none    在该维度下根本没有归类的（合成一片「无词根 / 无前缀」星云）
    三类合起来覆盖 universe 的全部词。
    """
    ranked = sorted(groups.items(), key=lambda kv: -len(kv[1]))
    big = [(k, v) for k, v in ranked if len(v) >= min_cluster][:top_clusters]
    used = {k for k, _ in big}
    rest = [w for k, v in groups.items() if k not in used for w in v]
    assigned = {w for v in groups.values() for w in v}
    missing = [w for w in universe if w not in assigned]

    clusters = list(big)
    kinds: dict[str, str] = {k: "family" for k, _ in big}
    # 上游可能直接给出「没归类」的桶（例如 WordNet 查不到语义场的词），
    # 把它和这里合成的 __none__ 区分开，避免键名撞车
    if any(k == "__unknown__" for k, _ in clusters):
        kinds["__unknown__"] = "none"
    if rest:
        clusters.append(("__other__", rest))
        kinds["__other__"] = "other"
    if missing:
        clusters.append(("__none__", missing))
        kinds["__none__"] = "none"

    # 团越多，单个团越小，否则相邻星团会互相压叠成一片
    n_clusters = max(len(clusters), 1)
    cluster_base = CLUSTER_BASE * (10.0 / n_clusters) ** 0.5
    spacing = 2.0 * RADIUS * math.sqrt(math.pi / n_clusters)
    min_radius = MIN_SPACING_RATIO * spacing
    anchors = fibonacci_sphere(len(clusters), RADIUS)
    centers: dict[str, list[float]] = {}
    positions: dict[str, list[float]] = {}
    for (key, members), anchor in zip(clusters, anchors):
        pts = [umap[w] for w in members if w in umap]
        if pts:
            centroid = np.mean(np.asarray(pts, dtype=np.float32), axis=0)
        else:
            centroid = np.zeros(3, dtype=np.float32)
        centers[key] = [round(float(c), 2) for c in anchor]
        kind = kinds.get(key, "family")
        # 该星团在屏幕上的半径：由词数决定，而不是由固定截断决定
        base_r = cluster_base * (len(members) ** CLUSTER_EXP)
        # 尺寸太小的小家族会变成看不见的点（root 星相里 48 词的家族只有 1.3 半径），
        # 给一个下限，保证每个命名家族都能被看到；兜底云本来就只是背景雾，再收一点。
        if kind == "family":
            base_r = max(base_r, min_radius)
        else:
            base_r *= FALLBACK_SHRINK
        # 团内形状仍用词向量空间的真实离散度，只把整体尺度缩放到 base_r
        if len(pts) >= 3:
            arr = np.asarray(pts, dtype=np.float32) - centroid
            ref = float(np.percentile(np.linalg.norm(arr, axis=1), 90)) or 1.0
        else:
            ref = 1.0
        k = base_r / ref
        cap = base_r * 1.8
        # 有些词没有词向量（26000 词里约 3200 个），原来直接给零偏移，
        # 结果它们全部叠在星团正中心变成一个假亮点。给它们一团确定性的散布。
        jitter_rng = np.random.default_rng(abs(hash(key)) % (2 ** 32))
        for w in members:
            p = umap.get(w)
            if p is None:
                u = jitter_rng.normal(0.0, 0.45 * base_r, 3)
                n = float(np.linalg.norm(u))
                m = base_r * 1.1
                if n > m:
                    u = u / n * m
                off = u.astype(np.float32)
            else:
                off = (np.asarray(p, dtype=np.float32) - centroid) * k
                n = float(np.linalg.norm(off))
                if n > cap:
                    off = off / n * cap
            q = np.asarray(anchor, dtype=np.float32) + off
            positions[w] = [round(float(q[0]), 2), round(float(q[1]), 2), round(float(q[2]), 2)]

    cluster_rows = []
    for key, members in clusters:
        kind = kinds.get(key, "family")
        if kind == "other":
            label = "其他（小家族）"
        elif kind == "none":
            label = missing_label
        else:
            label = labels.get(key, key)
        cluster_rows.append({
            "key": key, "zh": label, "count": len(members),
            "center": centers[key], "kind": kind,
        })
    cover = len(positions)
    assert cover == len(universe), f"{name} 覆盖 {cover} != 全部 {len(universe)}"
    log(f"  {name}: {len(cluster_rows)} 个星团，覆盖 {cover}/{len(universe)} 词"
        f"（家族 {sum(1 for r in cluster_rows if r['kind']=='family')} / "
        f"其他 {sum(r['count'] for r in cluster_rows if r['kind']=='other')} / "
        f"无归类 {sum(r['count'] for r in cluster_rows if r['kind']=='none')}）")
    return {
        "key": name, "zh": zh, "desc": desc, "depth": depth, "edges_layer": edges_layer,
        "clusters": cluster_rows,
        "positions": positions,
        "membership": {w: k for k, members in clusters for w in members},
    }


def main() -> None:
    ensure_dirs()
    doc = read_json(DICT_JSON)
    rel = read_json(REL_JSON, {"morphology": {}})
    umap = read_json(BUILD / "umap3d.json", {})
    if not doc or not umap:
        raise SystemExit("请先运行 parse_dict.py 与 parse_vectors.py")

    base = [w["lemma"] for w in doc["words"]]
    sats = [s["lemma"] for s in rel.get("satellites", []) if s.get("lemma")]
    words = list(dict.fromkeys(base + sats))
    morph = rel.get("morphology", {})
    log(f"词库 {len(words)} 词（词表内 {len(base)} + 卫星 {len(sats)}），嵌入坐标 {len(umap)} 词")

    scen_assign = read_json(BUILD / "scenarios.json", {}).get("assignment", {})
    scen_groups: dict[str, list[str]] = defaultdict(list)
    scen_labels: dict[str, str] = {}
    for lem in words:
        major = (scen_assign.get(lem) or {}).get("major") or "__unknown__"
        scen_groups[major].append(lem)

    root_groups: dict[str, list[str]] = defaultdict(list)
    pre_groups: dict[str, list[str]] = defaultdict(list)
    suf_groups: dict[str, list[str]] = defaultdict(list)
    for w in words:
        d = morph.get(w) or {}
        r = (d.get("root") or "").split(",")[0].strip()
        p = (d.get("prefix") or "").split(",")[0].strip()
        s = (d.get("suffix") or "").split(",")[0].strip()
        if r:
            root_groups[r].append(w)
        if p:
            pre_groups[p].append(w)
        if s:
            suf_groups[s].append(w)

    lex = wordnet_lexname()
    lex_groups: dict[str, list[str]] = defaultdict(list)
    for w in words:
        lex_groups[lex.get(w, "__unknown__")].append(w)

    # 情景布局沿用现有的两级结构，这里只导出与其它布局同构的一份坐标（大区级）
    for m in read_json(BUILD / "scenarios.json", {"majors": []}).get("majors", []):
        scen_labels[m["key"]] = m["zh"]

    layouts = [
        build_layout("scenario", "情景分区", "同一情景/话题下的常用词与表达", 2,
                     scen_groups, umap, scen_labels, "scenario", words,
                     top_clusters=12, missing_label="未归类"),
        build_layout("root", "词根家族", "共享同一词根的词（如 spect: inspect / spectator / perspective）", 1,
                     root_groups, umap, {k: k for k in root_groups}, "morphology", words,
                     top_clusters=96, min_cluster=3, missing_label="无词根"),
        build_layout("prefix", "前缀家族", "共享同一前缀的词（如 pre- / re- / un-）", 1,
                     pre_groups, umap, {k: k + "-" for k in pre_groups}, "morphology", words,
                     top_clusters=32, min_cluster=3, missing_label="无前缀"),
        build_layout("suffix", "后缀家族", "共享同一后缀的词（如 -tion / -able / -ment）", 1,
                     suf_groups, umap, {k: "-" + k for k in suf_groups}, "morphology", words,
                     top_clusters=32, min_cluster=3, missing_label="无后缀"),
        build_layout("semantic", "语义场", "WordNet 语义领域（如 动物 / 位移 / 情感）", 1,
                     lex_groups, umap, {k: k for k in lex_groups}, "semantic", words,
                     top_clusters=26, missing_label="未归类"),
    ]

    out = {
        "layouts": [
            {k: v for k, v in L.items() if k not in ("positions", "membership")}
            for L in layouts
        ],
        "positions": {L["key"]: L["positions"] for L in layouts},
        "membership": {L["key"]: L["membership"] for L in layouts},
    }
    write_json(BUILD / "layouts.json", out)
    log("写出 " + str(BUILD / "layouts.json"))


if __name__ == "__main__":
    main()
