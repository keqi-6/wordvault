// 复习闭环：一批 20 词，逐词 2-3 题（词义 → 拼写 → 搭配），每题回写 strength 并即时更新星空亮度。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errText } from '../api';
import { itemZh } from '../lib/format';
import { speak } from '../lib/speech';
import { useWV } from '../store';
import type { QuizItem, ReviewQueue } from '../types';

const ORDER: Record<string, number> = {
  meaning_en2zh: 0,
  meaning_zh2en: 1,
  context: 2,
  listening: 3,
  spelling: 4,
  collocation: 5,
};

function pickItems(items: QuizItem[]): QuizItem[] {
  return items
    .slice()
    .sort((a, b) => (ORDER[a.item_type] ?? 9) - (ORDER[b.item_type] ?? 9))
    .slice(0, 3);
}

interface Feedback {
  correct: boolean;
  answer: string;
  errorType: string;
  strength: number;
  level: number;
}

export default function ReviewView({ onClose }: { onClose: () => void }) {
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [phase, setPhase] = useState<'loading' | 'error' | 'quiz' | 'batchDone'>('loading');
  const [error, setError] = useState('');
  const [wi, setWi] = useState(0);
  const [qi, setQi] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [hinted, setHinted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tally, setTally] = useState({ n: 0, ok: 0 });
  const [remaining, setRemaining] = useState<number | null>(null);
  const startedAt = useRef(Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const resetAnswer = useCallback(() => {
    setFeedback(null);
    setChoice(null);
    setTyped('');
    setHinted(false);
    startedAt.current = Date.now();
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    setError('');
    setFeedback(null);
    try {
      const q = await api.reviewQueue(20);
      setQueue(q);
      setWi(0);
      setQi(0);
      resetAnswer();
      setPhase('quiz');
    } catch (e) {
      setError(errText(e));
      setPhase('error');
    }
  }, [resetAnswer]);

  useEffect(() => {
    void load();
  }, [load]);

  const words = queue ? queue.words : [];
  const word = words[wi];
  const items = useMemo(() => (word ? pickItems(word.items) : []), [word]);
  const item: QuizItem | undefined = items[qi];

  // 听音题：进入题目自动朗读
  useEffect(() => {
    if (item && item.item_type === 'listening') speak(item.prompt);
  }, [item]);

  useEffect(() => {
    if (item && item.item_type === 'spelling' && !feedback) inputRef.current?.focus();
  }, [item, feedback]);

  const submit = useCallback(
    async (correct: boolean) => {
      if (!item || !word || feedback || submitting) return;
      setSubmitting(true);
      const elapsed = Date.now() - startedAt.current;
      const base: Feedback = {
        correct,
        answer: item.answer,
        errorType: '',
        strength: word.strength,
        level: word.level,
      };
      setFeedback(base);
      setTally((t) => ({ n: t.n + 1, ok: t.ok + (correct ? 1 : 0) }));
      try {
        const r = await api.submitReview({
          word_id: word.id,
          item_type: item.item_type,
          correct,
          elapsed_ms: elapsed,
          hinted,
        });
        setFeedback({ ...base, errorType: r.errorType, strength: r.strength, level: r.level });
        // 即时把新强度写回星空
        useWV.getState().patchStrength(word.id, r.strength, r.level);
      } catch (e) {
        useWV.getState().setToast('提交失败：' + errText(e) + '（本题进度未保存）');
      } finally {
        setSubmitting(false);
      }
    },
    [item, word, feedback, submitting, hinted],
  );

  const next = useCallback(() => {
    if (!word) return;
    if (qi + 1 < items.length) {
      setQi(qi + 1);
      resetAnswer();
      return;
    }
    if (wi + 1 < words.length) {
      setWi(wi + 1);
      setQi(0);
      resetAnswer();
      return;
    }
    setPhase('batchDone');
    setRemaining(null);
    void (async () => {
      try {
        const q = await api.reviewQueue(1);
        setRemaining(q.dueTotal);
      } catch {
        setRemaining(0);
      }
      void useWV.getState().loadStats();
    })();
  }, [word, words.length, wi, qi, items.length, resetAnswer]);

  // 键盘：答完后回车/空格进入下一题
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!feedback) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [feedback, next]);

  const isSpelling = !!item && (item.options.length === 0 || item.item_type === 'spelling');
  const isListening = !!item && item.item_type === 'listening';
  const totalQ = words.length;
  const progress = totalQ ? ((wi + (feedback ? 1 : 0)) / totalQ) * 100 : 0;

  return (
    <div className="overlay">
      <div className="panel review-panel">
        <div className="panel-head">
          <div>
            <b>复习</b>
            <span className="panel-sub">
              第 {Math.min(wi + 1, Math.max(totalQ, 1))}/{totalQ} 个词 · 本批已答 {tally.n} 题 · 正确 {tally.ok}
            </span>
          </div>
          <div className="panel-actions">
            <button className="btn btn-sm" onClick={() => void load()}>重新取题</button>
            <button className="btn btn-sm" onClick={onClose}>返回星空</button>
          </div>
        </div>

        <div className="progress"><i style={{ width: progress + '%' }} /></div>

        {phase === 'loading' ? <div className="panel-body">正在读取复习队列…</div> : null}

        {phase === 'error' ? (
          <div className="panel-body">
            <div className="err-box">
              <b>{error}</b>
              <p>复习队列来自 GET /api/review/queue，需要后端与数据库就绪。</p>
              <button className="btn" onClick={() => void load()}>重试</button>
            </div>
          </div>
        ) : null}

        {phase === 'quiz' && totalQ === 0 ? (
          <div className="panel-body">
            <div className="err-box">
              <b>本批没有到期的单词</b>
              <p>dueTotal = {queue ? queue.dueTotal : 0}。可以先做一次「初始自评」，或明天再来。</p>
              <button className="btn" onClick={onClose}>返回星空</button>
            </div>
          </div>
        ) : null}

        {phase === 'quiz' && word && item ? (
          <div className="panel-body quiz">
            <div className="quiz-word-line">
              <span className="quiz-major">{word.scenario_major || '未分类'}{word.scenario_minor ? ' / ' + word.scenario_minor : ''}</span>
              <span className="quiz-type">{itemZh(item.item_type)}</span>
              <span className="quiz-idx">第 {qi + 1}/{items.length} 题</span>
              <span className="quiz-strength">强度 {word.strength.toFixed(2)} · L{word.level}</span>
            </div>

            {isListening ? (
              <div className="quiz-prompt listen">
                <button className="btn" onClick={() => speak(item.prompt)}>🔊 再播一次</button>
                <div className="quiz-hint">听发音，选出正确的单词</div>
              </div>
            ) : (
              <div className="quiz-prompt">
                {item.item_type === 'spelling' ? <div className="quiz-hint">看释义，拼出单词</div> : null}
                <div className="quiz-text">{item.prompt}</div>
              </div>
            )}

            {!isSpelling ? (
              <div className="options">
                {item.options.map((opt) => {
                  let cls = 'option';
                  if (feedback) {
                    if (opt === item.answer) cls += ' correct';
                    else if (opt === choice) cls += ' wrong';
                    else cls += ' dim';
                  }
                  return (
                    <button
                      key={opt}
                      className={cls}
                      disabled={!!feedback || submitting}
                      onClick={() => {
                        setChoice(opt);
                        void submit(opt === item.answer);
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            ) : (
              <form
                className="spell-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!feedback && typed.trim()) {
                    void submit(typed.trim().toLowerCase() === item.answer.trim().toLowerCase());
                  }
                }}
              >
                <input
                  ref={inputRef}
                  className="spell-input"
                  value={typed}
                  placeholder="输入英文单词后回车"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={!!feedback}
                  onChange={(e) => setTyped(e.target.value)}
                />
                <button className="btn" type="button" disabled={!!feedback} onClick={() => setHinted(true)}>
                  提示（音标）
                </button>
                <button className="btn primary" type="submit" disabled={!!feedback || !typed.trim()}>
                  提交
                </button>
              </form>
            )}

            {isSpelling && hinted && !feedback ? (
              <div className="hint-line">音标：{item.source_ref || '（该词无音标数据）'}　（本次记为「使用提示」）</div>
            ) : null}

            {feedback ? (
              <div className={'verdict ' + (feedback.correct ? 'ok' : 'bad')}>
                <b>{feedback.correct ? '回答正确' : '回答错误'}</b>
                {!feedback.correct ? <span>　正确答案：<em>{feedback.answer}</em></span> : null}
                <span className="verdict-meta">
                  强度 {feedback.strength.toFixed(2)} · L{feedback.level}
                  {!feedback.correct && feedback.errorType ? ' · 错误类型 ' + feedback.errorType : ''}
                </span>
                {word.examples && word.examples.length > 0 ? (
                  <div className="verdict-example">
                    <div className="ex-en">{word.examples[0].en}</div>
                    {word.examples[0].zh ? <div className="ex-zh">{word.examples[0].zh}</div> : null}
                  </div>
                ) : null}
                <button className="btn primary" onClick={next}>
                  {qi + 1 < items.length ? '下一题（回车）' : wi + 1 < words.length ? '下一个词（回车）' : '完成本批（回车）'}
                </button>
              </div>
            ) : null}

            {item.source ? (
              <div className="quiz-source">
                题源：{item.source}
                {item.source_ref && item.item_type !== 'spelling' ? ' · ' + item.source_ref : ''}
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === 'batchDone' ? (
          <div className="panel-body">
            <div className="done-box">
              <h3>本批完成</h3>
              <p>
                本批 {tally.n} 题，正确 {tally.ok} 题
                {tally.n ? '（正确率 ' + Math.round((tally.ok / tally.n) * 100) + '%）' : ''}。
              </p>
              <p>
                {remaining === null ? '正在查询剩余到期数量…' : '还剩 ' + remaining + ' 个到期，继续吗？'}
              </p>
              <div className="row">
                <button className="btn primary" disabled={remaining === null} onClick={() => void load()}>
                  继续复习
                </button>
                <button className="btn" onClick={onClose}>返回星空</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
