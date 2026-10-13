import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useWV } from '../store';
import type { SearchResult } from '../types';

export default function SearchBox() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openWord = useWV((s) => s.openWord);
  const selected = useWV((s) => s.selected);

  // 当前词变了（关系跳转 / 切换星相 / 面板里复制）就同步搜索框：
  // 否则跳转后框里还留着上一个词，容易误以为还在看它。用户正在输入时不打扰。
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    setQ(selected || '');
    setOpen(false);
  }, [selected]);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setRows([]);
      setOpen(false);
      setErr('');
      return;
    }
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      api
        .search(term, 30)
        .then((r) => {
          if (!alive) return;
          setRows(r.results);
          setOpen(true);
          setErr('');
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setRows([]);
          setErr(e instanceof Error ? e.message : String(e));
          setOpen(true);
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 220);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // 直接定位：自动展开它所在的大区/子类，相机飞过去并打开右侧面板
  const jump = (r: SearchResult) => {
    openWord(r.lemma);
    setOpen(false);
  };

  return (
    <div className="search" ref={boxRef}>
      <input
        ref={inputRef}
        className="search-input"
        value={q}
        placeholder="搜索英文或中文（如 abandon / 放弃）"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => rows.length && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && rows.length) jump(rows[0]);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {busy ? <span className="search-busy">…</span> : null}
      {open ? (
        <div className="search-drop">
          {err ? <div className="search-empty">搜索失败：{err}（后端未启动？）</div> : null}
          {!err && rows.length === 0 ? <div className="search-empty">没有匹配的词</div> : null}
          {rows.map((r) => (
            <button key={r.id} className="search-row" onClick={() => jump(r)}>
              <span className="search-lemma">{r.lemma}</span>
              <span className="search-zh">{r.translation}</span>
              <span className="search-tag">{r.scenario_major || '未分类'}</span>
              {r.lit ? <span className="search-lit">已点亮</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
