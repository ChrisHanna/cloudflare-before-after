import React, { useEffect, useRef, useState } from 'react';
import type { WaitingRoomResult } from '../../../packages/demo-core/src/waiting-room.js';
import type { BrowserFrameScope, BrowserPreview } from '../../../packages/demo-core/src/browser-transport.js';
import { BrowserPreviewSchema, observedCounts, safePreviewText, validateBrowserFrame } from './workshop-views.js';

export interface WaitingRoomPanelProps {
  runId: string; result: WaitingRoomResult | null; historical: boolean;
  loadPreview: (sessionId: string, signal: AbortSignal) => Promise<BrowserPreview>;
  frameScopes?: readonly BrowserFrameScope[];
  navigationPaths?: readonly string[];
  navigateShopper?: (scope: BrowserFrameScope, path: string, signal: AbortSignal) => Promise<void>;
}
export function WaitingRoomPanel({ runId, result, historical, loadPreview, frameScopes, navigationPaths = [], navigateShopper }: WaitingRoomPanelProps) {
  const [preview, setPreview] = useState<BrowserPreview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState(''); const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null); const generation = useRef(0);
  useEffect(() => {
    generation.current++; request.current?.abort(); setPreview(null); setSelected(null); setMessage(''); setLoading(false);
    return () => { generation.current++; request.current?.abort(); };
  }, [runId, historical]);
  // Hold one bounded preview only; frames expire even without a new render.
  useEffect(() => {
    if (preview?.kind !== 'frame') return;
    const timer = setTimeout(() => { setPreview(null); setMessage('Preview expired. Inspect the owned session again.'); }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);
  useEffect(() => {
    if (preview?.kind === 'frame') {
      const scope = frameScopes?.find(s => s.sessionId === preview.sessionId && s.runId === runId);
      try { if (!scope || !result?.sessions.some(s => s.sessionId === preview.sessionId && s.state !== 'closed')) throw new Error('Unowned'); validateBrowserFrame(preview, scope, result.mode); }
      catch { setPreview(null); }
    }
  }, [frameScopes, result, runId, preview]);
  useEffect(() => {
    if (selected && !result?.sessions.some(s => s.sessionId === selected)) {
      generation.current++; request.current?.abort(); setSelected(null); setPreview(null); setLoading(false);
    }
  }, [result, selected]);
  async function inspect(sessionId: string) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const version = ++generation.current; setSelected(sessionId); setPreview(null); setMessage(''); setLoading(true);
    const deadline = setTimeout(() => controller.abort(), 5000);
    try {
      const next = BrowserPreviewSchema.parse(await loadPreview(sessionId, controller.signal));
      if (next.sessionId !== sessionId || next.mode !== result?.mode) throw new Error('Preview scope mismatch');
      if (next.kind === 'frame') {
        const scope = frameScopes?.find(s => s.sessionId === sessionId && s.runId === runId);
        if (!scope || !result?.sessions.some(s => s.sessionId === sessionId && s.state !== 'closed')) throw new Error('Unowned frame');
        validateBrowserFrame(next, scope, result.mode);
      } else if (Date.parse(next.observedAt) > Date.now() + 5000) throw new Error('Future preview');
      if (!controller.signal.aborted && version === generation.current) setPreview(next);
    } catch {
      if (version === generation.current) setMessage('Preview unavailable. Inspect the runner-owned browser window.');
    } finally { clearTimeout(deadline); if (version === generation.current) setLoading(false); }
  }
  async function shop(sessionId: string, path: string) {
    const scope = frameScopes?.find(s => s.sessionId === sessionId && s.runId === runId);
    if (historical || !scope || !navigateShopper || !navigationPaths.includes(path) || result?.sessions.find(s => s.sessionId === sessionId)?.state !== 'admitted') return;
    request.current?.abort(); generation.current++; setPreview(null);
    const controller = new AbortController(); request.current = controller; setLoading(true);
    const version = generation.current; const timer = setTimeout(() => controller.abort(), 5000);
    try { await navigateShopper(scope, path, controller.signal); if (version === generation.current) setMessage('Owned shopper navigation complete. Await runner receipt evidence.'); }
    catch { if (version === generation.current) setMessage('Owned shopper navigation unavailable.'); }
    finally { clearTimeout(timer); if (version === generation.current) setLoading(false); }
  }
  const counts = result ? observedCounts(result) : null;
  const mismatchedCounts = result && counts && (Object.keys(counts) as (keyof typeof counts)[]).some(key => counts[key] !== result.counts[key]);
  return <section className="card" aria-label="Waiting Room sessions">
    <h2>Waiting Room sessions</h2>
    <p className="provenance">{historical ? 'SAVED EVIDENCE — historical session records, not live' : result?.mode === 'fixture' ? 'FIXTURE — no live Cloudflare readiness proof' : 'Runner session observations — live proof still required'}</p>
    <p>Queue pages and continuing shoppers, not origin overload.</p>
    <dl className="note-grid">{(['queued', 'admitted', 'unknown'] as const).map(key => <div key={key}><dt>{key}</dt><dd data-session-count={key}>{counts?.[key] ?? 'Unknown'}</dd></div>)}</dl>
    <p>Preview alone never proves admission or readiness.</p>
    {mismatchedCounts && <p role="alert">Runner counts differ from session records. Readiness is unproven.</p>}
    {!result?.sessions.length && <p role="status">No runner session records available.</p>}
    <div className="paired">{result?.sessions.map(session => <article className="card" key={session.sessionId} aria-label={`${session.sessionId} ${session.role} session`}>
      <h3>{session.sessionId} · {session.role}</h3>
      <p>Observed state: <strong>{session.lastObservedState}</strong></p><p>Browser state: {session.state}</p>
      <p>Queue position: Unavailable · Wait estimate: Unavailable</p>
      <p>Cookie continuity: {session.cookieContinuity ? 'preserved' : 'broken'}</p>
      <button type="button" disabled={historical || loading && selected === session.sessionId} onClick={() => void inspect(session.sessionId)}>Inspect {session.sessionId} preview</button>
      <p className="small muted">Reads the latest capture. Does not refresh the storefront.</p>
      {session.state === 'admitted' && navigationPaths.slice(0, 16).map(path => <button key={path} type="button" disabled={historical || loading || !navigateShopper || !frameScopes?.some(scope => scope.sessionId === session.sessionId && scope.runId === runId)} onClick={() => void shop(session.sessionId, path)}>Shop {session.sessionId} {path}</button>)}
      <details><summary>{session.sessionId} transition timeline</summary><ol>{session.transitions.map((transition, i) => <li key={i}>
        <span>{transition.from} → {transition.to}</span> · <time dateTime={transition.observedAt}>{transition.observedAt}</time>
        {transition.requestId && <span> · Request <code>{transition.requestId}</code></span>}
      </li>)}</ol></details>
    </article>)}</div>
    <div role="status" aria-live="polite">{loading ? 'Loading cached preview' : message}</div>
    {preview && <section aria-label={`${preview.sessionId} captured preview`}>
      <h3>{preview.sessionId} {preview.kind === 'frame' ? 'masked page frame' : 'captured page text'}</h3>
      <p>{preview.mode === 'fixture' ? 'FIXTURE' : 'LIVE CAPTURE'} · <time dateTime={preview.observedAt}>{preview.observedAt}</time></p>
      {preview.kind === 'frame' ? <><p>Actual owned page pixels. Private fields masked before capture.</p><img alt={`${preview.sessionId} masked owned session`} src={preview.frame} width={preview.width} height={preview.height} referrerPolicy="no-referrer" /></> : <><p>{Date.now() - Date.parse(preview.observedAt) > 15000 ? 'Stale capture' : 'Latest capture'} · Captured text, not a live frame. Inspect the actual browser.</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{safePreviewText(preview.text)}</pre></>}
      <button type="button" onClick={() => { generation.current++; request.current?.abort(); setPreview(null); setSelected(null); setLoading(false); }}>Clear captured preview</button>
    </section>}
    {result && <><p>Runner outcome: {result.mode === 'fixture' && result.outcome === 'verified' ? 'inconclusive — fixture cannot verify live readiness' : result.outcome}</p><p>{result.limitation}</p>
      <ul>{[...result.missingProof, ...result.contradictions].map((text, i) => <li key={i}>{text}</li>)}</ul></>}
  </section>;
}
