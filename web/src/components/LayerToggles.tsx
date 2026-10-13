import { useState } from 'react';
import { useWV } from '../store';
import type { LayerKey } from '../store';

const ITEMS: { key: LayerKey; zh: string; color: string }[] = [
  { key: 'semantic', zh: '语义', color: '#4fd7ff' },
  { key: 'morphology', zh: '词根', color: '#b06bff' },
  { key: 'scenario', zh: '情景', color: '#ffb454' },
];

/**
 * 收成一个紧凑下拉：只决定「选中一个词之后画哪几层关系」，默认三层全开；
 * 没有选中词时任何组合都不会画线。
 */
export default function LayerToggles() {
  const layers = useWV((s) => s.layers);
  const setLayer = useWV((s) => s.setLayer);
  const selected = useWV((s) => s.selected);
  const [open, setOpen] = useState(false);
  const n = ITEMS.filter((it) => layers[it.key]).length;

  return (
    <div className="layers-drop">
      <button
        className={'layer-btn layer-btn-main' + (n ? ' on' : '')}
        title="选中词时显示哪几层关系（默认三层全开）"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="layer-dot" style={{ background: n ? '#7fd0ff' : '#556' }} />
        关系 {n}/3
        <span className="caret">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div className="layers-pop" onMouseLeave={() => setOpen(false)}>
          {ITEMS.map((it) => (
            <button
              key={it.key}
              className={'layer-item' + (layers[it.key] ? ' on' : '')}
              style={layers[it.key] ? { borderColor: it.color, color: it.color } : {}}
              onClick={() => setLayer(it.key, !layers[it.key])}
            >
              <span className="layer-dot" style={{ background: it.color }} />
              {it.zh}
              <em>{layers[it.key] ? '开' : '关'}</em>
            </button>
          ))}
          <div className="layers-hint">{selected ? '当前选中：' + selected : '还没有选中词，不会画线'}</div>
        </div>
      ) : null}
    </div>
  );
}
