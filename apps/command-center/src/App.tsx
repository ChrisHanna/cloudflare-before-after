import React, { useEffect, useRef, useState } from 'react';
import { ApiError, ControlClient, type Activity, type Catalog, type CommandRequest, type Job, type Readiness } from './api.js';
import { PolicyPanel } from './PolicyPanel.js';
import { EvidencePanels } from './EvidencePanels.js';
import { ImagesVariantPanel } from './ImagesVariantPanel.js';
import { WaitingRoomPanel } from './WaitingRoomPanel.js';
import { InterviewPanel, ReadinessPanel } from './GuidedPanels.js';
import { ImpactPanel, PaneResult } from './ImpactPanel.js';
import { CloudflareDeepDive } from './CloudflareDeepDive.js';
import { TestLibrary, isReady } from './TestLibrary.js';
import { ActivityFeed } from './ActivityFeed.js';
import { StoryPanel } from './StoryPanel.js';
import './styles.css';
const aggregateNames = new Set(['interview', 'all', 'rehearsal']);
const phaseNames: Record<string, string> = { planned: 'Planned', starting: 'Starting', preflight: 'Preflight', baseline: 'Baseline', protected: 'Protected', correlate: 'Correlate', report: 'Report', cleanup: 'Cleanup', finished: 'Finished' };
const phases = ['preflight', 'baseline', 'protected', 'correlate', 'report', 'cleanup'] as const;
function ageLabel(observedAt: string | null | undefined) {
  if (!observedAt) return 'Unknown time';
  const age = Date.now() - Date.parse(observedAt);
  return !Number.isFinite(age) || age < 0 ? 'Unknown time' : age > 60000 ? 'Stale' : 'Last checked';
}
function deploymentLabel(id: string, catalog: Catalog | null, readiness: Readiness | null, job: Job | null) {
  const entry = catalog?.scenarios.find(item => item.id === id);
  if (entry && !entry.implemented) return 'Unavailable · adapter';
  if (!catalog?.configured) return catalog ? 'Not deployed · lab not configured' : 'Deployment unknown';
  const capturedPolicy = !job?.historical && !job?.readOnly && job?.command === id ? job?.policies?.find(item => item.scenarioId === id && item.observed.runId === job.actualRunId) : undefined;
  const policy = capturedPolicy ?? catalog.policies.find(item => item.scenarioId === id);
  const observed = policy?.observed;
  if (catalog.mode === 'fixture' || observed?.mode === 'fixture') return 'Deployment unknown · fixture';
  if (!observed || observed.state !== 'last-checked' || observed.mode !== 'live' || ageLabel(observed.observedAt) !== 'Last checked') return `Deployment unknown${observed?.state === 'stale' || ageLabel(observed?.observedAt) === 'Stale' ? ' · stale' : ''}`;
  if (observed.enabled === false) return 'Not deployed · policy disabled';
  const scoped = readiness?.scoped;
  const current = scoped?.mode === 'live' && !scoped.historical && ageLabel(scoped.observedAt) === 'Last checked';
  if (observed.enabled && !policy.readinessBlocked && current && scoped.claims.coreDeployed && scoped.includedModules.includes(id) && !scoped.excludedModules.some(item => item.id === id) && !scoped.blockers.some(item => item.claim === 'coreDeployed')) return 'Deployed · last checked';
  return 'Deployment unknown';
}
function PhaseStepper({ job }: { job: Job | null }) {
  const [snapshots, setSnapshots] = useState<{ id: string; phases: string[] } | null>(null);
  useEffect(() => {
    if (!job) { setSnapshots(null); return; }
    setSnapshots(previous => previous?.id === job.id ? { id: job.id, phases: [...new Set([...previous.phases, job.phase])] } : { id: job.id, phases: [job.phase] });
  }, [job?.id, job?.phase]);
  const report = job?.result?.kind === 'result' && 'report' in job.result ? job.result.report : null;
  return <section className="phase-panel" aria-label="Run phases"><div className="section-heading"><h2>Run phases</h2><span className="muted small">{job ? `${job.command} · ${job.status} · ${phaseNames[job.phase] ?? job.phase}` : 'No run selected'}</span></div>
    <ol className="phase-stepper">{phases.map((phase, index) => {
      const current = job?.status === 'running' && job.phase === phase;
      const state = phase === 'cleanup' && report ? report.result.cleanup : phase === 'report' && job?.result ? 'Captured' : job?.phase === phase || (snapshots?.id === job?.id && snapshots?.phases.includes(phase)) ? 'Observed phase' : 'Not observed';
      return <li key={phase} aria-current={current ? 'step' : undefined}><span className="phase-number" aria-hidden="true">{index + 1}</span><strong>{phaseNames[phase]}</strong><span>{state}</span></li>;
    })}</ol><p className="muted small">Only captured phases are shown. Skipped updates are not proof. Cleanup needs a recorded result.</p></section>;
}
function ComparisonStrip({ job }: { job: Job }) {
  const report = job.result?.kind === 'result' && 'report' in job.result ? job.result.report : null;
  const evidence = job.evidence?.runId === job.actualRunId && job.evidence?.scenarioId === job.command ? job.evidence : null;
  const mode = job.historical || job.readOnly || evidence?.mode === 'saved' || report?.mode === 'saved' ? 'Saved evidence' : evidence?.mode === 'fixture' || report?.mode === 'fixture' ? 'Fixture' : 'Captured evidence';
  return <section className="card comparison-strip" aria-label="Run comparison"><div className="section-heading"><div><p className="eyebrow">{mode} / {job.command}</p><h2>Run comparison</h2></div><span className="badge neutral" aria-label="Verdict">{mode} · {report?.result.outcome ?? 'Verdict unknown'}</span></div>
    <div className="paired">{(['before', 'after'] as const).map(role => {
      const latest = job.observations?.filter(item => item.targetRole === role).at(-1);
      const counts = evidence?.roles.find(item => item.role === role);
      const source = counts?.sources.find(item => item.source === 'origin');
      const rules = [...new Set(counts?.actions.map(action => action.ruleId).filter((id): id is string => !!id) ?? [])];
      return <article key={role} aria-label={`${role === 'before' ? 'Before' : 'After'} run summary`}><h3>{role === 'before' ? 'Before' : 'After'}</h3><dl className="summary-facts"><div><dt>HTTP status</dt><dd>{latest ? `HTTP ${latest.status ?? 'unknown'} · ${latest.mode} · ${ageLabel(latest.observedAt)}` : 'Unknown'}</dd></div><div><dt>Edge rule</dt><dd>{rules.length ? rules.map(id => <code key={id}>{id} </code>) : 'Unknown / unavailable'}<span className="muted small">{counts?.sources.filter(item => item.source === 'cloudflare').map(item => ` · ${item.state} · ${ageLabel(item.observedAt)}`)}</span></dd></div><div><dt>Origin receipts</dt><dd>{counts?.originReceived ?? 'Unknown'}<span className="muted small"> · {source?.state ?? 'unavailable'} · {ageLabel(source?.observedAt)}</span></dd></div></dl></article>;
    })}</div><p className="muted small">Recorded evidence, not current health. HTTP status alone proves no mitigation.</p></section>;
}
function ArchitecturePanel({ catalog, readiness }: { catalog: Catalog | null; readiness: Readiness | null }) {
  const services = [
    ['Before Worker', 'before-worker-bindings'], ['After Worker', 'after-worker-bindings'],
    ['Before Container', 'before-containers'], ['After Container', 'after-containers'],
    ['Before D1', 'before-d1'], ['After D1', 'after-d1'], ['Before R2', 'before-r2'], ['After R2', 'after-r2'],
    ['Before Images', 'before-images'], ['After Images', 'after-images'], ['Telemetry', 'telemetry-bindings'], ['WAF policy', 'waf-custom-policy'],
  ];
  return <details className="card architecture" id="architecture" open><summary>Architecture &amp; service readback</summary><h2>Architecture</h2><p className="small muted">Declared routes below. Readback is separate from health. No service health feed is available.</p>
    <svg className="architecture-wide" viewBox="0 0 640 230" role="img" aria-labelledby="architecture-title" aria-describedby="architecture-desc"><title id="architecture-title">Declared paired storefront architecture</title><desc id="architecture-desc">Manual browser traffic goes to Before and After Workers, then Containers, D1, R2 and Images. After has a policy boundary. Telemetry supplies receipts. Lines show declared routes, not observed traffic or health.</desc><g className="architecture-lines"><path d="M320 45V65H150V85M320 65H490V85M150 125V155M490 125V155M150 195V215H490V195" /></g><g className="architecture-boxes"><rect x="240" y="5" width="160" height="40" rx="8"/><rect x="40" y="85" width="220" height="40" rx="8"/><rect x="380" y="85" width="220" height="40" rx="8"/><rect x="40" y="155" width="220" height="40" rx="8"/><rect x="380" y="155" width="220" height="40" rx="8"/></g><g className="architecture-labels"><text x="320" y="30">Manual browser</text><text x="150" y="110">Before Worker</text><text x="490" y="110">After Worker / policy</text><text x="150" y="180">Container · D1 · R2 · Images</text><text x="490" y="180">Container · D1 · R2 · Images</text><text x="320" y="226">Telemetry / receipts</text></g></svg>
    <svg className="architecture-narrow" viewBox="0 0 320 310" role="img" aria-labelledby="architecture-narrow-title" aria-describedby="architecture-narrow-desc"><title id="architecture-narrow-title">Declared paired storefront architecture</title><desc id="architecture-narrow-desc">Declared routes, not measured health. A manual browser visits Before and After Workers, then Containers and D1, R2 and Images. After has a policy boundary. Telemetry supplies receipts.</desc><g className="architecture-lines"><path d="M160 45V65H80V85M160 65H240V85M80 125V155M240 125V155M80 195V225M240 195V225M80 265V285H240V265"/></g><g className="architecture-boxes"><rect x="80" y="5" width="160" height="40" rx="8"/><rect x="5" y="85" width="150" height="40" rx="8"/><rect x="165" y="85" width="150" height="40" rx="8"/><rect x="5" y="155" width="150" height="40" rx="8"/><rect x="165" y="155" width="150" height="40" rx="8"/><rect x="5" y="225" width="150" height="40" rx="8"/><rect x="165" y="225" width="150" height="40" rx="8"/></g><g className="architecture-labels"><text x="160" y="30">Manual browser</text><text x="80" y="110">Before Worker</text><text x="240" y="103">After Worker</text><text x="240" y="119">Policy boundary</text><text x="80" y="180">Container</text><text x="240" y="180">Container</text><text x="80" y="250">D1 · R2 · Images</text><text x="240" y="250">D1 · R2 · Images</text><text x="160" y="307">Telemetry / receipts</text></g></svg>
    <dl className="service-grid">{services.map(([label, id]) => {
      const report = readiness?.report; const check = report?.checks.find(item => item.id === id);
      const provenance = report?.mode === 'fixture' || catalog?.mode === 'fixture' ? 'Fixture' : report?.mode === 'saved' || readiness?.freshness === 'historical' ? 'Historical' : readiness?.freshness === 'stale' || ageLabel(report?.observedAt) === 'Stale' ? 'Stale' : ageLabel(report?.observedAt);
      return <div key={id}><dt>{label}</dt><dd>{check ? `${provenance} · ${check.state}` : 'Readiness unknown'}<span className="muted small"> · Health unknown</span></dd></div>;
    })}</dl></details>;
}
export default function App() {
  const [api] = useState(() => new ControlClient());
  const [authenticated, setAuthenticated] = useState(false); const [checking, setChecking] = useState(true);
  const [pending, setPending] = useState<{ code: string; expiresAt: number } | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null); const [readiness, setReadiness] = useState<Readiness | null>(null); const [activity, setActivity] = useState<Activity | null>(null);
  const [command, setCommand] = useState('waf-custom'); const [scope, setScope] = useState<'catalog' | 'core-waf'>('core-waf');
  const [requests, setRequests] = useState('30'); const [concurrency, setConcurrency] = useState('2'); const [runtime, setRuntime] = useState('60'); const [sessions, setSessions] = useState('8');
  const [consent, setConsent] = useState(false); const [manualConsent, setManualConsent] = useState(false);
  const [views, setViews] = useState<'frames' | 'tabs'>('tabs');
  const [job, setJob] = useState<Job | null>(null); const [plan, setPlan] = useState<string | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [streamStatus, setStreamStatus] = useState('No active stream');
  const [runChoices, setRunChoices] = useState<Job[]>([]); const [journalLimited, setJournalLimited] = useState(false);
  const selectedRun = useRef<{ id: string; readOnly: boolean } | null>(null);
  const submitting = useRef(false); const sequence = useRef(0); const heading = useRef<HTMLHeadingElement>(null);
  const manifest = catalog?.scenarios.find(m => m.id === command);
  const active = job?.status === 'running'; const aggregate = aggregateNames.has(command);
  const implemented = command === 'doctor' || (aggregate ? !!catalog?.aggregates[command as 'interview' | 'all' | 'rehearsal'] : !!manifest?.implemented);
  const requestMax = aggregate ? command === 'interview' ? 100 : 300 : 100;
  const runtimeMax = aggregate ? command === 'interview' ? 300 : 900 : 120;
  const numbers = [requests, concurrency, runtime, ...(command === 'waiting-room' ? [sessions] : [])];
  const valid = numbers.every(v => /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))) && Number(requests) <= requestMax && Number(concurrency) <= 4 && Number(runtime) <= runtimeMax && (command !== 'waiting-room' || Number(sessions) <= 8);
  const runReport = job?.result?.kind === 'result' && 'report' in job.result ? job.result.report : null;
  const policy = (job?.policies ?? catalog?.policies)?.find(p => p.scenarioId === command);
  const notes = (job?.command === command ? runReport?.notes : undefined) ?? manifest?.notes;
  const outcome = runReport?.result.outcome ?? (job?.result?.kind === 'doctor' ? job.result.report.preflightReady ? 'preflight passed' : 'preflight not ready' : job?.result?.kind === 'result' && 'outcome' in job.result ? job.result.outcome : job?.status ?? 'Not run');
  const fail = (failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) { api.clear(); setAuthenticated(false); setPending(null); setError('Session ended. Connect again; active work is not restarted.'); }
    else setError(failure instanceof Error ? failure.message : 'Local request could not complete');
  };
  async function loadLocal() {
    const [nextCatalog, nextReadiness, runs, journals] = await Promise.all([api.catalog(), api.readiness(), api.runs(), api.journalRuns()]);
    setCatalog(nextCatalog); setReadiness(nextReadiness); setRunChoices([...runs.runs, ...journals.runs]); setJournalLimited(journals.truncated);
    const recent = selectedRun.current ?? (runs.activeRunId ? { id: runs.activeRunId, readOnly: false } : runs.runs.at(-1) ? { id: runs.runs.at(-1)!.id, readOnly: false } : journals.runs[0] ? { id: journals.runs[0].id, readOnly: true } : null);
    if (recent) { selectedRun.current = recent; const next = await (recent.readOnly ? api.journalJob(recent.id) : api.job(recent.id)); if (selectedRun.current?.id === recent.id) { sequence.current = next.eventSequence; setJob(next); if (next.status === 'running' && !next.readOnly) setCommand(next.command); } }
  }
  useEffect(() => {
    let mounted = true;
    api.session().then(() => { if (mounted) setAuthenticated(true); }).catch(() => {}).finally(() => { if (mounted) setChecking(false); });
    return () => { mounted = false; };
  }, [api]);
  useEffect(() => {
    if (!authenticated) return;
    let mounted = true;
    loadLocal().then(() => { if (mounted && document.activeElement === document.body) heading.current?.focus(); }).catch(failure => { if (mounted) fail(failure); });
    return () => { mounted = false; };
  }, [authenticated, api]);
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [runs, journals] = await Promise.all([api.runs(), api.journalRuns()]);
        if (disposed) return; setRunChoices([...runs.runs, ...journals.runs]); setJournalLimited(journals.truncated);
        const selected = selectedRun.current;
        if (selected) { const next = await (selected.readOnly ? api.journalJob(selected.id) : api.job(selected.id)); if (!disposed && selectedRun.current?.id === selected.id) { sequence.current = Math.max(sequence.current, next.eventSequence); setJob(next); } }
      } catch (failure) { if (!disposed) fail(failure); }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000); return () => { disposed = true; clearTimeout(timer); };
  }, [authenticated, api]);
  useEffect(() => {
    if (!pending || authenticated) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= pending.expiresAt) { setPending(null); setError('Sign-in request expired. Request a new matching code.'); return; }
      try {
        const status = await api.signInStatus();
        if (cancelled) return;
        if (!status.pending && status.authenticated) { await api.session(); if (!cancelled) { setPending(null); setAuthenticated(true); setError(''); } return; }
        timer = setTimeout(poll, 700);
      } catch (failure) { if (!cancelled) { setPending(null); fail(failure); } }
    };
    timer = setTimeout(poll, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pending, authenticated, api]);
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const next = await api.activity(); if (!disposed) setActivity(next); } catch { /* the feed shows its own unavailable state */ }
      if (!disposed) timer = setTimeout(poll, 6000);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [authenticated, api]);
  useEffect(() => {
    if (!authenticated || !job || job.readOnly || job.status !== 'running') { setStreamStatus('No active stream'); return; }
    const id = job.id; let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource(`/api/runs/${id}/events?after=${sequence.current}`);
    const refresh = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => { timer = undefined; api.job(id).then(next => { if (!disposed) { sequence.current = Math.max(sequence.current, next.eventSequence); setJob(next); if (next.status !== 'running') api.readiness().then(setReadiness).catch(fail); } }).catch(fail); }, 40);
    };
    events.onopen = () => { if (!disposed) setStreamStatus('Connected'); };
    events.onerror = () => { if (!disposed) { setStreamStatus('Reconnecting — work is not restarted'); refresh(); } };
    const update = (event: Event) => {
      try { const data = JSON.parse((event as MessageEvent<string>).data) as { id: number }; if (!Number.isSafeInteger(data.id) || data.id < sequence.current) return; sequence.current = data.id; refresh(); } catch { setError('An update was invalid. Refresh the local view.'); }
    };
    for (const type of ['phase', 'started', 'observation', 'evidence', 'result', 'snapshot']) events.addEventListener(type, update);
    return () => { disposed = true; events.close(); if (timer) clearTimeout(timer); };
  }, [authenticated, job?.id, job?.status, api]);
  async function connect(event: React.FormEvent) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true; setBusy(true); setError('');
    try { setPending(await api.requestSignIn()); } catch (failure) { fail(failure); }
    finally { submitting.current = false; setBusy(false); }
  }
  function select(value: string) {
    setCommand(value); setConsent(false); setPlan(null); setError('');
    const entry = catalog?.scenarios.find(m => m.id === value);
    setRequests(String(aggregateNames.has(value) ? value === 'interview' ? 100 : 300 : entry?.budget.requests ?? 30));
    setRuntime(String(aggregateNames.has(value) ? value === 'interview' ? 300 : 900 : (entry?.budget.maxRuntimeMs ?? 60000) / 1000));
    setConcurrency(String(entry?.budget.concurrency ?? 2)); setSessions(String(entry?.budget.sessions || 8));
  }
  function request(): CommandRequest {
    return { command, ...(command === 'doctor' ? { scope } : {}), limits: { requests: Number(requests), concurrency: Number(concurrency), maxRuntimeSeconds: Number(runtime), ...(command === 'waiting-room' ? { sessions: Number(sessions) } : {}) } };
  }
  async function execute(dry: boolean) {
    if (submitting.current || active || !valid || (!dry && (!consent || !implemented))) return;
    submitting.current = true; setBusy(true); setError(''); setPlan(null);
    try {
      if (dry) { const response = await api.plan(request()); setPlan(response.plan ? `${response.plan.executable ? 'Local plan valid' : 'Adapter unavailable'}. No network calls. Not verified.` : response.error ?? 'Local plan unavailable'); }
      else { const next = await api.start(request(), crypto.randomUUID()); selectedRun.current = { id: next.id, readOnly: false }; sequence.current = 0; setJob(next); }
    } catch (failure) { fail(failure); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function runScenario(id: string) {
    const entry = catalog?.scenarios.find(m => m.id === id);
    if (submitting.current || active || !catalog?.configured || !entry?.implemented) return;
    const limits = { requests: Math.min(100, Math.max(entry.budget.requests, 60)), concurrency: entry.budget.concurrency, maxRuntimeSeconds: Math.min(120, Math.max(60, Math.round(entry.budget.maxRuntimeMs / 1000))), ...(id === 'waiting-room' ? { sessions: entry.budget.sessions || 8 } : {}) };
    setCommand(id); setConsent(true); setRequests(String(limits.requests)); setConcurrency(String(limits.concurrency)); setRuntime(String(limits.maxRuntimeSeconds)); setPlan(null);
    submitting.current = true; setBusy(true); setError('');
    try { const next = await api.start({ command: id, limits }, crypto.randomUUID()); selectedRun.current = { id: next.id, readOnly: false }; sequence.current = 0; setJob(next); }
    catch (failure) { fail(failure); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function stop() {
    if (!job || job.readOnly || !active || submitting.current) return;
    submitting.current = true; setBusy(true);
    try { await api.stop(job.id); setJob(await api.job(job.id)); } catch (failure) { fail(failure); }
    finally { submitting.current = false; setBusy(false); }
  }
  const comparison = <section aria-labelledby="storefront-heading"><div className="section-heading"><div><p className="eyebrow">Step 1</p><h2 id="storefront-heading">Compare the pair</h2></div><span className="muted small">Same declared release, different policies</span></div>
    <div className="view-controls"><button className="primary" disabled={!catalog?.configured} onClick={() => { setManualConsent(true); setViews('frames'); }}>Start live side-by-side view</button><label className="check"><input type="checkbox" checked={manualConsent} onChange={event => { setManualConsent(event.target.checked); if (!event.target.checked) setViews('tabs'); }} />Allow manual storefront view traffic</label><button aria-pressed={views === 'frames'} disabled={!manualConsent || !catalog?.configured} onClick={() => setViews('frames')}>Load inline views</button><button aria-pressed={views === 'tabs'} disabled={!manualConsent || !catalog?.configured} onClick={() => setViews('tabs')}>Use paired tabs</button></div>
    <p className="muted small">No pages open on their own. Manual traffic is separate from scripted evidence.</p>
    <div className="paired">{(['before', 'after'] as const).map(role => { const target = catalog?.targets.find(t => t.role === role); const latest = job?.observations?.filter(o => o.targetRole === role).at(-1); return <article className={`card target ${role}`} key={role} aria-label={`${role === 'before' ? 'Before' : 'After'} storefront`}><div className="target-title"><h3>{role === 'before' ? 'Before' : 'After'}</h3><span className="badge neutral">{latest ? `HTTP ${latest.status ?? 'unknown'}` : 'Unverified'}</span></div><p>{role === 'before' ? 'Baseline synthetic storefront' : 'Protected synthetic storefront'}</p>{latest && <p className="small muted">{latest.mode} · {ageLabel(latest.observedAt)} · not current health</p>}<p className="hostname">{target?.origin ?? 'Target unavailable'}</p><p className="release-line small muted">Release <code>{target?.releaseDigest ?? 'Unknown'}</code></p>{target && <a className="tab-link" role="link" tabIndex={0} href={manualConsent ? target.origin : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!manualConsent} onKeyDown={event => { if (!manualConsent && event.key === 'Enter') { event.preventDefault(); setError('Allow manual view traffic before opening a storefront.'); } }} onClick={event => { if (!manualConsent) { event.preventDefault(); setError('Allow manual view traffic before opening a storefront.'); } }}>Open {role === 'before' ? 'Before' : 'After'} in tab ↗</a>}{manualConsent && views === 'frames' && target && <iframe key={`${job?.id}:${job?.status}`} title={`${role === 'before' ? 'Before' : 'After'} live storefront view`} src={target.origin} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />}{views === 'tabs' && <p className="fallback" role="status">Paired-tab mode. Use the tab link above.</p>}{views === 'frames' && <p className="fallback">If this pane is blocked by frame policy, use paired tabs.</p>}<PaneResult job={job} role={role} /><ActivityFeed role={role} activity={activity} /></article>; })}</div>
  </section>;
  return <main className="shell">
    <header className="masthead"><div><p className="eyebrow">Security workshop / control plane</p><h1 ref={heading} tabIndex={-1}>Cloudflare Command Center</h1><p className="intro">One app. Two policy boundaries. Evidence, not status-code guesses.</p></div><span className="badge neutral">Local only</span></header>
    {!authenticated ? <section className="card sign-in" aria-labelledby="connect-heading"><p className="eyebrow">Presenter access</p><h2 id="connect-heading">Connect this browser</h2><p>Match the browser code in your local server terminal.</p><p>No Cloudflare credentials belong in this page.</p><form onSubmit={connect}><button className="primary" disabled={checking || busy || !!pending}>Connect browser</button></form>{pending && <div className="code-panel"><span>Browser sign-in code</span><output aria-label="Browser sign-in code">{pending.code}</output><p role="status">Waiting for matching-code terminal approval.</p></div>}</section> : <>
      <section className="overview" aria-label="Lab summary"><div><span className={`badge ${catalog?.mode === 'fixture' ? 'warning' : 'neutral'}`}>{!catalog ? 'Local data loading · state unknown' : catalog.mode === 'fixture' ? 'FIXTURE · no live Cloudflare proof' : 'Live lab · proof still required'}</span><p>{!catalog ? 'Loading local declarations. No target traffic is started.' : catalog.configured ? 'Declared targets loaded. Start a bounded check to collect evidence.' : 'Lab not configured. Configure an owned runtime before starting.'}</p></div><button onClick={() => { setError(''); loadLocal().catch(fail); }} disabled={busy}>Refresh local view</button></section>
      <section className="readiness-bar" aria-label="Last readiness check"><strong>Last preflight</strong><span>{readiness?.report ? `${readiness.report.scope}: ${readiness.report.preflightReady ? 'passed' : 'not ready'} · ${readiness.freshness}` : 'No check available'}</span><span className="muted">No automatic Cloudflare refresh. No mitigation claim.</span>{readiness?.policyReadinessBlocked && <strong>Policy readiness blocked</strong>}</section>
      <nav className="demo-guide" aria-label="Interview flow"><p className="eyebrow">Interview flow</p><ol><li><a href="#story-heading">The story</a></li><li><a href="#storefront-heading">1. Compare the pair</a></li><li><a href="#run-heading">2. Run the test</a></li><li><a href="#impact-heading">3. See the impact</a></li><li><a href="#deeper-heading">4. Go deeper in Cloudflare</a></li><li><a href="#console-heading">Presenter console</a></li></ol></nav>
      <StoryPanel catalog={catalog} scenario={manifest} runnable={isReady(command) && command !== 'ddos-evidence'} busy={busy} active={active} onSelect={select} onRun={() => void runScenario(command)} />
      {comparison}
      <TestLibrary catalog={catalog} job={job} busy={busy} active={active} selected={command} onSelect={id => { select(id); document.getElementById('story')?.scrollIntoView(); }} onRun={id => void runScenario(id)} onStop={() => void stop()} />
      <PhaseStepper job={job} />
      <ImpactPanel job={job} />
      <CloudflareDeepDive catalog={catalog} job={job} />
      <h2 id="console-heading" className="console-heading">Presenter console</h2><p className="small muted">Scenario choices, limits, policies, run history and full evidence for deeper questions.</p>
      <div className="workbench"><section className="card" aria-labelledby="scenario-heading"><p className="eyebrow">Repeatable execution</p><h2 id="scenario-heading">Scenario &amp; limits</h2><form onSubmit={event => { event.preventDefault(); void execute(false); }}>
        <label className="field">Scenario<select value={command} disabled={!catalog || active || busy} onChange={event => select(event.target.value)}>{catalog?.scenarios.map(m => <option key={m.id} value={m.id}>{m.product} / {m.id} — {deploymentLabel(m.id, catalog, readiness, job)}</option>)}<option value="doctor">Doctor / readiness checks</option><option value="interview">Interview playlist{catalog?.aggregates.interview ? '' : ' — unavailable'}</option><option value="all">All demos{catalog?.aggregates.all ? '' : ' — unavailable'}</option><option value="rehearsal">Rehearsal{catalog?.aggregates.rehearsal ? '' : ' — unavailable'}</option></select></label>
        {command === 'doctor' && <label className="field">Doctor scope<select value={scope} disabled={active || busy} onChange={e => setScope(e.target.value as 'catalog' | 'core-waf')}><option value="core-waf">Core-WAF subset</option><option value="catalog">Full catalog</option></select></label>}
        <p className="scenario-state" role="status">{manifest ? deploymentLabel(command, catalog, readiness, job) : command === 'doctor' ? 'Read-only readiness checks · not a deployment' : 'Deployment unknown · sequence readiness is separate'}</p>{command === 'waiting-room' && <p className="small muted">Waiting Room needs its own queue and admission proof. WAF readiness does not qualify it.</p>}
        <details className="advanced" open><summary>Advanced limits</summary><div className="limit-grid"><label className="field">Request cap<input type="number" min="1" max={requestMax} step="1" required value={requests} disabled={active || busy} onChange={e => setRequests(e.target.value)} /></label><label className="field">Concurrency<input type="number" min="1" max="4" step="1" required value={concurrency} disabled={active || busy} onChange={e => setConcurrency(e.target.value)} /></label><label className="field">Runtime seconds<input type="number" min="1" max={runtimeMax} step="1" required value={runtime} disabled={active || busy} onChange={e => setRuntime(e.target.value)} /></label>{command === 'waiting-room' && <label className="field">Browser sessions<input type="number" min="1" max="8" step="1" required value={sessions} disabled={active || busy} onChange={e => setSessions(e.target.value)} /></label>}</div>
        <p className="small muted">Caps include probes, retries and evidence lookups. A small cap may not fit minimum proof.</p></details>{!valid && <p className="error-text" role="alert">Use whole numbers within the shown hard limits.</p>}
        <label className="check traffic-consent"><input type="checkbox" checked={consent} disabled={active || busy} onChange={e => setConsent(e.target.checked)} />Allow bounded demo traffic to this lab</label>
        <div className="actions"><button className="primary" type="submit" disabled={!catalog?.configured || !implemented || !consent || !valid || busy || active}>Start scenario</button><button type="button" disabled={!catalog?.configured || !valid || busy || active} onClick={() => void execute(true)}>Dry run</button><button className="stop" type="button" disabled={!active || job?.readOnly || busy} onClick={() => void stop()}>Stop run</button></div>
        {!implemented && <p className="unavailable" role="status">Unavailable adapter. Its requirements remain visible; no success is simulated.</p>}{plan && <p className="plan-result" role="status">{plan}</p>}
      </form></section>
      <aside className="card contract" aria-labelledby="proof-heading">{notes && <section className="notes" aria-label="Presenter notes"><p className="eyebrow">Customer story</p><h2>Presenter notes</h2><div className="note-grid"><div><h3>Problem</h3><p>{notes.problem}</p></div><div><h3>Solution</h3><p>{notes.solution}</p></div><div><h3>Limits</h3><p>{notes.limitations}</p></div><div><h3>Architecture question</h3><p>{notes.question}</p></div></div></section>}<details open><summary>Expected proof &amp; prerequisites</summary><p className="eyebrow">Declared contract</p><h2 id="proof-heading">Expected proof</h2>{manifest ? <><h3>{manifest.product}</h3><p className="small muted">Declared setup, not live policy readback.</p><h4>Before</h4><p>{manifest.expectedBefore}</p><h4>After</h4><p>{manifest.expectedAfter}</p><details open><summary>Prerequisites</summary><ul>{[...manifest.entitlements, ...manifest.permissions].map((text, i) => <li key={i}>{text}</li>)}</ul></details><details><summary>Configuration</summary><ul>{manifest.configuration.map(text => <li key={text}>{text}</li>)}</ul></details><details open><summary>Proof criteria</summary><ul>{manifest.proofPredicates.map(text => <li key={text}>{text}</li>)}</ul></details></> : <p>{command === 'doctor' ? 'Read-only configuration checks and safe allowed probes. A subset pass does not verify the interview or full workshop.' : 'The guided adapter must be implemented and qualified before this sequence can run.'}</p>}</details></aside></div>
      {job && <ComparisonStrip job={job} />}
      <ArchitecturePanel catalog={catalog} readiness={readiness} />
      {manifest && policy && <details className="card" open><summary>Policy inspection</summary><PolicyPanel policy={policy} /></details>}
      <details className="card" aria-label="Local run history" open><summary>Run history ({runChoices.length})</summary><section><label className="field">Recent runs<select value={job?.id ?? ''} disabled={busy} onChange={event => {
        const selected = runChoices.find(run => run.id === event.target.value); if (!selected) return;
        selectedRun.current = { id: selected.id, readOnly: selected.readOnly };
        (selected.readOnly ? api.journalJob(selected.id) : api.job(selected.id)).then(next => { if (selectedRun.current?.id === next.id) { sequence.current = next.eventSequence; setJob(next); } }).catch(fail);
      }}><option value="" disabled>No captured run</option>{[...new Map([...(job ? [job] : []), ...runChoices].map(run => [run.id, run])).values()].map(run => <option key={run.id} value={run.id}>{run.readOnly ? 'CLI · read-only' : 'Control'} / {run.command} / {run.actualRunId ?? run.id}</option>)}</select></label>
        {journalLimited && <p className="small muted">Journal scan limited. Some captures are unavailable.</p>}{job?.readOnly && <><p className="provenance">CLI-owned · read-only. Stop rights remain with its owner.</p><p className="small muted">Journal state only. Process health is unknown.</p>{job.capturedOutcome && !runReport && <p>Journal outcome: {job.capturedOutcome}. Final report unavailable.</p>}</>}
      </section></details>
      {catalog?.imageVariant && <details className="card"><summary>Images dependency</summary><ImagesVariantPanel view={catalog.imageVariant} /></details>}
      {(readiness?.scoped || command === 'waiting-room' || command === 'interview') && <ReadinessPanel view={readiness?.scoped ?? null} />}
      {(command === 'interview' || job?.command === 'interview') && <InterviewPanel runId={job?.id ?? 'no-run'} view={job?.interview ?? null} readOnly={!job || job.readOnly || job.status !== 'running'} onAdvance={async () => { if (!job || job.readOnly || job.status !== 'running') return; await api.advance(job.id); const next = await api.job(job.id); if (selectedRun.current?.id === next.id) setJob(next); }} />}
      {(command === 'waiting-room' || job?.waitingRoom) && <WaitingRoomPanel key={job?.id ?? 'no-run'} runId={job?.actualRunId ?? 'no-run'} result={job?.waitingRoom ?? null} historical={!!job?.historical || !!job?.readOnly} frameScopes={job?.frameScopes ?? []} navigationPaths={job?.navigationPaths ?? []} navigateShopper={async (scope, path, signal) => { if (!job || job.readOnly || job.status !== 'running') throw new Error('Owned active run required'); await api.navigateShopper(job.id, scope, path, signal); const next = await api.job(job.id); if (selectedRun.current?.id === next.id) setJob(next); }} loadPreview={async (sessionId, signal) => { if (!job || job.readOnly) throw new Error('Owned preview unavailable'); const scope = job.frameScopes?.find(s => s.sessionId === sessionId); if (scope && job.waitingRoom) return api.frame(job.id, scope, job.waitingRoom.mode, signal); return api.preview(job.id, sessionId, signal); }} />}
      {job?.result?.kind === 'aggregate' && <section className="card" aria-label="Catalog outcomes"><h2>Catalog outcomes</h2><p>{job.result.result.mode === 'fixture' ? 'FIXTURE — not live readiness' : 'LIVE observations'}</p><p>Requests: {job.result.result.requestsUsed} · Runtime: {Math.ceil(job.result.result.durationMs / 1000)} seconds</p><p>Sequence: {job.result.result.sequenceCompleted ? 'Completed' : 'Incomplete'} · Required proof: {job.result.result.allRequiredVerified ? 'Verified' : 'Incomplete'}</p><ul>{job.result.result.items.map(item => <li key={item.scenarioId}>{item.scenarioId}: {item.outcome} · Cleanup: {item.cleanup}{item.reason ? ` · ${item.reason}` : ''}</li>)}</ul><ul>{job.result.result.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></section>}
      {job?.result?.kind === 'interview' && <section className="card" aria-label="Interview outcomes"><h2>Interview outcomes</h2><p>{job.result.result.mode === 'fixture' ? 'FIXTURE — not live readiness' : 'LIVE observations'}</p><p>Requests: {job.result.result.requestsUsed} · Runtime: {Math.ceil(job.result.result.durationMs / 1000)} seconds</p><ol>{job.result.result.stages.map(stage => <li key={stage.id}>{stage.id}: {stage.outcome}{stage.fallbackLabel ? ' · SAVED EVIDENCE' : ''}<ul>{stage.missingProof.map((m, i) => <li key={i}>{m}</li>)}</ul></li>)}</ol></section>}
      {job?.evidence && <details className="card" open><summary>Evidence counts &amp; sources</summary><EvidencePanels job={job} /></details>}
      {job && <section className="card results" aria-labelledby="results-heading"><div className="section-heading"><div><p className="eyebrow">Retained comparison</p><h2 id="results-heading">Run result</h2></div><span className="badge neutral">{job ? outcome : 'Not run'}</span></div><p className="run-status" role="status" aria-live="polite">{active ? job.readOnly ? 'CLI capture · read-only' : `${phaseNames[job.phase] ?? job.phase} · ${streamStatus}` : job ? job.status === 'cancelled' ? 'Cancelled · observations retained' : `Retained view · ${job.status} · ${outcome}` : 'No scenario has run in this view.'}</p>{job && <p className="small muted">Job <code>{job.id}</code> · {job.actualRunId ? <>Run <code>{job.actualRunId}</code></> : 'Waiting for runner metadata'}</p>}{runReport && <><p className="provenance">{runReport.mode === 'fixture' ? 'FIXTURE evidence — not a live Cloudflare result' : job?.historical || runReport.mode === 'saved' ? 'SAVED EVIDENCE — not live' : 'LIVE observations — inspect the linked proof'}</p><p>Requests used: <strong>{runReport.result.requestsUsed}</strong></p>{runReport.botSummary && <section aria-label="Bot observations"><h3>Bot observations</h3><p>Declared client: {runReport.botSummary.userAgent}</p><p>Score: {runReport.botSummary.score ?? 'Unknown'} · Action: {runReport.botSummary.action ?? 'Unknown'} · Classification: {runReport.botSummary.classification}</p><p>Scored subscription: {runReport.botSummary.subscriptionReadback}</p><p className="small muted">No fingerprint evasion or assumed blocking.</p></section>}{runReport.rateLimitSummary && <section aria-label="Rate signal counts"><h3>After rate signals</h3><p>Admitted: {runReport.rateLimitSummary.admitted ?? 'Unknown'} · Mitigated: {runReport.rateLimitSummary.mitigated ?? 'Unknown'} · Unknown: {runReport.rateLimitSummary.unknown ?? 'Unknown'}</p><p>Shared key: {runReport.rateLimitSummary.sharedKeyContamination} · Cooldown until: {runReport.rateLimitSummary.cooldownUntil ?? 'Unknown'}</p><p className="small muted">Counts exclude allowed controls. No counter reset was sent.</p></section>}{runReport.result.missingProof.length > 0 && <ul className="missing">{runReport.result.missingProof.map((text, i) => <li key={i}>{text}</li>)}</ul>}</>}{job?.error && <p className="error-text">{job.error}</p>}{job?.observations?.length ? <div className="table-scroll" tabIndex={0} aria-label="Request comparison"><table><caption>Scripted HTTP observations</caption><thead><tr><th>Role</th><th>Status</th><th>Latency ms</th><th>Ray ID</th></tr></thead><tbody>{job.observations.map(o => <tr key={o.id}><td>{o.targetRole}</td><td>{o.status ?? 'Unknown'}</td><td>{o.latencyMs.toFixed(1)}</td><td><code>{o.rayId ?? 'Unknown'}</code></td></tr>)}</tbody></table></div> : null}{job?.reportId && <a href={`/api/reports/${job.reportId}/html`} target="_blank" rel="noopener noreferrer">Open captured comparison report ↗</a>}</section>}

    </>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    <footer>$100 monthly lab planning limit. This is not a provider billing cap. No 403, 429 or Ray ID alone proves mitigation.</footer>
  </main>;
}
