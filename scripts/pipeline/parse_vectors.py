"""词向量 -> 3D 坐标。

为避开重依赖（本机 pip 走境外源很慢），这里：
  - 用 pickle 存根直接读 gensim 的 KeyedVectors 文件，不装 gensim
  - 优先用 UMAP；没有 UMAP 就用 numpy 实现的谱嵌入（kNN 图 + 归一化拉普拉斯特征映射）

输入: data/raw/glove-wiki-gigaword-50.model(.vectors.npy) 或 data/raw/glove.6B.zip
      data/build/dictionary.json, relations.json
输出: data/build/vec300.npy, data/build/vec300_index.json, data/build/umap3d.json
"""
from __future__ import annotations

import pickle
import sys
import types
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    BUILD, DICT_JSON, GLOVE_ZIP, REL_JSON, RAW, ensure_dirs, log, norm_word, read_json, write_json,
)

GENSIM_MODEL = RAW / "glove-wiki-gigaword-50.model"
KNN = 15


class _AnyStub:
    def __init__(self, *a, **k):
        pass

    def __setstate__(self, state):
        if isinstance(state, tuple) and len(state) == 2 and isinstance(state[1], dict):
            self.__dict__.update(state[1])
        elif isinstance(state, dict):
            self.__dict__.update(state)

    def __reduce__(self):
        return (_AnyStub, ())


class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        return _AnyStub


def _install_gensim_stubs() -> None:
    for name in ("gensim", "gensim.models", "gensim.models.keyedvectors"):
        if name not in sys.modules:
            sys.modules[name] = _StubModule(name)


def load_from_gensim_file(wanted: set[str]) -> dict[str, np.ndarray]:
    _install_gensim_stubs()
    with open(GENSIM_MODEL, "rb") as fh:
        obj = pickle.load(fh)
    d = obj.__dict__
    index_to_key = d.get("index_to_key") or d.get("index2word") or []
    npy = Path(str(GENSIM_MODEL) + ".vectors.npy")
    if not npy.exists():
        return {}
    mat = np.load(npy, mmap_mode="r")
    log("  词表 " + str(len(index_to_key)) + " 词, 向量 " + str(mat.shape))
    out: dict[str, np.ndarray] = {}
    for i, w in enumerate(index_to_key):
        w = norm_word(w)
        if w in wanted:
            out[w] = np.asarray(mat[i], dtype=np.float32)
    return out


def load_from_zip(wanted: set[str], dim: int = 300) -> dict[str, np.ndarray]:
    if not GLOVE_ZIP.exists():
        return {}
    out: dict[str, np.ndarray] = {}
    with zipfile.ZipFile(GLOVE_ZIP) as zf:
        name = next((m for m in zf.namelist() if m.endswith(str(dim) + "d.txt")), None)
        if not name:
            return {}
        log("  读取 zip 内 " + name)
        with zf.open(name) as fh:
            for raw in fh:
                parts = raw.decode("utf-8", "replace").rstrip().split(" ")
                w = norm_word(parts[0])
                if w not in wanted:
                    continue
                try:
                    out[w] = np.asarray(parts[1:1 + dim], dtype=np.float32)
                except ValueError:
                    continue
                if len(out) >= len(wanted):
                    break
    return out


def _sym_mv(x: np.ndarray, rows, cols, vals, dm) -> np.ndarray:
    """归一化图矩阵 N = D^-1/2 W D^-1/2 与矩阵的乘积（W 对称，边表形式）。"""
    z = x * dm[:, None]
    y = np.zeros_like(z)
    np.add.at(y, rows, vals[:, None] * z[cols])
    np.add.at(y, cols, vals[:, None] * z[rows])
    y *= 0.5
    return y * dm[:, None]


