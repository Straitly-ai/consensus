import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowUpDown, Hourglass, Check, ChevronDown, ChevronLeft, ChevronRight, Lock, RotateCw, SearchX, Users, X as XIcon } from 'lucide-react';
import type { Intent, Post, PollOption, Theme } from './api';
import { GoogleButton, useAuth } from './auth';
import { Donut, DonutSkeleton } from './Donut';
import { alpha, headline, INTENT_META, INTENT_ORDER, num, optionColor } from './format';
import { RedditMark, XMark } from './icons';
import { cleanPostText } from './postText';
import { LeadsTable, PostRow, useCopy } from './Posts';
import type { SearchState } from './useSearch';
import { useMedia } from './useMedia';

type Tab = 'all' | 'reddit' | 'x' | 'leads';
type Sort = 'relevance' | 'score' | 'new';
/** `picked` value for the "All opinions" view: every counted opinion, across options. */
const ALL = '*';
const SORT_LABEL: Record<Sort, string> = { relevance: 'Relevance', score: 'Most upvoted', new: 'Newest' };
const STAGE_LABEL: Record<string, string> = {
  searching: 'Searching Reddit and X',
  writing_options: 'Reading the conversation',
  sorting: 'Sorting opinions',
  refining: 'Counting the last votes',
  writing_reasons: 'Writing the summaries',
};

/** Leads only matter for buying questions: enough people with their own buying situation. */
export function showLeads(s: SearchState): boolean {
  const l = s.poll?.leads.total ?? 0;
  const total = s.poll?.total_opinions ?? 0;
  return l >= 25 || (l >= 5 && l / Math.max(1, total) >= 0.02);
}

/** A finished poll that should be read as rough: few opinions, mostly Other, a single real answer, or backend flags. */
export function isThin(s: SearchState): boolean {
  const poll = s.poll;
  if (s.phase !== 'done' || !poll || poll.total_opinions === 0) return false;
  if (s.done?.status === 'thin' || (s.done?.quality?.flags?.length ?? 0) > 0) return true;
  const real = poll.options.filter((o) => !o.is_other && o.count > 0);
  const other = poll.options.find((o) => o.is_other);
  return real.length <= 1 || (other?.percent ?? 0) >= 60;
}

/** Backend relevance (on-topic x stance x engagement) when present; older results fall back to rank. */
const relevance = (p: Post) => (p as Post & { relevance?: number }).relevance ?? p.rank;
const sorters: Record<Sort, (a: Post, b: Post) => number> = {
  relevance: (a, b) => relevance(b) - relevance(a) || b.score - a.score,
  score: (a, b) => b.score - a.score || b.rank - a.rank,
  new: (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''),
};

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const nums: (number | '…')[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return (
    <nav className="pager" aria-label="Pages">
      <button className="icon-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" data-tip="Previous">
        <ChevronLeft size={16} />
      </button>
      {nums.map((n, i) =>
        n === '…' ? (
          <span key={`e${i}`} className="pager-gap">
            …
          </span>
        ) : (
          <button key={n} className={`pager-num ${n === page ? 'on' : ''}`} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}>
            {n}
          </button>
        ),
      )}
      <button className="icon-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page" data-tip="Next">
        <ChevronRight size={16} />
      </button>
    </nav>
  );
}

