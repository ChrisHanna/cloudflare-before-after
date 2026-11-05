import React from 'react';
import type { Catalog, Job } from './api.js';
// Honest, static view of what this lab has deployed. Update it when a profile is applied.
const READY: Record<string, string> = {
  'waf-custom': 'Deployed: custom WAF rule on After',
  'waf-sqli': 'Deployed: inert SQL-signature rule on After',
  'waf-xss': 'Deployed: inert XSS-signature rule on After',
  turnstile: 'Deployed: live Turnstile widget on After /register (real keys, real verification)',
  'rate-limit': 'Deployed: free-plan rate rule on After /api (3 requests per 10 seconds)',
  'analytics': 'Read-only: joins the last run\u2019s request, edge and origin evidence',
};
const SETUP: Record<string, string> = {
  bot: 'Needs Cloudflare Bot Management (Enterprise). Not available on this Free-plan zone.',
  'api-shield': 'Needs API Shield mTLS (Enterprise add-on). Not available on this Free-plan zone.',
  access: 'Available on this plan; needs a service token and the Zero Trust team domain to deploy.',
  'waiting-room': 'Needs Waiting Room (paid add-on, Business plan or higher).',
};
export const isReady = (id: string) => id in READY;
const dashboardZone = (catalog: Catalog | null) => { const after = catalog?.targets.find(t => t.role === 'after'); return catalog?.cloudflare && after ? `https://dash.cloudflare.com/${catalog.cloudflare.accountId}/${new URL(after.origin).hostname.split('.').slice(-2).join('.')}` : null; };
export function TestLibrary({ catalog, job, busy, active, selected, onRun, onSelect, onStop }: { catalog: Catalog | null; job: Job | null; busy: boolean; active: boolean; selected: string; onRun: (id: string) => void; onSelect: (id: string) => void; onStop: () => void }) {
  const scenarios = catalog?.scenarios ?? [];
  const card = (id: string) => {
    const m = scenarios.find(s => s.id === id); if (!m) return null;
    if (id === 'ddos-evidence') { const zone = dashboardZone(catalog); return <article key={id} className="test-card ready" aria-label="DDoS Protection test"><h4>{m.product}</h4><p className="small">Always on for every site on Cloudflare, with nothing to configure. This lab never generates attack traffic, so there is nothing to trigger.</p><p className="small muted">Both sites get the same automatic protection. Check the zone for real detections.</p>{zone ? <a className="button-link" href={`${zone}/security/events`} target="_blank" rel="noopener noreferrer">Open DDoS events in Cloudflare \u2197</a> : <p className="small muted">Link appears once the lab is configured.</p>}</article>; }
    const ready = id in READY; const running = active && job?.command === id;
    return <article key={id} className={`test-card ${ready ? 'ready' : 'setup'}`} aria-label={`${m.product} test`}>
      <h4>{m.product}</h4>
      <p className="small">{m.notes.problem}.</p>
      <p className="small"><strong>Before:</strong> <span className="muted">{m.expectedBefore}</span></p>
      <p className="small"><strong>After:</strong> <span className="muted">{m.expectedAfter}</span></p>
      <p className="small muted">{ready ? READY[id] : SETUP[id]}</p>
      <button aria-pressed={selected === id} onClick={() => onSelect(id)}>{selected === id ? 'Story shown above' : 'Read the story'}</button> <button className={ready ? 'primary' : undefined} disabled={!catalog?.configured || !m.implemented || busy || active || !ready} onClick={() => onRun(id)}>{running ? 'Running\u2026' : ready ? 'Run this test' : 'Needs setup'}</button>
    </article>;
  };
  const ids = scenarios.map(s => s.id as string);
  return <section className="card run-step" aria-labelledby="run-heading">
    <p className="eyebrow">Step 2</p><h2 id="run-heading">Run a test</h2>
    <p>Each test sends bounded, synthetic requests to both sites, then reads Cloudflare&rsquo;s logs and your origin receipts to show what happened. Capped at 100 requests and 2 minutes, lab only.</p>
    {active && <p className="running-bar" role="status">A test is running. <button className="stop" disabled={!!job?.readOnly || busy} onClick={onStop}>Stop</button></p>}
    <h3 className="group-title">Ready now</h3>
    <div className="test-grid">{ids.filter(id => id in READY || id === 'ddos-evidence').map(card)}</div>
    <h3 className="group-title">Needs setup in this lab</h3>
    <div className="test-grid">{ids.filter(id => !(id in READY) && id !== 'ddos-evidence').map(card)}</div>
  </section>;
}
