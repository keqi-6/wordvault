import { useMemo } from 'react';
import { useWV } from '../store';
import SearchBox from './SearchBox';
import LayerToggles from './LayerToggles';
import LayoutSwitcher from './LayoutSwitcher';

export default function TopBar() {
  const view = useWV((s) => s.view);
  const setView = useWV((s) => s.setView);
  const due = useWV((s) => s.dueCount);
  const backend = useWV((s) => s.backend);
  const reloadAll = useWV((s) => s.reloadAll);
  const selected = useWV((s) => s.selected);
  const goTo = useWV((s) => s.goTo);
  const displayMode = useWV((s) => s.displayMode);
  const setDisplayMode = useWV((s) => s.setDisplayMode);
  const stars = useWV((s) => s.stars);
  // 有记忆强度数据的词数。全新库里是 0 → 两种显示模式本来就一样，明确告诉用户不是点错了。
  const learned = useMemo(() => stars.reduce((n, s) => n + ((s.strength || 0) > 0 ? 1 : 0), 0), [stars]);

  return (
    <header className="topbar">
      <div className="brand" onClick={() => goTo(0)} title="回到全景">
        <span className="brand-cn">词穹</span>
        <span className="brand-en">WordVault</span>
        <span className="brand-sub">六级词汇关系词典</span>
      </div>

      <SearchBox />

      <LayoutSwitcher />

      <button
        className={'due-badge' + (due > 0 ? ' hot' : '')}
        onClick={() => setView('review')}
        title={'今日到期 ' + due + ' 个 · 点击进入复习'}
      >
        到期 <b>{due}</b>
      </button>

      <button
        className="mode-btn"
        title={
          displayMode === 'bright'
            ? '当前：全亮（所有词一样亮，和"背没背过"无关）· 点击切到记忆强度'
            : '当前：记忆强度（亮度随掌握程度变化，但有高下限）· 点击切回全亮'
        }
        onClick={() => setDisplayMode(displayMode === 'bright' ? 'strength' : 'bright')}
      >
        显示：{displayMode === 'bright' ? '全亮' : '记忆强度'}
      </button>

      {displayMode === 'strength' && learned < 100 ? (
        <span className="mode-hint" title={'当前只有 ' + learned + ' 个词有记忆强度数据'}>
          学习记录还少（{learned} 词），两种模式差异很小
        </span>
      ) : null}

      <LayerToggles />

      <nav className="nav">
        <button className={'btn' + (view === 'sky' ? ' active' : '')} onClick={() => setView('sky')}>
          星空
        </button>
        <button className={'btn' + (view === 'review' ? ' active' : '')} onClick={() => setView('review')}>
          复习
        </button>
        <button className={'btn' + (view === 'stats' ? ' active' : '')} onClick={() => setView('stats')}>
          统计
        </button>
        <button className={'btn' + (view === 'assessment' ? ' active' : '')} onClick={() => setView('assessment')}>
          初始自评
        </button>
      </nav>

      <div className="status" title={backend === 'up' ? '后端已连接' : '后端未连接'}>
        <span className={'status-dot ' + backend} />
        {selected ? <span className="status-lemma">{selected}</span> : null}
        <button className="btn btn-sm" onClick={() => void reloadAll()} title="重新拉取 /api/health 与 /api/sky">
          重连
        </button>
      </div>
    </header>
  );
}
