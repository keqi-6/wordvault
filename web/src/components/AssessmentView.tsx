// 初始自评：GET /api/assessment?count=60 逐题作答，最后 POST /api/assessment/submit
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errText } from '../api';
import { useWV } from '../store';
import type { AssessmentData } from '../types';

type Phase = 'loading' | 'quiz' | 'submitting' | 'done' | 'error';

export default function AssessmentView({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<AssessmentData | null>(null);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ total: number; preKnown: number } | null>(null);
  const answers = useRef<{ word_id: number; correct: boolean }[]>([]);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setPhase('loading');
    setError('');
    setResult(null);
    answers.current = [];
    setIdx(0);
    setPicked(null);
    try {
      const d = await api.assessment(60);
      if (!d.questions || d.questions.length === 0) {
        setError('后端没有返回题目（数据库可能还没有词条数据）。');
        setPhase('error');
        return;
      }
      setData(d);
      setPhase('quiz');
    } catch (e) {
      setError(errText(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [load]);

  const finish = useCallback(
    async (all: { word_id: number; correct: boolean }[]) => {
      setPhase('submitting');
      try {
        const r = await api.submitAssessment(all);
        setResult({ total: r.total, preKnown: r.preKnown });
        setPhase('done');
        // 自评会改写 level/strength，重新拉一次星空让亮度同步
        void useWV.getState().reloadAll();
      } catch (e) {
        setError(errText(e));
        setPhase('error');
      }
    },
    [],
  );

  const q = data ? data.questions[idx] : undefined;

  const pick = (opt: string) => {
    if (!q || picked || phase !== 'quiz') return;
    const correct = opt === q.answer;
    setPicked(opt);
    answers.current = answers.current.concat([{ word_id: q.word_id, correct }]);
    timer.current = window.setTimeout(() => {
      const nextIdx = idx + 1;
      setPicked(null);
      if (data && nextIdx < data.questions.length) setIdx(nextIdx);
      else void finish(answers.current);
    }, 520);
  };

  const total = data ? data.questions.length : 0;
  const progress = total ? (idx / total) * 100 : 0;

  return (
    <div className="overlay">
      <div className="panel assess-panel">
        <div className="panel-head">
          <div>
            <b>初始自评</b>
            <span className="panel-sub">
              认识度摸底 · GET /api/assessment?count=60 {total ? '（本次 ' + total + ' 题）' : ''}
            </span>
          </div>
          <div className="panel-actions">
            <button className="btn btn-sm" onClick={() => void load()}>重新开始</button>
            <button className="btn btn-sm" onClick={onClose}>返回星空</button>
          </div>
        </div>

        <div className="progress"><i style={{ width: progress + '%' }} /></div>

        <div className="panel-body">
          {phase === 'loading' ? <div className="loading-line">正在生成自评题目…</div> : null}

          {phase === 'error' ? (
            <div className="err-box">
              <b>{error}</b>
              <p>自评题目来自 GET /api/assessment，请确认后端与数据库就绪。</p>
              <button className="btn" onClick={() => void load()}>重试</button>
            </div>
          ) : null}

          {phase === 'submitting' ? <div className="loading-line">正在提交自评结果…</div> : null}

          {phase === 'quiz' && q ? (
            <div className="quiz">
              <div className="quiz-word-line">
                <span className="quiz-type">认识这个单词吗？</span>
                <span className="quiz-idx">第 {idx + 1}/{total} 题</span>
              </div>
              <div className="quiz-prompt">
                <div className="quiz-text big">{q.lemma}</div>
              </div>
              <div className="options">
                {q.options.map((opt) => {
                  let cls = 'option';
                  if (picked) {
                    if (opt === q.answer) cls += ' correct';
                    else if (opt === picked) cls += ' wrong';
                    else cls += ' dim';
                  }
                  return (
                    <button key={opt} className={cls} disabled={!!picked} onClick={() => pick(opt)}>
                      {opt}
                    </button>
                  );
                })}
              </div>
              <div className="quiz-source">选择最接近的中文释义；不确定也要凭第一感觉选一个。</div>
            </div>
          ) : null}

          {phase === 'done' && result ? (
            <div className="done-box">
              <h3>自评完成</h3>
              <p className="big-line">
                认识 <b>{result.preKnown}</b> / {result.total} 个
              </p>
              <p>
                正确率 {result.total ? Math.round((result.preKnown / result.total) * 100) : 0}%。
                已按结果写入你的初始 level 与 strength，星空亮度已同步更新。
              </p>
              <div className="row">
                <button className="btn primary" onClick={() => void load()}>再测一次</button>
                <button className="btn" onClick={onClose}>返回星空</button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
