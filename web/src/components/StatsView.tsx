// 统计与导出：全部数字来自 GET /api/stats
import { useEffect } from 'react';
import { api } from '../api';
import { errZh, fmtPct } from '../lib/format';
import { useWV } from '../store';

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export default function StatsView({ onClose }: { onClose: () => void }) {
  const stats = useWV((s) => s.stats);
  const error = useWV((s) => s.statsError);
  const loadStats = useWV((s) => s.loadStats);
  const majors = useWV((s) => s.majors);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const majorZh = (key: string) => {
    const m = majors.find((x) => x.key === key);
    return m && m.zh ? m.zh : key;
  };

  const maxErr = stats && stats.byError.length ? Math.max(...stats.byError.map((e) => e.c || 0)) : 0;

  return (
    <div className="overlay">
      <div className="panel stats-panel">
        <div className="panel-head">
          <div>
            <b>学习统计</b>
            <span className="panel-sub">数据来源：GET /api/stats</span>
          </div>
          <div className="panel-actions">
            <a className="btn" href={api.exportCsvUrl()} download="wordvault-progress.csv">
              导出进度 CSV
            </a>
            <button className="btn btn-sm" onClick={() => void loadStats()}>刷新</button>
            <button className="btn btn-sm" onClick={onClose}>返回星空</button>
          </div>
        </div>

        <div className="panel-body">
          {error ? (
            <div className="err-box">
              <b>{error}</b>
              <p>统计数据来自 GET /api/stats，请确认后端已启动。</p>
              <button className="btn" onClick={() => void loadStats()}>重试</button>
            </div>
          ) : null}

          {!stats ? (
            <div className="loading-line">{error ? '' : '正在读取统计…'}</div>
          ) : (
            <>
              <div className="stat-grid">
                <Card label="总词数" value={String(stats.total)} sub="lit=1 的词" />
                <Card label="已学" value={String(stats.touched)} sub="total_reviews > 0" />
                <Card label="已掌握" value={String(stats.mastering)} sub="level ≥ 5" />
                <Card label="今日到期" value={String(stats.due)} sub="due_at ≤ 现在" />
                <Card label="复习次数" value={String(stats.reviews)} sub={'正确 ' + stats.correct} />
                <Card label="正确率" value={fmtPct(stats.accuracy)} sub={stats.reviews ? stats.correct + '/' + stats.reviews : '暂无记录'} />
              </div>

              <h4 className="stats-h">错误类型分布</h4>
              {stats.byError.length === 0 ? (
                <div className="wempty">暂无错误记录</div>
              ) : (
                <div className="errbars">
                  {stats.byError.map((e) => (
                    <div className="errbar" key={e.error_type}>
                      <span className="errbar-name">{errZh(e.error_type)}</span>
                      <span className="errbar-track">
                        <i style={{ width: maxErr ? Math.round(((e.c || 0) / maxErr) * 100) + '%' : '0%' }} />
                      </span>
                      <span className="errbar-num">{e.c}</span>
                    </div>
                  ))}
                </div>
              )}

              <h4 className="stats-h">各大区进度</h4>
              {stats.byMajor.length === 0 ? (
                <div className="wempty">暂无大区数据</div>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>情景大区</th>
                      <th>词数</th>
                      <th>已学</th>
                      <th>学习率</th>
                      <th>平均强度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byMajor.map((m) => (
                      <tr key={m.m}>
                        <td>{majorZh(m.m)}<span className="tbl-key">{m.m}</span></td>
                        <td>{m.n}</td>
                        <td>{m.touched}</td>
                        <td>{m.n ? fmtPct(m.touched / m.n, 0) : '—'}</td>
                        <td>{Number(m.avg_strength || 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
