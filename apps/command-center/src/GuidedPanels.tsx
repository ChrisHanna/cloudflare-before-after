import React, { useEffect, useRef, useState } from 'react';
import { INTERVIEW_STAGES, type InterviewView, type ScopedReadiness } from './workshop-views.js';

export function InterviewPanel({ runId, view, readOnly, onAdvance }: {
  runId: string; view: InterviewView | null; readOnly: boolean; onAdvance: () => Promise<void>;
}) {
  const [advancing, setAdvancing] = useState(false); const [error, setError] = useState('');
  const pending = useRef(false); const version = useRef(0);
  useEffect(() => { version.current++; pending.current = false; setAdvancing(false); setError(''); return () => { version.current++; }; }, [runId]);
  async function advance() {
    if (pending.current || readOnly || !view || view.mode === 'saved' || view.state !== 'running' || view.stageIndex === 4) return;
    pending.current = true; setAdvancing(true); setError(''); const current = version.current;
    try { await onAdvance(); }
    catch { if (version.current === current) setError('Advance failed. Stage state is unchanged until the next snapshot.'); }
    finally { if (version.current === current) { pending.current = false; setAdvancing(false); } }
  }
  const stage = view ? INTERVIEW_STAGES[view.stageIndex] : null;
  return <section className="card" aria-label="Interview agenda">
    <h2>Five-minute interview</h2>
    <ol>{INTERVIEW_STAGES.map((s, i) => <li key={s.start} aria-current={view?.stageIndex === i ? 'step' : undefined}>
      {s.name} · {s.start / 1000}–{s.end / 1000} seconds
    </li>)}</ol>
    {!view ? <p>Stage snapshot unavailable. No interview readiness claim.</p> : <>
      <p className="provenance">{view.mode === 'saved' ? 'SAVED EVIDENCE' : view.mode === 'fixture' ? 'FIXTURE' : 'LIVE observations'}</p>
      <h3>{stage!.name}</h3><p>Purpose: {view.purpose}</p><p>Demo action: {view.action}</p>
      <p>Stage outcome: {view.stageOutcome} · {view.state}</p>
      <p>Remaining at snapshot: {Math.ceil(Math.max(0, stage!.end - view.elapsedMs) / 1000)} seconds</p>
      <p>Total time left: {Math.ceil(Math.max(0, 300000 - view.elapsedMs) / 1000)} seconds · Requests used: {view.requestsUsed}/100</p>
      <p>Observed: <time dateTime={view.observedAt}>{view.observedAt}</time>. Server deadlines do not reset.</p>
      <ul>{view.talkingPoints.map((text, i) => <li key={i}>{text}</li>)}</ul><p>Architecture question: {view.question}</p>
      <button type="button" disabled={readOnly || view.mode === 'saved' || view.state !== 'running' || view.stageIndex === 4 || advancing} onClick={() => void advance()}>Advance interview stage</button>
      <p>Use Stop run to stop owned traffic. No stage restarts.</p>
      {view.fallback && <aside aria-label="Saved stage fallback"><strong>SAVED EVIDENCE — not live stage success</strong><p>Captured: {view.fallback.capturedAt} · {view.fallback.eligible ? 'Matching fallback' : 'Historical only'}</p></aside>}
      <ul>{view.missingProof.map((text, i) => <li key={i}>{text}</li>)}</ul>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
const claimLabels = {
  coreDeployed: 'Core deployed', deploymentVerified: 'Deployment verified', interviewVerified: 'Interview verified',
  workshopVerified: 'Workshop verified', fallbackAvailable: 'Fallback available',
} as const;
export function ReadinessPanel({ view }: { view: ScopedReadiness | null }) {
  return <section className="card" aria-label="Scoped readiness claims"><h2>Readiness claims</h2>
    <p>Core deployment, interview, workshop and fallback are separate claims.</p>
    {view ? <><p className="provenance">{view.historical || view.mode === 'saved' ? 'HISTORICAL — not current readiness' : view.mode === 'fixture' ? 'FIXTURE — not deployed proof' : 'LIVE readback'}</p>
      <p>Observed: {view.observedAt} · {Date.now() - Date.parse(view.observedAt) > 60000 ? 'Stale readback' : Date.now() < Date.parse(view.observedAt) ? 'Future readback — unverified' : 'Last checked'}</p><p>Included modules: {view.includedModules.join(', ') || 'None'}</p>
      <ul>{view.excludedModules.map(module => <li key={module.id}>{module.id}: {module.reason}</li>)}</ul></> : <p>No scoped readiness snapshot available.</p>}
    <dl>{(Object.keys(claimLabels) as (keyof typeof claimLabels)[]).map(key => {
      const blockers = view?.blockers.filter(b => b.claim === key) ?? [];
      const age = view ? Date.now() - Date.parse(view.observedAt) : Infinity;
      const current = view && !view.historical && view.mode === 'live' && age >= 0 && age <= 60000;
      const allowed = key === 'fallbackAvailable' ? view?.mode !== 'fixture' : current;
      const value = !view ? 'Unknown' : view.claims[key] && allowed && !blockers.length ? 'Passed' : 'Blocked';
      return <div key={key}><dt>{claimLabels[key]}</dt><dd>{value}{blockers.length > 0 && <ul>{blockers.map((b, i) => <li key={i}>{b.reason}</li>)}</ul>}</dd></div>;
    })}</dl><p>A fallback or local test does not prove live readiness.</p>
  </section>;
}
