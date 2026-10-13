"""情景分类（两级）+ 最终 3D 坐标。

情景定大区、词向量定位置：
  1. 用种子词向量算出每个大类/子类的质心
  2. 每个词按余弦相似度（+中文关键词加权）归入大类与子类
  3. 大区中心均匀分布在半径 150 的球面上，子类在区内再分层
  4. 最终坐标 = 大区中心 + 子类偏移 + 缩放后的 UMAP 局部坐标

输入: data/build/dictionary.json, relations.json, umap3d.json, vec300.npy, vec300_index.json
输出: data/build/scenarios.json, data/build/vectors.json
"""
from __future__ import annotations

import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BUILD, DICT_JSON, REL_JSON, SCEN_JSON, VEC_JSON, ensure_dirs, log, read_json, write_json,
)

MAJOR_RADIUS = 132.0
MINOR_RADIUS = 40.0
LOCAL_SCALE = 0.45
# 子类半径 ∝ 词数^0.35：让「情绪与态度 4294 词」明显比「考试与评估 211 词」大，
# 而不是所有子类一样大（那样标签上的数字和画面就对不上了）。
SCEN_BASE = 1.28
SCEN_EXP = 0.35

TAXONOMY = [
    {"key": "tech", "zh": "科技与创新", "en": "Science & Technology",
     "kw": ["技术", "科技", "科学", "工程", "计算", "数据", "机器", "电子", "实验", "研究", "发明", "创新"],
     "seeds": ["technology", "computer", "science", "machine", "digital", "engineer", "experiment", "research", "device", "software"],
     "minors": [
         {"key": "it", "zh": "信息技术", "seeds": ["computer", "software", "data", "network", "internet", "digital", "system"]},
         {"key": "research", "zh": "科学研究", "seeds": ["research", "experiment", "science", "theory", "evidence", "analysis"]},
     ]},
    {"key": "env", "zh": "环境与能源", "en": "Environment & Energy",
     "kw": ["环境", "污染", "气候", "生态", "能源", "资源", "排放", "自然", "保护", "可持续"],
     "seeds": ["environment", "pollution", "climate", "energy", "nature", "ecology", "resource", "emission", "wildlife", "sustainable"],
     "minors": [
         {"key": "climate", "zh": "气候与环保", "seeds": ["climate", "pollution", "environment", "waste", "emission", "recycle"]},
         {"key": "energy", "zh": "能源与资源", "seeds": ["energy", "fuel", "resource", "power", "solar", "supply"]},
     ]},
    {"key": "edu", "zh": "教育与学习", "en": "Education",
     "kw": ["教育", "学习", "学校", "学生", "课程", "教学", "考试", "知识", "大学", "培训"],
     "seeds": ["education", "student", "school", "learn", "teacher", "course", "study", "knowledge", "exam", "university"],
     "minors": [
         {"key": "school", "zh": "学校与课程", "seeds": ["school", "student", "teacher", "course", "class", "university"]},
         {"key": "exam", "zh": "考试与评估", "seeds": ["exam", "test", "grade", "score", "assess", "qualify"]},
     ]},
    {"key": "work", "zh": "职场与经济", "en": "Work & Economy",
     "kw": ["工作", "职业", "就业", "商业", "经济", "公司", "市场", "金融", "管理", "雇佣", "薪", "投资"],
     "seeds": ["work", "job", "business", "economy", "company", "market", "manage", "employ", "finance", "industry"],
     "minors": [
         {"key": "career", "zh": "职业与就业", "seeds": ["job", "career", "employ", "salary", "interview", "promotion"]},
         {"key": "business", "zh": "商业与金融", "seeds": ["business", "market", "economy", "finance", "invest", "profit"]},
     ]},
    {"key": "health", "zh": "健康与医学", "en": "Health & Medicine",
     "kw": ["健康", "疾病", "医疗", "治疗", "医生", "药", "身体", "症状", "营养", "锻炼", "心理"],
     "seeds": ["health", "disease", "medical", "doctor", "treatment", "patient", "medicine", "body", "diet", "exercise"],
     "minors": [
         {"key": "illness", "zh": "疾病与治疗", "seeds": ["disease", "treatment", "patient", "medicine", "symptom", "cure"]},
         {"key": "lifestyle", "zh": "生活方式与营养", "seeds": ["diet", "exercise", "nutrition", "sleep", "habit", "fitness"]},
     ]},
    {"key": "society", "zh": "社会与文化", "en": "Society & Culture",
     "kw": ["社会", "文化", "传统", "政策", "公共", "群体", "媒体", "传播", "历史", "价值", "城市", "家庭"],
     "seeds": ["society", "culture", "tradition", "policy", "public", "community", "media", "history", "family", "urban"],
     "minors": [
         {"key": "policy", "zh": "社会与公共政策", "seeds": ["policy", "public", "government", "community", "society", "population"]},
         {"key": "culture", "zh": "文化与传播", "seeds": ["culture", "tradition", "media", "history", "art", "religion"]},
     ]},
    {"key": "mind", "zh": "心理与认知", "en": "Mind & Cognition",
     "kw": ["心理", "情绪", "态度", "认知", "思维", "记忆", "感觉", "意识", "动机", "注意"],
     "seeds": ["mind", "emotion", "attitude", "cognition", "memory", "think", "feel", "conscious", "motive", "attention"],
     "minors": [
         {"key": "emotion", "zh": "情绪与态度", "seeds": ["emotion", "attitude", "feel", "anxious", "happy", "fear"]},
         {"key": "cognition", "zh": "认知与思维", "seeds": ["memory", "think", "recognize", "reason", "logic", "perceive"]},
     ]},
    {"key": "people", "zh": "人际与沟通", "en": "People & Communication",
     "kw": ["人", "关系", "交流", "语言", "表达", "沟通", "朋友", "合作", "介绍", "讨论", "说"],
     "seeds": ["people", "relationship", "communicate", "language", "express", "friend", "cooperate", "discuss", "talk", "argue"],
     "minors": [
         {"key": "relation", "zh": "交往与关系", "seeds": ["friend", "relationship", "cooperate", "help", "trust", "conflict"]},
         {"key": "language", "zh": "语言与表达", "seeds": ["language", "express", "speak", "write", "translate", "meaning"]},
     ]},
    {"key": "time", "zh": "时间与变化", "en": "Time & Change",
     "kw": ["时间", "变化", "发展", "趋势", "增加", "减少", "开始", "结束", "持续", "阶段", "速度"],
     "seeds": ["time", "change", "develop", "trend", "increase", "decrease", "begin", "end", "continue", "period"],
     "minors": [
         {"key": "trend", "zh": "趋势与发展", "seeds": ["trend", "develop", "increase", "decline", "growth", "progress"]},
         {"key": "order", "zh": "顺序与因果", "seeds": ["begin", "end", "cause", "result", "order", "sequence"]},
     ]},
    {"key": "state", "zh": "行动与状态", "en": "Action & State",
     "kw": ["使", "进行", "状态", "程度", "性质", "通用"],
     "seeds": ["make", "take", "give", "become", "seem", "remain", "state", "action", "general", "quality"],
     "minors": [
         {"key": "general", "zh": "通用动词", "seeds": ["make", "take", "give", "become", "hold", "keep"]},
         {"key": "quality", "zh": "描述与程度", "seeds": ["good", "important", "large", "different", "possible", "general"]},
     ]},
]


