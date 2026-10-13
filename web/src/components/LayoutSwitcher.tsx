// 星相切换器：切换整张星空的"相位"（情景分区 / 词根家族 / 前缀家族 / 后缀家族 / 语义场）
import { useWV } from '../store';

export default function LayoutSwitcher() {
  const layouts = useWV((s) => s.layouts);
  const layoutKey = useWV((s) => s.layoutKey);
  const setLayout = useWV((s) => s.setLayout);
  const loading = useWV((s) => s.loadingSky);
  const stars = useWV((s) => s.stars.length);

  if (!layouts.length) return null;
  const cur = layouts.find((l) => l.key === layoutKey);
  const title = cur
    ? cur.zh + '：' + cur.desc + '（' + cur.clusterCount + ' 个星团 / ' + (stars || cur.wordCount) + ' 词）'
    : '切换星相';

  return (
    <label className="layout-switch" title={title}>
      <span className="ls-label">星相</span>
      <select
        value={layoutKey}
        disabled={loading}
        onChange={(e) => {
          void setLayout(e.target.value);
        }}
      >
        {layouts.map((l) => (
          <option key={l.key} value={l.key}>
            {l.zh}
          </option>
        ))}
      </select>
      {cur ? <span className="ls-meta">{cur.clusterCount} 团</span> : null}
    </label>
  );
}
