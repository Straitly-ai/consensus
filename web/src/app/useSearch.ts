import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, streamSearch, type AuthorProfile, type Community, type Done, type Meta, type PlanOption, type Poll, type Post, type Progress, type Reason, type SearchParams, type Theme } from './api';

export type Phase = 'connecting' | 'streaming' | 'done' | 'error' | 'gated';

export interface SearchState {
  phase: Phase;
  meta: Meta | null;
  progress: Progress | null;
  options: PlanOption[];
  poll: Poll | null;
  posts: Record<string, Post>;
  postsVersion: number;
  reasons: Record<string, Reason>;
  themes: Theme[];
  authors: Record<string, AuthorProfile>;
  communities: Record<string, Community>;
  done: Done | null;
  error: { status: number; code: string; message: string } | null;
}

const initial: SearchState = {
  phase: 'connecting',
  meta: null,
  progress: null,
  options: [],
  poll: null,
  posts: {},
  postsVersion: 0,
  reasons: {},
  themes: [],
  authors: {},
  communities: {},
  done: null,
  error: null,
};

type Action =
  | { type: 'reset' }
  | { type: 'events'; events: { event: string; data: any }[] }
  | { type: 'ended' }
  | { type: 'fail'; error: SearchState['error'] };

function reducer(s: SearchState, a: Action): SearchState {
  switch (a.type) {
    case 'reset':
      return initial;
    case 'fail':
      return { ...s, phase: a.error?.code === 'signup_required' ? 'gated' : 'error', error: a.error };
    case 'ended':
      if (s.phase === 'done' || s.phase === 'error') return s;
      return { ...s, phase: 'error', error: { status: 0, code: 'ended', message: 'The search stopped before it finished. Please try again.' } };
    case 'events': {
      const n = { ...s };
      let posts = s.posts;
      let changed = false;
      for (const { event, data } of a.events) {
        switch (event) {
          case 'meta':
            n.meta = data;
            if (n.phase === 'connecting') n.phase = 'streaming';
            break;
          case 'progress':
            n.progress = data;
            break;
          case 'plan':
            n.options = data.options;
            break;
          case 'posts':
            if (!changed) {
              posts = { ...posts };
              changed = true;
            }
            for (const p of data.posts as Post[]) posts[p.id] = p;
            break;
          case 'poll':
            n.poll = data;
            break;
          case 'reasons':
            n.reasons = { ...n.reasons, [data.option_id]: data };
            break;
          case 'themes':
            n.themes = Array.isArray(data?.themes) ? data.themes : [];
            break;
          case 'authors':
            n.authors = { ...n.authors, ...data.profiles };
            break;
          case 'communities':
            n.communities = { ...n.communities, ...data.communities };
            break;
          case 'done':
            n.done = data;
            n.phase = 'done';
            break;
          case 'error':
            n.phase = 'error';
            n.error = { status: 500, code: 'stream_error', message: data?.message ?? 'Something went wrong while building this poll.' };
            break;
        }
      }
      n.posts = posts;
      if (changed) n.postsVersion = s.postsVersion + 1;
      return n;
    }
  }
}

// Whether a search is streaming right now, for controls outside the results page (recent searches).
let live = false;
const liveSubs = new Set<() => void>();
const setLive = (v: boolean) => {
  if (live === v) return;
  live = v;
  liveSubs.forEach((f) => f());
};
export const useSearchRunning = () =>
  useSyncExternalStore(
    (f) => (liveSubs.add(f), () => void liveSubs.delete(f)),
    () => live,
  );

/** Streams one search. Events are batched per animation frame so thousands of posts never block the UI. */
export function useSearch(params: SearchParams | null) {
  const [attempt, setAttempt] = useState(0);
  const [state, dispatch] = useReducer(reducer, initial);
  const key = params ? JSON.stringify(params) : '';
  const quietRetry = useRef(false);
  const busyTries = useRef(0);

  useEffect(() => {
    if (!params) return;
    // A quiet retry keeps the "one search at a time" panel up until the new stream actually starts.
    let pendingReset = quietRetry.current;
    quietRetry.current = false;
    if (!pendingReset) dispatch({ type: 'reset' });
    const ac = new AbortController();
    let queue: { event: string; data: any }[] = [];
    let raf = 0;
    const flush = () => {
      raf = 0;
      const q = queue;
      queue = [];
      if (!q.length) return;
      if (pendingReset) dispatch({ type: 'reset' });
      pendingReset = false;
      dispatch({ type: 'events', events: q });
    };
    streamSearch(
      params,
      (event, data) => {
        queue.push({ event, data });
        if (!raf) raf = requestAnimationFrame(flush);
      },
      ac.signal,
    )
      .then(() => {
        if (ac.signal.aborted) return;
        flush();
        dispatch({ type: 'ended' });
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        flush();
        dispatch({
          type: 'fail',
          error: e instanceof ApiError ? { status: e.status, code: e.code, message: e.message } : { status: 0, code: 'network', message: "Couldn't reach Consensus. Check your connection and try again." },
        });
      });
    return () => {
      ac.abort();
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const running = !!params && (state.phase === 'connecting' || state.phase === 'streaming');
  useEffect(() => {
    setLive(running);
    return () => setLive(false);
  }, [running]);

  // 409: another search of ours holds the slot (often the one just cancelled, released a beat later). Retry quietly a few times.
  useEffect(() => {
    busyTries.current = 0;
  }, [key]);
  useEffect(() => {
    if (state.phase !== 'error' || state.error?.code !== 'search_in_progress' || busyTries.current >= 6) return;
    const t = setTimeout(() => {
      busyTries.current++;
      quietRetry.current = true;
      setAttempt((a) => a + 1);
    }, 1500 + busyTries.current * 1000);
    return () => clearTimeout(t);
    // Keyed on the error object: it changes only when a new 409 lands, never while a retry is in flight.
  }, [state.phase, state.error]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { state, retry };
}