function SortMenu({ value, onChange }: { value: Sort; onChange: (s: Sort) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="chip-btn sort-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <ArrowUpDown size={14} className="sort-ic" />
        <span className="chip-label">
          <span className="sort-pre">Sort: </span>
          {SORT_LABEL[value]}
        </span>
        <ChevronDown size={14} className="chev" />
      </button>
      {open && (
        <div className="menu right" role="menu">
          {(Object.keys(SORT_LABEL) as Sort[]).map((k) => (
            <button key={k} className="menu-item" role="menuitemradio" aria-checked={value === k} onClick={() => (onChange(k), setOpen(false))}>
              {SORT_LABEL[k]}
              {value === k && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend({ options, selected, onSelect, live, hovered, onHover, total, otherPicks }: { options: PollOption[]; selected: string | null; onSelect: (id: string) => void; live: boolean; hovered: string | null; onHover: (id: string | null) => void; total: number; otherPicks?: number }) {
  return (
    <div className="legend" role="listbox" aria-label="Answers">
      {options.map((o) => {
        const c = optionColor(o.id);
        const on = o.id === selected;
        return (
          <button
            key={o.id}
            role="option"
            aria-selected={on}
            className={`legend-row ${on ? 'on' : ''} ${hovered === o.id ? 'hot' : ''}`}
            style={{ ['--c' as string]: c, ['--ct' as string]: alpha(c, 0.14) }}
            onClick={() => onSelect(o.id)}
            onPointerEnter={(e) => e.pointerType === 'mouse' && onHover(o.id)}
            onPointerLeave={(e) => e.pointerType === 'mouse' && onHover(null)}
            title={o.description}
          >
            <span className="dot" />
            <span className="legend-title">
              {o.title}
              {o.is_other && !live && otherPicks ? <span className="legend-sub"> · {num(otherPicks)} {otherPicks === 1 ? 'pick' : 'picks'}</span> : null}
            </span>
            <span className="legend-pct">{live || o.percent || o.count ? (o.count > 0 && o.percent < 0.5 ? '<1%' : `${Math.round(o.percent)}%`) : ''}</span>
            <span className="legend-count">{num(o.count)}</span>
          </button>
        );
      })}
      <button type="button" role="option" aria-selected={!selected} className={`legend-row legend-all ${!selected ? 'on' : ''}`} onClick={() => onSelect(ALL)}>
        <span className="dot" />
        <span className="legend-title">All opinions</span>
        <span className="legend-total">{num(total)}</span>
      </button>
    </div>
  );
}

/**
 * Keeps a box at the tallest height it has reached, so late data (an option dropped at the end, a shorter
 * summary) never pulls content up. A user action (new `reset` value) lets it size freely again.
 */
function useNoShrink<T extends HTMLElement>(reset?: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    el.style.minHeight = '';
    let max = 0;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (h > max + 0.5) {
        max = h;
        el.style.minHeight = `${h}px`;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [reset]);
  return ref;
}

function LegendPending({ titles }: { titles: string[] }) {
  // Reserve at least 4 rows so the column keeps its height until the real options arrive.
  const rows = [...titles, ...Array(Math.max(0, 4 - titles.length)).fill('')] as string[];
  return (
    <div className="legend" aria-hidden="true">
      {rows.map((t, i) => (
        <div key={i} className={`legend-row pending ${t ? '' : 'blank'}`}>
          <span className="dot" />
          <span className="legend-title">{t || '\u00a0'}</span>
          <span className="legend-pct" />
          <span className="legend-count" />
        </div>
      ))}
      <div className="legend-row legend-all pending">
        <span className="dot" />
        <span className="legend-title">All opinions</span>
        <span className="legend-total" />
      </div>
    </div>
  );
}

/** Themes behind the selected answer (or every answer in All): specific arguments, ranked by how many voters make them. */
function Themes({ themes, option, all, posts, active, onPick }: { themes: Theme[]; option: PollOption | undefined; all?: Set<string>; posts: Record<string, Post>; active: string | null; onPick: (id: string | null) => void }) {
  if (!option && !all) return null;
  const inScope = (id: string) => {
    const o = posts[id]?.option;
    return !!o && (option ? o === option.id : all!.has(o));
  };
  // Counted from the loaded posts, the same set the list filters on, so a row's count always equals the list it opens.
  const rows = themes
    .map((t) => ({ t, n: t.post_ids.reduce((a, id) => a + (inScope(id) ? 1 : 0), 0) }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
  if (!rows.length) return null;
  const max = rows[0]!.n;
  // One short example for the open theme, from a voter in scope (the theme's own quotes first, then its best post).
  const example = (t: Theme) => {
    const q = t.quotes.find((x) => inScope(x.post_id));
    const p = posts[q?.post_id ?? t.post_ids.find(inScope) ?? ''];
    if (!p) return null;
    const raw = cleanPostText(q?.text || (p.thread_title && p.text.startsWith(p.thread_title) ? p.text.slice(p.thread_title.length) : p.text) || p.text).replace(/\s+/g, ' ');
    const text = raw.length > 180 ? `${raw.slice(0, 180).replace(/\s+\S*$/, '')}…` : raw;
    return { text, source: p.source, who: p.source === 'reddit' ? `u/${p.author.handle}` : `@${p.author.handle}` };
  };
  const c = option ? optionColor(option.id) : 'var(--ink-2)';
  return (
    <section className={`themes ${option ? '' : 'all'}`} style={{ ['--c' as string]: c }} aria-label="What people are saying">
      <div className="why-label">What people are saying</div>
      <ul>
        {rows.map(({ t, n }) => {
          const on = active === t.id;
          const ex = on ? example(t) : null;
          return (
            <li key={t.id}>
              <button type="button" className={on ? 'on' : ''} aria-pressed={on} aria-expanded={on} onClick={() => onPick(on ? null : t.id)} title={t.description}>
                <span className="th-top">
                  <span className="th-title">{t.title}</span>
                  <span className="th-n">{num(n)}</span>
                </span>
                <span className="th-bar">
                  <span style={{ width: `${Math.max(4, (100 * n) / max)}%` }} />
                </span>
                {ex && (
                  <span className="th-quote">
                    <span className="th-quote-text">“{ex.text}”</span>
                    <span className="th-quote-by">
                      {ex.source === 'reddit' ? <RedditMark size={12} /> : <XMark size={10} />}
                      {ex.who}
                    </span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Why({ option, summary, pending }: { option: PollOption | undefined; summary: string | undefined; pending: boolean }) {
  const c = optionColor(option?.id);
  return (
    <section className={`why ${pending ? 'pending' : ''}`} aria-hidden={pending || undefined} style={{ ['--c' as string]: c, ['--ct' as string]: alpha(c, option ? 0.13 : 0) }}>
      <div className="why-label">{option ? <>Why people say “{option.title}”</> : 'Why people say this'}</div>
      {summary ? (
        <blockquote className="why-quote" key={summary}>
          “{summary}”
        </blockquote>
      ) : (
        <p className="why-none" key={option?.id}>
          {option?.description ?? '\u00a0'}
        </p>
      )}
    </section>
  );
}

function Caption({ state }: { state: SearchState }) {
  const poll = state.poll;
  const running = state.phase === 'connecting' || state.phase === 'streaming';
  if (!poll || !state.done) {
    let text = state.phase === 'connecting' ? 'Starting search' : STAGE_LABEL[state.progress?.stage ?? 'searching'] ?? 'Searching';
    if (poll && poll.total_opinions > 0) text = `${num(poll.total_opinions)} opinions so far`;
    return (
      <p className="caption" aria-live="polite">
        <span className="cap-text">{running || poll ? text : '\u00a0'}</span>
        {(running || (poll && !poll.final)) && <span className="live-badge">Live</span>}
      </p>
    );
  }
  const d = state.done;
  const secs = d.total_ms;
  const firstPoll = d.timing?.first_poll;
  const time = state.meta?.cached ? (
    <span className="cap-time"> · saved result</span>
  ) : secs ? (
    <span className="cap-time" title={firstPoll ? `First results in ${(firstPoll / 1000).toFixed(1)}s, done in ${(secs / 1000).toFixed(1)}s` : undefined}>
      {' '}
      · took {(secs / 1000).toFixed(1)}s
    </span>
  ) : null;
  if (poll.scanned?.total)
    return (
      <p className="caption">
        <span className="cap-text">
          {num(poll.total_opinions)} opinions counted from {num(poll.scanned.total)} posts scanned
          {time}
        </span>
      </p>
    );
  const parts: React.ReactNode[] = [];
  if (poll.sources.reddit.threads)
    parts.push(
      <span key="r" className="cap-src" data-tip="Reddit">
        <RedditMark size={13} /> {num(poll.sources.reddit.threads)} threads
      </span>,
    );
  if (poll.sources.x.posts)
    parts.push(
      <span key="x" className="cap-src" data-tip="X">
        <XMark size={11} /> {num(poll.sources.x.posts)} posts
      </span>,
    );
  return (
    <p className="caption">
      <span className="cap-text">
        {num(poll.total_opinions)} opinions from {parts.length === 2 ? [parts[0], ' and ', parts[1]] : parts}
        {time}
      </span>
    </p>
  );
}

/** The one loading line in the posts area: live counts per source until the first sorted posts land. */
function ListWait({ state }: { state: SearchState }) {
  const p = state.progress;
  const threads = p?.reddit.threads ?? 0;
  const xPosts = p?.x.posts ?? 0;
  return (
    <div className="list-wait" aria-hidden="true">
      <span className="pulse" />
      {threads || xPosts ? (
        <span className="list-wait-counts">
          <span className="cap-src">
            <RedditMark size={13} /> {num(threads)} {threads === 1 ? 'thread' : 'threads'}
          </span>
          <span className="cap-src">
            <XMark size={11} /> {num(xPosts)} posts
          </span>
        </span>
      ) : (
        <span className="list-wait-counts">Finding posts</span>
      )}
    </div>
  );
}

export function Results({ state, query, retry, onWiden, tools }: { state: SearchState; query: string; retry: () => void; onWiden?: () => void; tools?: React.ReactNode }) {
  const { refreshMe, user, authError } = useAuth();
  const desktop = useMedia('(min-width: 1100px)');
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<Sort>('relevance');
  const [page, setPage] = useState(1);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [themeId, setThemeId] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const listTop = useRef<HTMLDivElement>(null);
  const streamOrder = useRef<{ key: string; ids: string[] }>({ key: '', ids: [] });

  const poll = state.poll;
  // Hide an empty "Other" row once results are in; it only adds noise.
  const rawOptions = (poll?.options ?? []).filter((o) => !(o.is_other && o.count === 0 && poll?.final));
  // While counts are live, rows keep the order they first appeared in so they never swap places mid-run.
  const firstOrder = useRef<string[]>([]);
  if (!poll?.final) for (const o of rawOptions) if (!firstOrder.current.includes(o.id)) firstOrder.current.push(o.id);
  const options = poll?.final ? rawOptions : [...rawOptions].sort((a, b) => firstOrder.current.indexOf(a.id) - firstOrder.current.indexOf(b.id));
  // null = "All opinions". Before the user picks, the first answer with votes is shown.
  const allView = picked === ALL;
  const selected = allView ? null : picked && options.some((o) => o.id === picked) ? picked : options.find((o) => o.count > 0)?.id ?? options[0]?.id ?? null;
  const option = options.find((o) => o.id === selected);
  const optionIds = useMemo(() => new Set(options.map((o) => o.id)), [options.map((o) => o.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const inView = (p: Post) => (selected ? p.option === selected : !!p.option && optionIds.has(p.option));
  const legendBox = useNoShrink<HTMLDivElement>(picked);
  const whyBox = useNoShrink<HTMLDivElement>(picked);
  const leadsOn = showLeads(state);
  const running = state.phase === 'connecting' || state.phase === 'streaming';

  useEffect(() => {
    if (state.phase === 'done' && !user) refreshMe();
  }, [state.phase, user, refreshMe]);

  useEffect(() => {
    if (tab === 'leads' && !leadsOn && state.phase === 'done') setTab('all');
  }, [tab, leadsOn, state.phase]);

  const allPosts = useMemo(() => Object.values(state.posts), [state.postsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const leads = useMemo(() => allPosts.filter((p) => p.intent), [allPosts]);
  const theme = themeId ? state.themes.find((t) => t.id === themeId) ?? null : null;
  const themeSet = useMemo(() => (theme ? new Set(theme.post_ids) : null), [theme]);
  const list = useMemo(() => {
    let l: Post[];
    if (tab === 'leads') l = leads.filter((p) => !intent || p.intent === intent);
    else {
      l = allPosts.filter((p) => inView(p) && (!themeSet || themeSet.has(p.id)));
      if (tab !== 'all') l = l.filter((p) => p.source === tab);
    }
    return l.sort(sorters[sort]);
  }, [allPosts, leads, tab, intent, selected, optionIds, sort, themeSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = tab === 'leads' && desktop ? 25 : 20;
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const cur = running ? 1 : Math.min(page, pages);
  const listKey = `${tab}-${selected ?? ALL}-${sort}-${intent}-${themeId}-${cur}`;
  let shown = list.slice((cur - 1) * pageSize, cur * pageSize);
  if (running) {
    // While posts stream in, rows on screen stay put and new ones only append; the final order lands once at the end.
    const prev = streamOrder.current.key === listKey ? streamOrder.current.ids : [];
    const byId = new Map(list.map((p) => [p.id, p]));
    const had = new Set(prev);
    shown = [...prev.flatMap((id) => byId.get(id) ?? []), ...list.filter((p) => !had.has(p.id))].slice(0, pageSize);
    streamOrder.current = { key: listKey, ids: shown.map((p) => p.id) };
  }
  const go = (p: number) => {
    setPage(p);
    const el = listTop.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const select = (id: string) => {
    // Clicking the answer already shown opens every opinion; clicking All (or an answer) narrows again.
    setPicked(id !== ALL && id === selected ? ALL : id);
    setThemeId(null);
    setPage(1);
    if (tab === 'leads') setTab('all');
  };
  const onCopy = (p: Post) => copy(p.id, p.url);

  const title = headline(query || state.meta?.query || "");

  if (state.phase === 'error' && state.error?.code === 'search_in_progress')
    return (
      <div className="state-panel calm">
        <Hourglass size={26} />
        <h2>One search at a time</h2>
        <p>{state.error.message}</p>
        <button className="btn primary" onClick={retry}>
          <RotateCw size={15} /> Try again
        </button>
      </div>
    );

  if (state.phase === 'error')
    return (
      <div className="state-panel">
        <AlertCircle size={28} />
        <h2>{state.error?.code === 'rate_limited' ? 'Slow down a little' : state.error?.code === 'over_capacity' ? 'We’re busy right now' : state.error?.code === 'no_credits' ? 'New searches are paused' : state.error?.code === 'not_found' ? 'This link has expired' : 'That search didn’t finish'}</h2>
        <p>{state.error?.message}</p>
        {state.error?.code !== 'not_found' && state.error?.code !== 'no_credits' && (
          <button className="btn primary" onClick={retry}>
            <RotateCw size={15} /> Try again
          </button>
        )}
      </div>
    );

  if (state.phase === 'gated')
    return (
      <div className="state-panel">
        <Lock size={26} />
        <h2>Sign in to keep searching</h2>
        <p>Sign in with Google to see the results.</p>
        <GoogleButton
          className="btn primary google-btn"
          onDone={() => {
            refreshMe();
            retry();
          }}
        />
        {authError && <p className="form-error" role="alert">{authError}</p>}
      </div>
    );

  const empty = state.phase === 'done' && (!poll || poll.total_opinions === 0) && leads.length === 0;
  if (empty) {
    const offTopic = state.done?.reason === 'off_topic';
    return (
      <div className="state-panel">
        <SearchX size={28} />
        <h2>{offTopic ? 'We couldn’t pin this one down' : 'No one’s debating this yet'}</h2>
        <p>
          {offTopic
            ? `The posts we found for “${title}” weren’t really about it. Searching again often lands a better pool, or try phrasing it the way people would ask online.`
            : `We couldn’t find enough opinions on Reddit or X for “${title}”. Try a wider date range or a more common phrasing.`}
        </p>
        <div className="state-actions">
          <button className={`btn ${onWiden ? '' : 'primary'}`} onClick={retry}>
            <RotateCw size={15} />
            Try again
          </button>
          {onWiden && (
            <button className="btn primary" onClick={onWiden}>
              Search all time
            </button>
          )}
        </div>
      </div>
    );
  }

  // With a theme filter on, counts reflect the filtered posts so the tabs match the list.
  const themed = themeSet ? allPosts.filter((p) => inView(p) && themeSet.has(p.id)) : null;
  const allBySource = (src: 'reddit' | 'x') => options.reduce((a, o) => a + o.by_source[src], 0);
  const allTotal = options.reduce((a, o) => a + o.count, 0);
  const srcCount = (src: 'reddit' | 'x') => (themed ? themed.filter((p) => p.source === src).length : option ? option.by_source[src] : allView && poll ? allBySource(src) : null);
  // X is a logo, so it is never also spelled out ("X X 4"); its name lives in the tooltip and aria-label.
  const tabs: { id: Tab; label: React.ReactNode; name: string; count: number | null; icon?: React.ReactNode }[] = [
    { id: 'all', label: 'All', name: 'All sources', count: themed ? themed.length : option ? option.count : allView && poll ? allTotal : null },
    { id: 'reddit', label: 'Reddit', name: 'Reddit', count: srcCount('reddit'), icon: <RedditMark size={15} /> },
    { id: 'x', label: null, name: 'X', count: srcCount('x'), icon: <XMark size={13} /> },
  ];
  if (leadsOn) tabs.push({ id: 'leads', label: 'Leads', name: 'Leads', count: poll?.leads.total ?? 0, icon: <Users size={14} /> });

  const live = !!poll && !poll.final;
  const loadingPosts = running && shown.length === 0;
  const hasPoll = !!poll && poll.total_opinions > 0;
  // One column: the legend can still grow when the final poll lands, so nothing sits under it until the run is done.
  const deferPosts = running && !desktop;

  return (
    <div className="results">
      <aside className="poll-col">
        <div className="q-head">
          <div className="eyebrow">Question</div>
          {tools && <div className="q-tools">{tools}</div>}
        </div>
        <h1 className="q-title">{title}</h1>
        <Caption state={state} />
        <div className="poll-viz">
          <div className="donut-wrap">
            {poll && poll.total_opinions > 0 ? (
              <Donut slices={options} total={poll.total_opinions} selected={selected} onSelect={select} hovered={hovered} onHover={setHovered} label="opinions" />
            ) : (
              <DonutSkeleton found={state.progress?.pool ?? 0} label={state.progress?.pool ? 'posts' : 'searching'} />
            )}
          </div>
          <div className="legend-box" ref={legendBox}>
            {hasPoll ? <Legend options={options} selected={selected} onSelect={select} live={live} hovered={hovered} onHover={setHovered} total={allTotal} otherPicks={poll?.final ? poll.other_picks : undefined} /> : <LegendPending titles={state.options.map((o) => o.title)} />}
          </div>
        </div>
        {!deferPosts && !allView && (
          <div ref={whyBox}>
            <Why option={hasPoll ? option : undefined} summary={hasPoll && selected ? state.reasons[selected]?.summary : undefined} pending={!hasPoll} />
          </div>
        )}
        <Themes
          themes={state.done ? state.themes : []}
          posts={state.posts}
          option={poll && poll.total_opinions > 0 ? option : undefined}
          all={allView && hasPoll ? optionIds : undefined}
          active={themeId}
          onPick={(id) => {
            setThemeId(id);
            setPage(1);
            if (tab === 'leads') setTab('all');
            if (id && !desktop) listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        />
        {state.done && poll?.other_breakdown && poll.other_breakdown.length > 0 && (
          <p className="also-mentioned">
            <span className="muted">Also mentioned in Other: </span>
            {poll.other_breakdown.slice(0, 6).map((b, i) => (
              <span key={b.title}>
                {i > 0 && ', '}
                {b.title} <span className="muted">({num(b.count)})</span>
              </span>
            ))}
          </p>
        )}
        {isThin(state) && (
          <p className="thin-note" role="note">
            {onWiden ? 'Not much data for this question in this time range.' : 'Not much data for this question, so treat the split as a rough read.'}
            {onWiden && (
              <button type="button" className="linkish" onClick={onWiden}>
                Search all time
              </button>
            )}
          </p>
        )}
      </aside>

      {deferPosts ? null : (
        <section className="posts-col" key="posts" ref={listTop}>
          <div className={`eyebrow posts-eyebrow ${theme ? 'crumbed' : ''}`}>
            {tab === 'leads' ? 'Leads' : option || (allView && hasPoll) ? (
              <>
                {option ? (
                  <>
                    <span className="eyebrow-pre">Posts saying</span>
                    <span style={{ color: optionColor(option.id) }} className="eyebrow-opt">
                      {option.title}
                    </span>
                  </>
                ) : (
                  <span className="eyebrow-opt">All opinions</span>
                )}
                {theme && (
                  <>
                    <ChevronRight size={13} className="crumb-sep" aria-hidden="true" />
                    <span className="crumb-theme" title={theme.title}>
                      {theme.title}
                    </span>
                    <button type="button" className="icon-btn crumb-clear" onClick={() => (setThemeId(null), setPage(1))} aria-label={`Clear filter: ${theme.title}`} data-tip="Clear filter">
                      <XIcon size={14} />
                    </button>
                  </>
                )}
              </>
            ) : (
              'Posts'
            )}
          </div>
          <div className="toolbar">
            <div className="segmented" role="tablist">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-label={`${t.name}${t.count == null ? '' : `, ${t.count}`}`}
                  data-tip={t.label ? undefined : t.name}
                  className={`${tab === t.id ? 'on' : ''} seg-${t.id}`}
                  onClick={() => (setTab(t.id), setPage(1))}
                >
                  {t.icon && <span className="seg-ic">{t.icon}</span>}
                  {t.label && <span className="seg-label">{t.label}</span>}
                  <span className="seg-count">{t.count == null ? '–' : num(t.count)}</span>
                </button>
              ))}
            </div>
            <SortMenu value={sort} onChange={(s) => (setSort(s), setPage(1))} />
          </div>

          {tab === 'leads' && (
            <div className="intent-chips">
              <button className={`ichip ${!intent ? 'on' : ''}`} onClick={() => (setIntent(null), setPage(1))}>
                All <span>{num(leads.length)}</span>
              </button>
              {INTENT_ORDER.map((k) => {
                const n = poll?.leads[k] ?? 0;
                if (!n) return null;
                return (
                  <button key={k} className={`ichip ${intent === k ? 'on' : ''}`} style={{ ['--c' as string]: INTENT_META[k].color }} onClick={() => (setIntent(intent === k ? null : k), setPage(1))}>
                    <i /> {INTENT_META[k].label} <span>{num(n)}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className={`post-list ${running ? 'streaming' : ''}`} key={`${listKey}-${running ? 'live' : 'final'}`}>
            {loadingPosts ? (
              <ListWait state={state} />
            ) : tab === 'leads' && desktop ? (
              <LeadsTable posts={shown} communities={state.communities} authors={state.authors} copied={copied} onCopy={onCopy} />
            ) : shown.length ? (
              shown.map((p) => {
                const tag = allView && tab !== 'leads' ? options.find((o) => o.id === p.option) : undefined;
                return (
                  <PostRow
                    key={p.id}
                    post={p}
                    community={p.community ? state.communities[p.community] : undefined}
                    author={p.source === 'reddit' ? state.authors[p.author.handle] : undefined}
                    lead={tab === 'leads'}
                    copied={copied === p.id}
                    onCopy={onCopy}
                    tag={tag ? { title: tag.title, color: optionColor(tag.id) } : undefined}
                  />
                );
              })
            ) : (
              <p className="list-empty">No {tab === 'all' ? '' : tab === 'leads' ? 'leads' : tab === 'x' ? 'X ' : 'Reddit '}posts for this answer yet.</p>
            )}
          </div>

          <div className={`list-foot ${running ? 'pending' : ''}`}>
            <span className="muted">{list.length ? `Showing ${num((cur - 1) * pageSize + 1)}–${num((cur - 1) * pageSize + shown.length)} of ${num(list.length)}` : ' '}</span>
            <Pager page={cur} pages={pages} onPage={go} />
          </div>
        </section>
      )}
    </div>
  );
}
