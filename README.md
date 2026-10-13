# 词穹 · WordVault

一个自用为主、可分享给同学的网页版**六级词汇关系词典**。

每个单词是一颗星；词与词之间的关系分三层绑定：

| 层 | 数据来源 | 视觉 |
|---|---|---|
| 同情景常用词 / 表达 | 六级真题话题（大区 + 子类）+ KyleBing 词组 | 星座内橙黄色连线 |
| 同义 / 近义 / 反义 | WordNet（含 OMW 中文词面） | 青蓝色边，反义为红 |
| 词根词缀 | MorphoLex-en + WordNet 派生关系 | 跨天区的紫色弧线 |

**星光亮度 = 记忆强度**：复习一次就变亮，久不复习就变暗。

## 它长什么样

| 全景（情景分区） | 词根家族 |
|---|---|
| ![全景](docs/screenshots/V1-L0.png) | ![词根](docs/screenshots/A2-L0-root.png) |

| 进入星团（子类层） | 搜索与词条面板 |
|---|---|
| ![子类层](docs/screenshots/A6-L1-cluster.png) | ![搜索](docs/screenshots/B1-search.png) |

> 更多截图见 `docs/screenshots/` 与 `docs/verify/`。

需求基线见 [需求基线.md](docs/需求基线.md)，实际实现与需求之间的差异见 [实现说明与偏差记录.md](docs/实现说明与偏差记录.md)。

> **接手本项目请先读 [接续说明.md](docs/接续说明.md)** —— 里面写了：怎么跑起来、数据规模、哪些已验证、**两个已定位待修的交互 bug 及其精确复现步骤**、验收方法论（含几个"看似合理但会把画面调坏"的坏指标）、以及调试工具（HUD 诊断字段 / URL 参数 / 无头验证脚本 / 录屏抽帧）。

---

## 当前状态（已实测）

| 项 | 数值 |
|---|---|
| 入库词条 | 26,608（其中六级词 6,035，词表外卫星 11,372） |
| 首期点亮 | 500 词（真题词汇表优先，ECDICT 词频补足） |
| 关系边 | 121,612 条（语义 37,275 / 形态 42,464 / 情景 41,873） |
| 词条义项 | 61,328 |
| 例句 | 13,738（真题 11,912 + Tatoeba 中英对照 1,832） |
| 星相（布局） | 5 套（情景/词根/前缀/后缀/语义场），每套覆盖全部 26,608 词 |
| 搭配词块 | 52,323 |
| OMW 中文词面 | 36,816 |
| 有词根分解的词 | 21,967（首期 500 词 100% 覆盖） |
| 离线微题 | 2,871 |
| 首期 500 词的排序依据 | **真实真题词频**（62 个 docx 真题正文，已排除中考/高考级基础词） |
| 数据库 | data/wordvault.db（28.6 MB） |

已实测通过（真实数据库 + 真实浏览器）：

- 后端全部接口：/api/health、/api/sky、/api/scenarios、/api/word/:lemma、/api/search（含中文反查）、/api/graph、/api/assessment、/api/assessment/submit、/api/review/queue、/api/review/submit、/api/stats、/api/export/csv
- 复习闭环：到期 500 → 取词 → 词义/拼写/搭配三题 → 提交正确升到 L1、strength 0.21、次日到期；提交错误 strength 0.05、错误类型记为 spelling；统计与 CSV 同步
- 星空渲染：26,608 颗星、10 个情景大区、headless Edge（swiftshader）实测 25 fps、零控制台报错，截图见 docs/verify/sky-real-2.png

---

## 目录结构

    wordvault/
    ├── data/            下载的原始数据 + 生成的 SQLite（.gitignore 已排除）
    ├── docs/            需求基线、实现说明、验收截图
    ├── scripts/         数据管线（Python）+ 下载脚本（PowerShell）
    ├── server/          Express + Node 内置 sqlite 后端
    └── web/             React + TypeScript + three.js 前端

## 快速开始

    # 1. 安装依赖（后端 + 前端）
    powershell -ExecutionPolicy Bypass -File setup.ps1

    # 2. 生成数据（首次约 10-20 分钟，取决于网络；可重复运行）
    powershell -ExecutionPolicy Bypass -File scripts\run_pipeline.ps1

    # 3. 启动
    powershell -ExecutionPolicy Bypass -File start.ps1