def fibonacci_sphere(n: int, radius: float) -> list[tuple[float, float, float]]:
    pts = []
    golden = math.pi * (3.0 - math.sqrt(5.0))
    for i in range(n):
        y = 1 - (i / float(max(n - 1, 1))) * 2
        r = math.sqrt(max(0.0, 1 - y * y))
        theta = golden * i
        pts.append((math.cos(theta) * r * radius, y * radius, math.sin(theta) * r * radius))
    return pts


# 功能词没有语义指向，按向量相似度会被随机丢进某个大区（实测 "a" 落进了「气候与环保」）。
# 这些词在词表里是因为 ECDICT 给它们打了 cet4/cet6 标签，但把它们塞进情景大区只会污染星团。
FUNCTION_WORDS = {
    "a", "an", "the", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as", "into", "onto",
    "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done",
    "have", "has", "had", "will", "would", "shall", "should", "can", "could", "may", "might", "must",
    "and", "or", "but", "if", "so", "not", "no", "yes", "nor", "yet", "because", "while", "than",
    "it", "its", "this", "that", "these", "those", "he", "she", "they", "we", "you", "i",
    "me", "my", "your", "his", "her", "their", "our", "us", "them", "him", "mine", "yours",
    "who", "whom", "whose", "which", "what", "when", "where", "why", "how", "there", "here",
    "then", "too", "very", "just", "only", "also", "up", "down", "out", "off", "over", "under",
    "again", "more", "most", "some", "any", "all", "both", "each", "every", "other", "such",
    "own", "same", "one", "two", "first", "last", "next", "many", "much", "few", "little",
}
FALLBACK_MAJOR = "state"
FALLBACK_MINOR = "general"


