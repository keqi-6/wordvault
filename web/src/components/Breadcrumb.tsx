// 顶部分级面包屑：星空 / 大区 / 子类，每一级可点回退；下方挂一张悬停词条小卡
import { useEffect } from 'react';
import { firstLine } from '../lib/format';
import { useWV } from '../store';

/** 悬停小卡：贴在面包屑下方，只用 /api/sky 已有的释义，音标按需请求并缓存 */
function HoverCard() {
  const lemma = useWV((s) => s.hoverLemma);
  const star = useWV((s) => (s.hoverLemma ? s.starByLemma[s.hoverLemma] : undefined));
  const detail = useWV((s) => (s.hoverLemma ? s.details[s.hoverLemma] : undefined));
  const loadDetail = useWV((s) => s.loadDetail);

  useEffect(() => {
    if (!lemma) return;
    // 悬停 260ms 之后才按需取完整词条（含音标），结果进 store 缓存，不会每个悬停都发请求
    const t = window.setTimeout(() => void loadDetail(lemma), 260);
    return () => window.clearTimeout(t);
  }, [lemma, loadDetail]);

  if (!lemma) return null;
  const zh = firstLine(detail?.word.translation) || firstLine(star?.translation) || '（这个词还没有中文释义）';
  const phonetic = detail?.word.phonetic || '';
  return (
    <div className="hover-card">
      <div className="hc-head">
        <span className="hc-lemma">{lemma}</span>
        {detail ? (
          phonetic ? <span className="hc-phon">{phonetic}</span> : null
        ) : (
          <span className="hc-phon pending">…</span>
        )}
      </div>
      <div className="hc-zh" title={zh}>{zh}</div>
      {star ? (
        <div className="hc-state">
          <span className={'hc-dot l' + Math.min(6, Math.max(0, star.level))} />
          L{star.level} · 强度 {star.strength.toFixed(2)}
          {star.lit ? ' · 首期点亮' : ''}
          {star.satellite ? ' · 卫星词' : ''}
        </div>
      ) : null}
    </div>
  );
}

export default function Breadcrumb() {
  const level = useWV((s) => s.level);
  const majorKey = useWV((s) => s.majorKey);
  const minorKey = useWV((s) => s.minorKey);
  const majors = useWV((s) => s.majors);
  const clusters = useWV((s) => s.clusters);
  const layoutMeta = useWV((s) => s.layoutMeta);
  const goTo = useWV((s) => s.goTo);
  const goUp = useWV((s) => s.goUp);
  const selected = useWV((s) => s.selected);
  const select = useWV((s) => s.select);

  const depth = layoutMeta?.depth ?? 2;
  const wordsLevel = depth === 2 ? 2 : 1;
  const cluster = clusters.find((c) => c.key === majorKey) || null;
  const major = majors.find((m) => m.key === majorKey) || null;
  const minor = major ? major.minors.find((m) => m.key === minorKey) || null : null;
  const clusterZh = cluster?.zh || major?.zh || majorKey || '';
  const clusterCount = cluster?.count ?? (major ? major.minors.reduce((n, m) => n + (m.count || 0), 0) : 0);

  const hint =
    level === 0
      ? '点星团标签或星团进入'
      : level < wordsLevel
        ? '点子类标签或星团查看单词'
        : '点单词看词条与关系连线 · Esc 返回上一级';

  return (
    <div className="crumbbar">
      <div className="crums">
        <button className={'crum' + (level === 0 ? ' cur' : '')} onClick={() => goTo(0)}>
          星空
        </button>
        {majorKey ? (
          <>
            <span className="crum-sep">›</span>
            <button className={'crum' + (level === 1 ? ' cur' : '')} onClick={() => goTo(1)}>
              {clusterZh}
              <em>{clusterCount}</em>
            </button>
          </>
        ) : null}
        {minor ? (
          <>
            <span className="crum-sep">›</span>
            <button className="crum cur" onClick={() => goTo(2)}>
              {minor.zh || minor.key}
              <em>{minor.count}</em>
            </button>
          </>
        ) : null}
        {selected ? (
          <>
            <span className="crum-sep">›</span>
            <button className="crum leaf" onClick={() => select(null)} title="点一下关闭词条面板">
              {selected}
              <i>✕</i>
            </button>
          </>
        ) : null}
      </div>
      <div className="crum-hint">{hint}</div>
      {level > 0 || selected ? (
        <button className="btn btn-sm" onClick={() => goUp()} title="Esc">
          ↑ 返回上一级
        </button>
      ) : null}
      <HoverCard />
    </div>
  );
}
