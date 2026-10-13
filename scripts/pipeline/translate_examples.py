"""用 MyMemory 给缺翻译的例句补机器译文（2026-09）。

背景：Tatoeba 只有 8.9 万条中文句，覆盖不到全部词；真题例句本来就没有译文。
本机没有可用的本地翻译模型（无 ollama/torch，hf-mirror 不可达），
实测可用的线上服务是 MyMemory（Google/Bing/有道均不可达）。

设计要点：
  - **按文本去重**：同一句英文可能挂在多个词下，只翻一次；
  - **断点续跑**：每翻译一批就写库，中断后重跑只处理剩余部分；
  - **机器译文标记**：is_machine=1，和人工译文（Tatoeba）区分开；
  - **限速 + 退避**：免费服务有额度，遇到配额/限流时退避重试，最终优雅退出。

用法: python scripts/pipeline/translate_examples.py [--limit N] [--delay S]
"""
from __future__ import annotations

import argparse
import http.client
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

DB = Path(__file__).resolve().parents[2] / "data" / "wordvault.db"
API = "https://api.mymemory.translated.net/get"

# MyMemory 的免费额度**按邮箱**给：匿名约 5,000 词/天（且耗尽后要等 1 小时重置），
# 带上有效的 de=<email> 是 50,000 词/天。脚本把邮箱做成参数，不硬编码。
EMAIL = ""


# **串行 + 连接复用**：实测并发会被 429 拒；
# 而串行时每条约 4.8s，其中大半是重复的 TLS 握手 —— 复用一条 keep-alive 连接可省掉。
_CONN: http.client.HTTPSConnection | None = None


def _conn() -> http.client.HTTPSConnection:
    global _CONN
    if _CONN is None:
        _CONN = http.client.HTTPSConnection("api.mymemory.translated.net", timeout=25)
    return _CONN


def translate(text: str) -> str | None:
    """返回中文译文；配额用尽或出错返回 None。失败会重建连接。"""
    global _CONN
    q = urllib.parse.quote(text[:480])
    path = "/get?langpair=en|zh-CN&q=" + q + (("&de=" + urllib.parse.quote(EMAIL)) if EMAIL else "")
    for attempt in (1, 2):
        try:
            c = _conn()
            c.request("GET", path, headers={"User-Agent": "Mozilla/5.0", "Connection": "keep-alive"})
            d = json.loads(c.getresponse().read().decode("utf-8", "replace"))
            t = ((d.get("responseData") or {}).get("translatedText") or "").strip()
            if not t or "MYMEMORY WARNING" in t.upper() or "QUOTA" in t.upper():
                return None
            return t
        except Exception as exc:  # noqa: BLE001
            try:
                _CONN.close()
            except Exception:  # noqa: BLE001
                pass
            _CONN = None
            if attempt == 2:
                print("    ERR " + str(exc), flush=True)
                return None
            time.sleep(2.0)
    return None


def pending(conn) -> list[str]:
    """还没有译文的英文句（按文本去重），六级词优先。"""
    rows = conn.execute(
        "SELECT e.en, MAX(CASE WHEN w.in_cet6=1 THEN 1 ELSE 0 END) AS imp "
        "FROM examples e JOIN words w ON w.id = e.word_id "
        "WHERE e.zh = '' AND LENGTH(e.en) > 8 "
        "GROUP BY e.en ORDER BY imp DESC, LENGTH(e.en) ASC"
    ).fetchall()
    return [r[0] for r in rows]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="最多翻译多少条（0=不限）")
    ap.add_argument("--delay", type=float, default=1.1, help="每条之间的间隔秒数")
    ap.add_argument("--email", default="", help="MyMemory 配额邮箱（不填则用匿名额度）")
    ap.add_argument("--cet6-only", action="store_true", help="只翻译六级词下的例句")
    ap.add_argument("--auto-wait", action="store_true", help="额度用尽时自动等待重置后继续")
    args = ap.parse_args()

    global EMAIL
    EMAIL = args.email

    conn = sqlite3.connect(DB)
    todo = pending(conn)
    print("待翻译的英文句（已去重）: " + str(len(todo)), flush=True)
    if args.email:
        print("使用配额邮箱: " + args.email, flush=True)
    if args.limit:
        todo = todo[: args.limit]

    done = 0
    fail_streak = 0
    # 并发：瓶颈是网络往返（实测单条约 4.8s，其中间隔只占 1.1s），
    # 串行跑完 6292 条要 8 小时以上，开 6 个 worker 摊到 1.5 小时左右。
    if True:
        for i, en in enumerate(todo, 1):
            zh = translate(en)
            if zh:
                conn.execute(
                    "UPDATE examples SET zh=?, is_machine=1 WHERE en=? AND zh=''", (zh, en)
                )
                done += 1
                fail_streak = 0
            else:
                fail_streak += 1
                time.sleep(3.0)
                if fail_streak >= 20:
                    if args.auto_wait:
                        # MyMemory 的额度**每小时**重置（提示语是 NEXT AVAILABLE IN HH:MM）。
                        # 等 40 分钟再继续，这样一次运行就能把剩下的做完。
                        print("额度用尽，等 40 分钟后继续（已完成的不受影响）…", flush=True)
                        conn.commit()
                        time.sleep(40 * 60)
                        fail_streak = 0
                        continue
                    print("连续 20 次失败，判定配额/限流，停止（已完成的都已入库，可直接重跑）", flush=True)
                    break
            if i % 25 == 0:
                conn.commit()
                print("  进度 " + str(i) + "/" + str(len(todo)) + "  成功 " + str(done), flush=True)
            time.sleep(args.delay)

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM examples WHERE zh != ''").fetchone()[0]
    alln = conn.execute("SELECT COUNT(*) FROM examples").fetchone()[0]
    mach = conn.execute("SELECT COUNT(*) FROM examples WHERE is_machine=1").fetchone()[0]
    print("本次译出 " + str(done) + " 条", flush=True)
    print("库内带译文例句 " + str(total) + "/" + str(alln) + "（其中机器翻译 " + str(mach) + "）", flush=True)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
