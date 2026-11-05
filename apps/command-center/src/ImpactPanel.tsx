import React from 'react';
import type { Job } from './api.js';
const BLOCKING = /block|challenge|managed|js_challenge/i;
const EDGE = new Set(['waf-custom', 'waf-sqli', 'waf-xss', 'rate-limit', 'bot', 'api-shield', 'access']);
export function PaneResult({ job, role }: { job: Job | null; role: 'before' | 'after' }) {
  const last = job?.observations?.filter(o => o.targetRole === role).at(-1);
  if (!job || !last) return <p className="pane-result small muted" role="status">No test run yet. Run one below and this pane reports what this site did.</p>;
  const counts = job.evidence?.roles.find(r => r.role === role);
  const blocked = counts?.actions.some(a => BLOCKING.test(a.action)) ?? false;
  const stopped = counts?.originAbsent ?? 0;
  return <p className={`pane-result ${blocked ? 'blocked' : 'served'}`} role="status"><strong>{blocked ? 'Cloudflare blocked the test request' : 'Served the test request'}</strong> · {job.command} · HTTP {last.status ?? 'unknown'}{stopped ? ` · ${stopped} never reached the origin` : ''}{job.status === 'running' ? ' · run in progress' : ''}</p>;
}
export function ImpactPanel({ job }: { job: Job | null }) {
  const evidence = job?.evidence;
  if (!job || !evidence) return <section className="card impact" id="impact" aria-labelledby="impact-heading"><p className="eyebrow">Step 3</p><h2 id="impact-heading">See the impact</h2><p className="muted" role="status">Run the test to see what Cloudflare did to each site.</p></section>;
  const roles = (['before', 'after'] as const).map(role => {
    const counts = evidence.roles.find(r => r.role === role);
    const last = job.observations?.filter(o => o.targetRole === role).at(-1);
    const actions = counts?.actions ?? [];
    const tally = new Map<string, number>();
    for (const o of job.observations?.filter(item => item.targetRole === role) ?? []) tally.set(String(o.status ?? 'no response'), (tally.get(String(o.status ?? 'no response')) ?? 0) + 1);
    return { role, counts, status: last?.status ?? null, actions, blocked: actions.some(a => BLOCKING.test(a.action)), tally: [...tally.entries()].sort((a, b) => b[1] - a[1]) };
  });
  const [before, after] = roles as [typeof roles[number], typeof roles[number]];
  const proven = after.blocked && !before.blocked;
  const edge = EDGE.has(job.command);
  const outcome = job.result?.kind === 'result' && 'report' in job.result ? job.result.report.result.outcome : job.status;
  const origin = (r: typeof before) => r.counts?.originAbsent ? `${r.counts.originAbsent} request${r.counts.originAbsent === 1 ? '' : 's'} never reached your origin` : r.counts?.originReceived ? `All ${r.counts.originReceived} request${r.counts.originReceived === 1 ? '' : 's'} reached your origin` : 'Origin delivery unknown';
  return <section className="card impact" id="impact" aria-labelledby="impact-heading">
    <p className="eyebrow">Step 3</p><h2 id="impact-heading">See the impact</h2>
    <p className="impact-headline" role="status">{edge ? (proven ? 'Cloudflare stopped the test request on After at the edge. Before served the same request normally.' : 'No blocking was observed for this run. Read the missing proof before claiming protection.') : `${job.command} finished with outcome: ${outcome}. This test is not an edge block, so read the evidence and missing proof below.`}</p>
    <div className="impact-grid">{roles.map(r => <article key={r.role} className={`impact-card ${r.blocked ? 'blocked' : 'served'}`} aria-label={`${r.role === 'before' ? 'Before' : 'After'} impact`}>
      <h3>{r.role === 'before' ? 'Before' : 'After'}</h3>
      <p className="impact-verdict">{r.blocked ? 'Blocked at the edge' : 'Served'}</p>
      <p className="impact-status">HTTP {r.status ?? 'unknown'}</p>
      {r.tally.length > 0 && <p className="small" aria-label="Responses seen">Responses seen: {r.tally.map(([status, n]) => `${n} \u00d7 ${status}`).join(', ')}</p>}
      <ul className="small"><li>{origin(r)}</li><li>Cloudflare edge events: {r.counts?.edgeEvents ?? 'unknown'}</li>{r.actions.map((a, i) => <li key={i}>{a.action} by {a.product}{a.ruleId ? <> · rule <code>{a.ruleId.slice(0, 8)}</code></> : null}</li>)}</ul>
    </article>)}</div>
    {edge && proven && <ul className="value-list" aria-label="Why this matters"><li><strong>No application change.</strong> The rule lives in Cloudflare. The storefront code is identical on both sites.</li><li><strong>Stopped before your origin.</strong> The blocked request never used your compute or reached your database.</li><li><strong>Provable.</strong> The edge event, Ray ID and missing origin receipt tell the same story.</li></ul>}
    <p className="small muted">Counts come from this run only. A status code alone never proves mitigation; the edge event and missing origin receipt do.</p>
  </section>;
}