def spectral_3d(x: np.ndarray, k: int = KNN, iters: int = 60, seed: int = 42) -> np.ndarray:
    """kNN 图 + 归一化拉普拉斯的谱嵌入。

    用稀疏边表 + 子空间迭代（numpy），避免 dense eigh 的 O(n^3) 与 O(n^2) 内存。
    """
    n = x.shape[0]
    xn = x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)
    kk = max(1, min(k, n - 1))
    idx = np.empty((n, kk), dtype=np.int64)
    val = np.empty((n, kk), dtype=np.float32)
    block = 512
    for s in range(0, n, block):
        e = min(n, s + block)
        sim = xn[s:e] @ xn.T
        for r in range(e - s):
            sim[r, s + r] = -np.inf
        part = np.argpartition(-sim, kk - 1, axis=1)[:, :kk]
        idx[s:e] = part
        val[s:e] = np.take_along_axis(sim, part, axis=1)
    val = np.maximum(val, 0.0)
    rows = np.repeat(np.arange(n), kk)
    cols = idx.ravel()
    vals = val.ravel()
    deg = np.zeros(n, dtype=np.float64)
    np.add.at(deg, rows, vals)
    np.add.at(deg, cols, vals)
    dm = 1.0 / np.sqrt(np.maximum(deg, 1e-9))

    rng = np.random.default_rng(seed)
    q = 5
    x0 = rng.standard_normal((n, q)).astype(np.float64) * dm[:, None]
    for _ in range(iters):
        x0 = _sym_mv(x0, rows, cols, vals, dm)
        x0, _ = np.linalg.qr(x0)
    # Rayleigh-Ritz：把收敛后的子空间旋转回真正的特征向量基
    y = _sym_mv(x0, rows, cols, vals, dm)
    b = x0.T @ y
    w, v = np.linalg.eigh(b)
    order = np.argsort(-w)
    xr = x0 @ v[:, order]
    take = [1, 2, 3]                         # 跳过平凡特征向量
    emb = xr[:, take] * dm[:, None]
    return np.asarray(emb, dtype=np.float32)


def main() -> None:
    ensure_dirs()
    doc = read_json(DICT_JSON)
    rel = read_json(REL_JSON, {"edges": [], "satellites": []})
    if not doc:
        raise SystemExit("请先运行 parse_dict.py")

    vocab = [w["lemma"] for w in doc["words"]]
    vocab += [s["lemma"] for s in rel.get("satellites", []) if s.get("lemma")]
    vocab = list(dict.fromkeys(vocab))
    log("需要向量的词: " + str(len(vocab)))

    vectors: dict[str, np.ndarray] = {}
    if GENSIM_MODEL.exists():
        log("使用 glove-wiki-gigaword-50（直接读 KeyedVectors 文件）")
        vectors = load_from_gensim_file(set(vocab))
    if not vectors:
        log("回退到 Stanford glove.6B.zip")
        vectors = load_from_zip(set(vocab))

    index = [w for w in vocab if w in vectors]
    log("命中 " + str(len(index)) + " / " + str(len(vocab)))
    if len(index) < 50:
        raise SystemExit("命中的词向量太少，无法完成降维")

    mat = np.vstack([vectors[w] for w in index]).astype(np.float32)
    np.save(BUILD / "vec300.npy", mat)
    write_json(BUILD / "vec300_index.json", index)

    emb = None
    try:
        import umap  # type: ignore
        from sklearn.decomposition import PCA  # type: ignore
        reduced = PCA(n_components=int(min(30, mat.shape[1], mat.shape[0] - 1)), random_state=42).fit_transform(mat)
        emb = umap.UMAP(n_components=3, n_neighbors=max(5, min(15, len(index) - 1)),
                        min_dist=0.15, metric="cosine", random_state=42, verbose=False).fit_transform(reduced)
        log("  降维方法: UMAP")
    except Exception as exc:  # noqa: BLE001
        # numpy SVD 做 PCA 取前 3 个主成分。
        # 实测（38 个语义簇词，真实 glove-wiki-gigaword-50）：
        #   airport -> terminal, passenger, runway, airline, flight, pilot
        #   doctor  -> nurse, medicine, surgery, clinic, patient, hospital
        #   however -> although, consequently, therefore, nevertheless, whereas
        # 邻域语义连贯，因此作为无重依赖时的默认降维方式。
        log("  UMAP/sklearn 不可用（" + type(exc).__name__ + "），改用 numpy SVD 三维")
        x = mat - mat.mean(axis=0, keepdims=True)
        x = x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)
        u, s, _vt = np.linalg.svd(x, full_matrices=False)
        emb = (u[:, :3] * s[:3]).astype(np.float32)
    emb = np.asarray(emb, dtype=np.float32)

    emb -= emb.mean(axis=0, keepdims=True)
    scale = float(np.abs(emb).max()) or 1.0
    emb = emb / scale * 100.0

    coords = {w: [round(float(v[0]), 3), round(float(v[1]), 3), round(float(v[2]), 3)]
              for w, v in zip(index, emb)}
    write_json(BUILD / "umap3d.json", coords)
    log("写出 " + str(BUILD / "umap3d.json") + "  (" + str(len(coords)) + " 点)")


if __name__ == "__main__":
    main()
