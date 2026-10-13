"""一次性跑完整条数据管线。"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = [
    ("解析词典（ECDICT + KyleBing）", "parse_dict.py"),
    ("生成三层关系 + 卫星星", "parse_relations.py"),
    ("真题语料 -> 词频与例句", "parse_exam.py"),
    ("词向量 -> UMAP 3D", "parse_vectors.py"),
    ("情景归类 + 最终坐标", "scenarios.py"),
    ("多星相布局（词根/词缀/语义场）", "parse_layouts.py"),
    ("装配 SQLite", "build_db.py"),
]


def main() -> None:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    t0 = time.time()
    for label, script in STEPS:
        if only and only not in script:
            continue
        print(f"\n===== {label} ({script}) =====", flush=True)
        r = subprocess.run([sys.executable, str(HERE / script)], cwd=str(HERE.parent.parent))
        if r.returncode != 0:
            raise SystemExit(f"步骤失败: {script} exit={r.returncode}")
    print(f"\n全部完成，用时 {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