def main() -> None:
    ensure_dirs()
    doc = read_json(DICT_JSON)
    rel = read_json(REL_JSON, {"edges": [], "satellites": []})
    umap3d = read_json(BUILD / "umap3d.json", {})
    index = read_json(BUILD / "vec300_index.json", [])
    mat = np.load(BUILD / "vec300.npy") if (BUILD / "vec300.npy").exists() else None
    if not doc:
        raise SystemExit("请先运行 parse_dict.py")
    if mat is None:
        raise SystemExit("请先运行 parse_vectors.py")

    vec = {w: mat[i] for i, w in enumerate(index)}
    norm = {w: (v / (np.linalg.norm(v) + 1e-9)) for w, v in vec.items()}

    def centroid(seeds: list[str]) -> np.ndarray | None:
        vs = [norm[s] for s in seeds if s in norm]
        if not vs:
            return None
        c = np.mean(vs, axis=0)
        return c / (np.linalg.norm(c) + 1e-9)

    for m in TAXONOMY:
        m["_c"] = centroid(m["seeds"])
        for mi in m["minors"]:
            mi["_c"] = centroid(mi["seeds"])

    words = doc["words"] + [dict(s, in_cet6=0, satellite=1) for s in rel.get("satellites", [])]
    assignment: dict[str, dict] = {}
    unassigned = 0
    func_words = 0
    for w in words:
        lemma = w["lemma"]
        if lemma in FUNCTION_WORDS:
            assignment[lemma] = {"major": FALLBACK_MAJOR, "minor": FALLBACK_MINOR}
            func_words += 1
            continue
        v = norm.get(lemma)
        text = (w.get("translation") or "") + (w.get("definition") or "")
        best, best_score = None, -9.9
        for m in TAXONOMY:
            score = 0.0
            if v is not None and m["_c"] is not None:
                score = float(np.dot(v, m["_c"]))
            kw_hits = sum(1 for k in m["kw"] if k and k in text)
            score += 0.22 * kw_hits
            if score > best_score:
                best, best_score = m, score
        if best is None:
            unassigned += 1
            best = TAXONOMY[-1]
        minor = None
        minor_score = -9.9
        for mi in best["minors"]:
            s = 0.0
            if v is not None and mi["_c"] is not None:
                s = float(np.dot(v, mi["_c"]))
            if s > minor_score:
                minor, minor_score = mi, s
        assignment[lemma] = {"major": best["key"], "minor": minor["key"]}

    log(f"  功能词归入「行动与状态/通用动词」: {func_words}")

    # ---- 坐标 ----
    major_centers = {m["key"]: np.array(p, dtype=np.float32)
                     for m, p in zip(TAXONOMY, fibonacci_sphere(len(TAXONOMY), MAJOR_RADIUS))}
    minor_centers: dict[tuple[str, str], np.ndarray] = {}
    for m in TAXONOMY:
        base = major_centers[m["key"]]
        n = len(m["minors"])
        for i, mi in enumerate(m["minors"]):
            ang = 2 * math.pi * i / max(n, 1)
            off = np.array([math.cos(ang), 0.35 * math.sin(ang), math.sin(ang)], dtype=np.float32) * MINOR_RADIUS
            minor_centers[(m["key"], mi["key"])] = base + off

    # 按子类统计成员，并给每个子类算一个「缩放到 base_r」的比例
    minor_members: dict[tuple[str, str], list[str]] = defaultdict(list)
    for lem in [x["lemma"] for x in words]:
        a = assignment[lem]
        minor_members[(a["major"], a["minor"])].append(lem)
    minor_scale: dict[tuple[str, str], float] = {}
    minor_centroid: dict[tuple[str, str], np.ndarray] = {}
    for key, members in minor_members.items():
        pts = [umap3d[m] for m in members if m in umap3d]
        base_r = SCEN_BASE * (len(members) ** SCEN_EXP)
        # 注意：参照点必须取「该子类在词向量空间里的质心」，
        # 不能拿世界坐标里的锚点 center 去减（两者不在同一个坐标系，
        # 减出来的偏移量会被整体推向原点，星团就缩成一个小结）。
        if len(pts) >= 3:
            arr = np.asarray(pts, dtype=np.float32)
            cen = arr.mean(axis=0)
            ref = float(np.percentile(np.linalg.norm(arr - cen, axis=1), 90)) or 1.0
        else:
            cen = np.zeros(3, dtype=np.float32)
            ref = 1.0
        minor_centroid[key] = cen
        minor_scale[key] = base_r / ref

    rng = np.random.default_rng(42)
    coords: dict[str, list[float]] = {}
    counts: dict[str, int] = defaultdict(int)
    for w in words:
        lemma = w["lemma"]
        a = assignment[lemma]
        counts[a["major"]] += 1
        center = minor_centers.get((a["major"], a["minor"]))
        if center is None:
            center = major_centers[a["major"]]
        local = umap3d.get(lemma)
        if local is not None:
            key = (a["major"], a["minor"])
            k = minor_scale.get(key, LOCAL_SCALE)
            cen = minor_centroid.get(key, np.zeros(3, dtype=np.float32))
            p = center + (np.array(local, dtype=np.float32) - cen) * k
        else:
            p = center + rng.normal(0, 12, 3).astype(np.float32)
        coords[lemma] = [round(float(p[0]), 2), round(float(p[1]), 2), round(float(p[2]), 2)]

    scen_out = {
        "majors": [{"key": m["key"], "zh": m["zh"], "en": m["en"],
                    "center": [round(float(c), 2) for c in major_centers[m["key"]]],
                    "count": counts[m["key"]],
                    "minors": [{"key": mi["key"], "zh": mi["zh"],
                                "center": [round(float(c), 2) for c in minor_centers[(m["key"], mi["key"])]]}
                               for mi in m["minors"]]}
                   for m in TAXONOMY],
        "assignment": assignment,
    }
    write_json(SCEN_JSON, scen_out)
    write_json(VEC_JSON, coords)
    log(f"情景归类完成，未命中向量而随机落位的词: {unassigned}")
    for m in TAXONOMY:
        log(f"  {m['zh']:<8} {counts[m['key']]:>5} 词")
    log(f"写出 {SCEN_JSON} / {VEC_JSON}")


if __name__ == "__main__":
    main()
