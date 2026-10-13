// 词条面板：八个维度分层展示，全部数据来自 GET /api/word/:lemma
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { speak } from '../lib/speech';
import { errZh, firstLine, fmtDue, LINE_BREAK_RE } from '../lib/format';
import { runtimeRefs, useWV } from '../store';
import type { Rel, WordDetail } from '../types';

const EXCHANGE_LABEL: Record<string, string> = {
  p: '过去式', d: '过去分词', i: '现在分词', '3': '第三人称单数',
  r: '比较级', t: '最高级', s: '复数', '0': '原形', '1': '原形变换',
};

function parseExchange(s: string | null): { label: string; value: string }[] {
  if (!s) return [];
  return s
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':');
      if (i < 0) return { label: '', value: part };
      const k = part.slice(0, i);
      return { label: EXCHANGE_LABEL[k] || k, value: part.slice(i + 1) };
    })
    .filter((x) => x.value);
}

// senses 表只覆盖词表内的词；卫星词没有 senses 行，这里把 ECDICT 的 translation/definition 按行拆成义项
const POS_RE = /^(\[[^\]]+\]|[a-z]{1,6}\.)\s*(.*)$/i;

function splitLines(v: string | null | undefined): string[] {
  return String(v || '')
    .split(LINE_BREAK_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SenseRow {
  pos: string;
  zh: string;
  en: string;
}

export function splitSenseRows(
  translation: string | null | undefined,
  definition: string | null | undefined,
): { rows: SenseRow[]; enBlock: string[] } {
  const zh = splitLines(translation);
  const en = splitLines(definition);
  const pair = en.length === zh.length;
  const rows: SenseRow[] = zh.map((line, i) => {
    const m = line.match(POS_RE);
    return { pos: m ? m[1] : '', zh: m ? m[2].trim() : line, en: pair ? en[i] : '' };
  });
  if (rows.length === 0 && en.length > 0) {
    return { rows: en.map((e) => ({ pos: '', zh: '', en: e })), enBlock: [] };
  }
  return { rows, enBlock: !pair && en.length > 1 ? en : [] };
}

function Section(props: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen !== false);
  return (
    <section className={'wsec' + (open ? ' open' : '')}>
      <button className="wsec-head" onClick={() => setOpen(!open)}>
        <span className="wsec-caret">{open ? '▾' : '▸'}</span>
        <span className="wsec-title">{props.title}</span>
        {props.hint ? <span className="wsec-hint">{props.hint}</span> : null}
      </button>
      {open ? <div className="wsec-body">{props.children}</div> : null}
    </section>
  );
}

function Empty({ text = '待补充' }: { text?: string }) {
  return <div className="wempty">{text}</div>;
}

function RelGroup({ title, rels, onPick }: { title: string; rels: Rel[]; onPick: (lemma: string) => void }) {
  const n = rels ? rels.length : 0;
  return (
    <>
      <div className="rel-group-title">
        {title}
        <em className="rel-count">{n > 0 ? n + ' 条' : '暂无'}</em>
      </div>
      {n > 0 ? (
        <div className="chips">
          {rels.map((r) => (
            <button
              key={r.id + r.kind + r.lemma}
              className={'chip rel ' + r.kind}
              title={(r.kind || '') + (r.note ? ' · ' + r.note : '') + ' · 强度 ' + (r.strength ?? 0).toFixed(2)}
              onClick={() => onPick(r.lemma)}
            >
              <span className="chip-lemma">{r.lemma}</span>
              <span className="chip-zh">{firstLine(r.translation)}</span>
              {r.lit ? <span className="chip-dot" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

export default function WordPanel() {
  const selected = useWV((s) => s.selected);
  const details = useWV((s) => s.details);
  const loading = useWV((s) => s.detailLoading);
  const select = useWV((s) => s.select);
  const detailError = useWV((s) => s.detailError);
  const history = useWV((s) => s.history);
  const backWord = useWV((s) => s.backWord);
  const layoutMissing = useWV((s) => s.layoutMissing);
  const scrollRestore = useWV((s) => s.scrollRestore);
  const clearScrollRestore = useWV((s) => s.clearScrollRestore);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 把面板滚动读/写注册给 store（浏览历史回退要还原滚动位置）
  useEffect(() => {
    runtimeRefs.getPanelScroll = () => bodyRef.current?.scrollTop ?? 0;
    runtimeRefs.setPanelScroll = (top: number) => {
      if (bodyRef.current) bodyRef.current.scrollTop = top;
    };
    return () => {
      runtimeRefs.getPanelScroll = () => 0;
      runtimeRefs.setPanelScroll = () => undefined;
    };
  }, []);

  // 回退后把上一个词的滚动位置还回去（等词条内容渲染完再设，避免被高度夹掉）
  useEffect(() => {
    if (scrollRestore == null) return;
    const t = window.setTimeout(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = scrollRestore;
      clearScrollRestore();
    }, 90);
    return () => window.clearTimeout(t);
  }, [scrollRestore, selected, clearScrollRestore]);

  if (!selected) return null;
  const detail: WordDetail | null | undefined = details[selected];
  const loadingThis = loading === selected;

  const rel = detail ? detail.relations : null;
  const relTotal = rel ? rel.semantic.length + rel.morphology.length + rel.scenario.length : 0;

  return (
    <aside className="wordpanel">
      <div className="wp-head">
        <div>
          <span className="wp-lemma">{selected}</span>
          {detail ? <span className="wp-phonetic">{detail.word.phonetic || ''}</span> : null}
        </div>
        <div className="wp-head-actions">
          <button
            className="btn btn-sm"
            disabled={history.length === 0}
            onClick={() => backWord()}
            title="返回上一个查看的词（Alt + ←）"
          >
            ← 上一个词{history.length > 0 ? ' (' + history.length + ')' : ''}
          </button>
          <button className="btn btn-sm" onClick={() => speak(selected)} title="朗读单词">
            🔊 朗读
          </button>
          <button className="btn btn-sm" onClick={() => speak(selected, 0.6)} title="慢速朗读">
            慢速
          </button>
          <button className="btn btn-sm" onClick={() => select(null)} title="关闭">
            ✕
          </button>
        </div>
      </div>

      {!detail ? (
        <div className="wp-loading">
          {loadingThis ? '正在读取词条…' : '暂无词条数据：' + (detailError || '接口未返回')}
        </div>
      ) : (
        <div className="wp-body" ref={bodyRef}>
          {layoutMissing ? (
            <div className="wp-notice">
              该词未纳入星空布局，仅显示词条（星空仍停在原来的位置）
            </div>
          ) : null}
          <div className="wp-badges">
            {detail.word.scenario_major ? (
              <span className="badge">{detail.word.scenario_major}{detail.word.scenario_minor ? ' / ' + detail.word.scenario_minor : ''}</span>
            ) : null}
            {detail.word.lit ? <span className="badge lit">首期点亮</span> : null}
            {detail.word.is_satellite ? <span className="badge sat" title="卫星词：只参与关系网与星空底纹，词表内没有 senses 明细">卫星词</span> : null}
            {detail.word.in_cet6 ? <span className="badge">六级</span> : null}
            {detail.word.frq ? (
              <span className="badge" title="frq = ECDICT「当代语料库(COCA)词频序号」，数字越小越常用">frq {detail.word.frq}</span>
            ) : null}
            {detail.word.bnc ? (
              <span className="badge" title="bnc = ECDICT「BNC 英国国家语料库词频序号」，数字越小越常用">BNC {detail.word.bnc}</span>
            ) : null}
          </div>

          <div className="wp-meta">
            词频序号（越小越常用）：frq（当代语料库/COCA）{detail.word.frq || '未收录'} · BNC {detail.word.bnc || '未收录'}
            {detail.word.collins ? ' · Collins ' + detail.word.collins + ' 星' : ''}
            {detail.word.oxford ? ' · Oxford 核心词' : ''}
          </div>
          {detail.word.tag ? <div className="wp-meta">考试标签：{detail.word.tag}</div> : null}

          {detail.word.translation ? <div className="wp-trans">{detail.word.translation}</div> : null}

          <Section title="词形" hint="lemma + exchange 词形变化">
            <div className="kv">
              <span className="k">原形</span>
              <span className="v">{detail.word.lemma}</span>
            </div>
            {parseExchange(detail.word.exchange).length ? (
              <div className="chips">
                {parseExchange(detail.word.exchange).map((e, i) => (
                  <span className="chip" key={i}>
                    {e.label ? <em>{e.label}</em> : null} {e.value}
                  </span>
                ))}
              </div>
            ) : (
              <Empty text="无词形变化" />
            )}
          </Section>

          <Section title="声音" hint="音标 + 浏览器 TTS">
            {detail.word.phonetic ? (
              <>
                <div className="phon">{detail.word.phonetic}</div>
                <div className="chips">
                  <button className="btn btn-sm" onClick={() => speak(detail.word.lemma)}>英音朗读</button>
                  <button className="btn btn-sm" onClick={() => speak(detail.word.lemma, 0.6)}>慢速</button>
                </div>
              </>
            ) : (
              <Empty text="暂无音标" />
            )}
          </Section>

          <SenseSection detail={detail} />

          <Section title="搭配 / 词块" hint={detail.phrases.length > 0 ? detail.phrases.length + ' 条' : '暂无'}>
            {detail.phrases.length === 0 ? (
              <Empty text="词表里还没有收录这个词的搭配" />
            ) : (
              <ul className="phrases">
                {detail.phrases.map((p) => (
                  <li key={p.id}>
                    <span className="ph-en">{p.phrase}</span>
                    <span className="ph-zh">{p.translation || ''}</span>
                    {p.source ? <span className="ph-src">{p.source}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="语法行为" hint="gen_syntax" defaultOpen={false}>
            {detail.word.gen_syntax ? <div className="pre">{detail.word.gen_syntax}</div> : <Empty />}
          </Section>

          <Section title="语域与语用" hint="gen_register" defaultOpen={false}>
            {detail.word.gen_register ? <div className="pre">{detail.word.gen_register}</div> : <Empty />}
          </Section>

          <Section title="概念与指代" hint="gen_concept" defaultOpen={false}>
            {detail.word.gen_concept ? <div className="pre">{detail.word.gen_concept}</div> : <Empty />}
          </Section>

          <Section title="调用条件（复习状态）" defaultOpen={false}>
            {detail.review ? (
              <div className="review-state">
                <div className="kv"><span className="k">等级 level</span><span className="v">{detail.review.level} / 6</span></div>
                <div className="kv"><span className="k">强度 strength</span><span className="v">{detail.review.strength.toFixed(2)}</span></div>
                <div className="strength-bar">
                  <i style={{ width: Math.round(Math.min(1, Math.max(0, detail.review.strength)) * 100) + '%' }} />
                </div>
                <div className="kv"><span className="k">下次到期</span><span className="v">{fmtDue(detail.review.due_at)}</span></div>
                <div className="kv"><span className="k">复习次数</span><span className="v">{detail.review.total_reviews}（正确 {detail.review.total_correct}）</span></div>
                <div className="kv"><span className="k">连击 streak</span><span className="v">{detail.review.streak}</span></div>
                <div className="kv"><span className="k">自评已知</span><span className="v">{detail.review.pre_known ? '是' : '否'}</span></div>
                <div className="kv"><span className="k">错误类型</span>
                  <span className="v">
                    {detail.errors.length === 0
                      ? '无'
                      : detail.errors.map((e) => errZh(e.error_type) + '×' + e.cnt).join('、')}
                  </span>
                </div>
              </div>
            ) : (
              <Empty text="尚无复习记录" />
            )}
          </Section>

          <Section title="例句" hint={detail.examples.length > 0 ? detail.examples.length + ' 条' : '暂无'}>
            {detail.examples.length === 0 ? (
              <Empty text="还没有这个词的例句" />
            ) : (
              <ul className="examples">
                {detail.examples.map((ex) => (
                  <li key={ex.id}>
                    <div className="ex-en">
                      {ex.en}
                      <button className="mini-speak" onClick={() => speak(ex.en)} title="朗读例句">🔊</button>
                    </div>
                    {ex.zh ? <div className="ex-zh">{ex.zh}</div> : null}
                    <div className="ex-src">
                      {ex.source || '来源未标注'}
                      {ex.source_ref ? ' · ' + ex.source_ref : ''}
                      {ex.is_machine ? ' · 机器生成' : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title="关系网络"
            hint={
              rel
                ? '语义 ' + rel.semantic.length + ' · 词根 ' + rel.morphology.length + ' · 情景 ' + rel.scenario.length
                : 'semantic / morphology / scenario'
            }
          >
            {relTotal === 0 ? (
              <Empty text="这个词暂时没有已抽取的关系" />
            ) : null}
            <RelGroup title="语义 semantic（近义·反义）" rels={detail.relations.semantic} onPick={(l) => select(l, true)} />
            <RelGroup title="词根 morphology（同根词族）" rels={detail.relations.morphology} onPick={(l) => select(l, true)} />
            <RelGroup title="情景 scenario（搭配）" rels={detail.relations.scenario} onPick={(l) => select(l, true)} />
          </Section>
        </div>
      )}
    </aside>
  );
}

// 义项：优先 senses 表；卫星词没有 senses 行时回退到 ECDICT 释义
function SenseSection({ detail }: { detail: WordDetail }) {
  const { rows, enBlock } = splitSenseRows(detail.word.translation, detail.word.definition);
  const useFallback = detail.senses.length === 0 && rows.length > 0;
  const count = useFallback ? rows.length : detail.senses.length;

  return (
    <Section
      title="当前义项"
      hint={useFallback ? count + ' 条 · 来自 ECDict 释义' : count > 0 ? count + ' 条' : '暂无'}
    >
      {useFallback ? (
        <>
          {rows.map((s, i) => (
            <div className="sense-row" key={i}>
              <span className="sense-idx">{i + 1}</span>
              {s.pos ? <span className="sense-pos">{s.pos}</span> : null}
              <span className="sense-zh">{s.zh || s.en}</span>
              {s.zh && s.en ? <span className="sense-en">{s.en}</span> : null}
            </div>
          ))}
          {enBlock.length > 0 ? (
            <div className="sense-enblock">
              <div className="rel-group-title">英文释义（ECDict）</div>
              {enBlock.map((e, i) => (
                <div className="sense-en" key={i}>{e}</div>
              ))}
            </div>
          ) : null}
        </>
      ) : count === 0 ? (
        <Empty text="这个词在词表里没有义项数据" />
      ) : (
        <ol className="senses">
          {detail.senses.map((s) => (
            <li key={s.id}>
              <span className="sense-pos">{s.pos || ''}</span>
              <span className="sense-zh">{s.translation || ''}</span>
              {s.definition ? <span className="sense-en">{s.definition}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
