"""用模型补齐三个无开源数据的维度：语法行为 / 语域与语用 / 概念与指代。

这三个维度没有开源数据源（见 docs/需求基线.md 第 3 节），因此全部标注为机器生成。
只处理首期点亮的 500 词，可断点续跑。

输入: data/build/dictionary.json, data/build/exam.json
输出: data/build/gen_dims.json
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BUILD, DICT_JSON, EXAM_JSON, ensure_dirs, log, read_json, write_json,
)

KEY_FILE = Path("D:/AI/api_key/api_key.txt")
OUT = BUILD / "gen_dims.json"
BATCH = 15
ENDPOINT = "https://api.deepseek.com/v1/chat/completions"
MODEL = "deepseek-chat"

SYSTEM = (
    "你是英语词汇教学助手。对每个给定单词，用简体中文给出三项信息，每项不超过 40 字："
    "syntax（常见语法行为：接什么成分、常用句型）、"
    "register（语域与语用：正式度、礼貌度、常见使用场合）、"
    "concept（概念与指代：所指对象的确切范围或容易混淆的相近概念）。"
    "只输出 JSON 数组，每个元素形如 {\"word\":\"...\",\"syntax\":\"...\",\"register\":\"...\",\"concept\":\"...\"}。"
    "不确定就写「不确定」，不要编造。"
)


def load_key() -> str:
    if not KEY_FILE.exists():
        return ""
    for line in KEY_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip().lower().startswith("deepseek") and not line.strip().lower().startswith("deepseek code"):
            m = re.search(r"(sk-[A-Za-z0-9_\-]+)", line)
            if m:
                return m.group(1)
    m = re.search(r"(sk-[A-Za-z0-9_\-]+)", KEY_FILE.read_text(encoding="utf-8", errors="replace"))
    return m.group(1) if m else ""


def call(api_key: str, words: list[str], retries: int = 3) -> list[dict]:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": "单词列表：" + ", ".join(words)},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
    )
    last = None
    for i in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            content = body["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                for v in parsed.values():
                    if isinstance(v, list):
                        parsed = v
                        break
            return parsed if isinstance(parsed, list) else []
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2 + i * 3)
    log(f"    批次失败: {last}")
    return []


def main() -> None:
    ensure_dirs()
    doc = read_json(DICT_JSON)
    exam = read_json(EXAM_JSON, {"lit": []})
    if not doc:
        raise SystemExit("请先运行 parse_dict.py")
    lit = exam.get("lit") or [w["lemma"] for w in doc["words"] if w.get("in_cet6")][:500]

    api_key = load_key()
    if not api_key:
        log("未找到可用的 DeepSeek key，跳过主观维度生成（字段将留空，界面显示「待补充」）")
        write_json(OUT, {"generated": 0, "items": {}})
        return

    done = read_json(OUT, {"items": {}}).get("items", {})
    todo = [w for w in lit if w not in done]
    log(f"待生成 {len(todo)} / {len(lit)} 词")

    for i in range(0, len(todo), BATCH):
        chunk = todo[i:i + BATCH]
        log(f"  批次 {i // BATCH + 1}: {len(chunk)} 词")
        for item in call(api_key, chunk):
            if not isinstance(item, dict):      # 模型偶尔会返回字符串数组
                continue
            w = str(item.get("word", "")).strip().lower()
            if not w:
                continue
            done[w] = {
                "syntax": str(item.get("syntax", ""))[:200],
                "register": str(item.get("register", ""))[:200],
                "concept": str(item.get("concept", ""))[:200],
                "machine": True,
            }
        write_json(OUT, {"generated": len(done), "items": done, "model": MODEL})
        time.sleep(0.5)

    log(f"完成，共 {len(done)} 词 -> {OUT}")


if __name__ == "__main__":
    main()