浏览器打开 http://127.0.0.1:8787 。

如果不跑 setup.ps1，也可以只做数据部分（管线只需要 numpy + pandas，不需要额外安装）：

    python scripts\pipeline\run_all.py      # 依次跑 6 个步骤，约 25 秒

## 数据来源与许可

> ⚠️ **本仓库不含任何第三方数据**（`.gitignore` 已排除 `data/raw/` 与 `data/*.db`）。
> 运行前需自行执行 `scripts/` 下的下载脚本获取。**各数据源有各自的许可证，均不适用本项目的 MIT。**
> 下表列出各项的许可状态，使用前请自行核对原始出处。

| 数据 | 来源 | 用在哪 | 许可（请自行核对原始出处） |
|---|---|---|---|
| 释义 / 音标 / 词性 / 词频 / 词形变化 | ECDICT（770,611 条） | 义项、声音、词形 | 见 ECDICT 仓库（skywind3000/ECDICT） |
| 六级词表 + 词组 | KyleBing/english-vocabulary | 词表底座、搭配 | 见原仓库 |
| 构词分解 | MorphoLex-en | 词根词缀层 | 学术用途，见原出处 |
| 同义 / 反义 / 派生 | WordNet 3.0 | 语义层、形态层 | WordNet License（BSD 风格） |
| 中文词面 | Open Multilingual WordNet 1.4 | 中文反查 | 见 OMW 说明 |
| 音素 | CMUdict | 发音 | BSD 风格 |
| 词向量 | glove-wiki-gigaword-50 | 星空坐标 | 公有领域（GloVe 声明） |
| **中英对照例句** | **Tatoeba**（英文 203 万句 / 中文 8.9 万句） | 中英对照例句 | **CC-BY 2.0 FR，要求署名** |
| 真题语料 | YinsinSirius/CET6-Resources | 真题词频、真题例句 | ⚠️ **第三方转载的历年真题，版权归原考试机构，不属于开源数据** |

**语法行为 / 语域与语用 / 概念与指代**三项没有开源数据源，由 scripts/pipeline/gen_dims.py 调用 DeepSeek 生成（只覆盖首期 500 词），前端展示时标注「机器生成」；没有 key 时字段留空，显示「待补充」，不伪造内容。

例句有两类来源，前端可区分：

- **人工中英对照**（Tatoeba，18,728 条）—— 真实人工翻译；
- **机器翻译**（`examples.is_machine = 1`）—— 用 MyMemory 免费接口给没有译文的英文句补的翻译，
  脚本见 `scripts/pipeline/translate_examples.py`，**可断点续跑**。

## 许可证

本项目**代码**采用 [MIT](LICENSE)。

**第三方数据不在 MIT 覆盖范围内**，且本仓库不包含它们（见上一节）。
其中 **Tatoeba 采用 CC-BY 2.0 FR，公开使用需署名**；
**历年真题语料版权归原考试机构**，请勿公开再分发。

## 学习机制

- **初始自评**：60 题（按词频分层抽样），按正确率回推初始掌握度。
- **间隔规则表**：1 / 2 / 4 / 7 / 15 / 30 天阶梯，答对升一级，**答错退一级**；到达最高级仍以低频率出现。
- **每次复习记录**：对错 + 用时 + 错误类型（拼写 / 义项 / 搭配 / 听音 / 语域）。
- **错误类型决定下次题型**：拼写错多排拼写，听音错多排听音，义项错多排辨析。
- 每批 20 个词，做完询问是否继续。
- 进度可导出 CSV（/api/export/csv）。

## 环境

- Python 3.12（数据管线只需要 numpy + pandas；本机用 uv 管理的 CPython 3.12.10 验证）
- Node 22.5+（后端用 Node 内置 node:sqlite，无需原生编译）；实测 Node v24.21.0
- Windows（下载脚本是 PowerShell）；其他平台可手动把数据放进 `data/raw/` 后直接跑管线
- 若你所在网络访问 GitHub 原始文件受限，下载脚本支持走系统代理
- 可选依赖 `opencc-python-reimplemented`（繁简转换）；缺失时管线会跳过转换，不影响运行
