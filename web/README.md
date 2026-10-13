# 词穹 WordVault · Web 前端

Vite + React 18 + TypeScript + three.js + zustand。深色星空风格的六级词汇关系词典。

## 运行

```bash
npm install --registry https://registry.npmmirror.com
npm run dev      # 开发服务器 http://127.0.0.1:5173 ，/api 代理到 http://127.0.0.1:8787
npm run build    # 产出 dist/（类型检查 + 打包），后端会直接托管 dist
npm run preview  # 预览 dist/
```

后端未启动时界面不会白屏：顶栏出现「后端未启动」提示条，星空区显示空态，可点「重连」重试。

## 分级交互（核心）

| 层级 | 画面 | 进入下一级 |
| --- | --- | --- |
| level 0 全景 | 全部星点压暗缩小当底纹，10 个大区标签浮在星团中心（中文名 · 词数） | 点大区标签或大区星团 |
| level 1 大区 | 相机飞向该大区，其它大区淡到极暗，出现 2 个子类标签 | 点子类标签或本大区星团 |
| level 2 子类 | 本子类的单词星清晰点亮，lit 词与词频最高的词显示词形标签（上限 30 个） | 点单词 |
| level 3 | 右侧滑出词条面板（八维度详情，结构未变） | — |

- 顶部面包屑 `星空 › 大区 › 子类 › 单词`，每一级可点回退；`Esc` 或点空白返回上一级（先关面板再退层）。
- 搜索仍然直达：选中结果后自动展开它所在的大区/子类、相机飞过去并打开右侧面板。
- 相机记忆：level 0 的全景视角存在 localStorage（`wv.cam.pano.v2`），回到全景时恢复。

## 清晰化做法

1. **星点**：自定义 ShaderMaterial，片元里画硬边圆 —— `a = 1 - smoothstep(0.5-uFeather, 0.5, d)`，
   `uFeather ≈ 1 设备像素 / 点的像素尺寸`，核心不透明、只有约 1px 过渡；**彻底删除了 glowTexture 与 nebulaTexture**，
   不再有任何径向渐变贴图叠加。
2. **尺寸用像素控制**：`gl_PointSize = clamp(aSize * uPx * att, uMinPx, uMaxPx) * uDPR`，
   其中 `att = clamp(uRefDist / -mvPosition.z, 0.7, 1.4)`，uRefDist 每帧取当前相机半径，远近都保持锐利。
   lit 词的强调改成「更大（×1.28）+ 更亮（×1.22）」，不再用光晕。
3. **DPR**：`setPixelRatio(min(devicePixelRatio, 2))`，resize 与 DPR 变化（拖到另一块屏）都会同步画布尺寸。
   全景（level 0）额外把星点提亮到 1.45×、最小 2px，并加一层**解析式簇晕**（billboard 四边形 + 片元里按到簇心的距离算
   `pow(1-d, 2.6)` 衰减，加法混合画在星点下层）——让「星团」有体积感，而不是靠贴图光晕。
4. **标签**：canvas 按 3 倍字号绘制，`minFilter = LinearFilter`、`generateMipmaps = false`，
   用 `sizeAttenuation = false` 的 Sprite 保持恒定屏幕像素大小（19/15.5/12px），所以文字始终按屏幕像素对齐，不糊。
5. **连线**：WebGL 的 `linewidth` 无效，改成屏幕空间加宽的四边形（顶点着色器里按 `uHalfWidth/uResolution` 法向偏移），
   半宽 0.75 CSS 像素，配 antialias，得到干净的 ~1.5px 细线。

## 视觉编码

- 亮度/色温 = strength。**亮度下限 0.55、上限 1.0**（strength=0 → 暗但清楚，strength=1 → 明亮白蓝），
  strength=0 时色相往"高亮冷玫瑰/紫"偏 35%（不用深红），最后再兜一个中性暗星色下限 `(0.34, 0.30, 0.38)`；
  卫星星 ×0.75，lit ×1.18。
- **颜色是「直写」的**：星点着色器不做 sRGB 输出编码，所以 `rawHex()` 存进去的值就是屏幕上的值，
  10 个大区色相的 sRGB 相对亮度都在 0.63 以上（挑过一轮，确保和 #05060c 背景对比充足）。
- 大小 = frq（越小越常用越大；frq=0 取中等；卫星星 ×0.74，lit ×1.28）
- 悬停：放大到 2 倍 + 冷白细环；选中：金色环常亮（都在一个 2 顶点的 Points 里用片元画实心核 + 细环，没有贴图）
- 颜色 = 情景大类（10 类 10 个高区分度色相，按 /api/sky 的大类顺序分配）
- 可见度 = 当前层级（level 0 全部 0.6；level 1 本大区 1 / 其它 0.045；level 2 本子类 1 / 同大区其它子类 0.1 / 其它 0.03）

## 接口

只用 `server/src/index.js` 已实现的接口：/api/health、/sky、/graph、/word/:lemma、/search、/stats、
/assessment、/assessment/submit、/review/queue、/review/submit、/export/csv。前端没有任何内置/伪造数据。

- 全量关系边：打开图层开关时拉一次 `GET /api/graph`（level ≥ 1 时带 `major` 收窄，level 2 再按子类在本地裁剪）；
  同一个大区不会重复请求。上限 26000 条线段，超出会在 HUD 标注；全量模式线透明度为聚焦模式的 42%。
- 聚焦边：点击某颗星仍走 `GET /api/word/:lemma`，与全量边相互独立。

## 目录

```
src/
  api.ts            接口封装（超时、BackendDownError、HttpError）
  store.ts          zustand 全局状态（星空、分级 level/major/minor、选中词、图层、全量边）
  types.ts          与后端 JSON 一一对应的类型
  lib/              speech（TTS）、format（格式化/字典）
  three/
    SkyView.tsx     星空：硬边星点、场景内标签、聚焦边、全量边、三大层级
    controls.ts     自实现的轨道相机（拖拽旋转、滚轮/双指缩放、阻尼、飞行）
    starfield.ts    视觉编码、几何构建、标签贴图、屏幕空间加宽连线
  components/       顶栏、面包屑、搜索、词条面板、复习、统计、初始自评、提示条
```
