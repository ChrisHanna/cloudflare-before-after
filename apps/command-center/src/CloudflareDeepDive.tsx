import React from 'react';
import type { Catalog, Job } from './api.js';
export function CloudflareDeepDive({ catalog, job }: { catalog: Catalog | null; job: Job | null }) {
  const cf = catalog?.cloudflare; const after = catalog?.targets.find(t => t.role === 'after');
  const ray = job?.observations?.filter(o => o.targetRole === 'after' && o.rayId).at(-1)?.rayId ?? null;
  const base = cf ? `https://dash.cloudflare.com/${cf.accountId}` : '';
  const zone = after ? new URL(after.origin).hostname.split('.').slice(-2).join('.') : '';
  const worker = cf?.workers.find(w => w.role === 'after')?.name;
  const links = cf && after ? [
    { label: 'Security events', href: `${base}/${zone}/security/events`, why: 'Every request Cloudflare blocked, with the rule and Ray ID.' },
    { label: 'Custom WAF rules', href: `${base}/${zone}/security/waf/custom-rules`, why: 'The rule that did it. Change it and it applies in seconds.' },
    { label: 'Traffic analytics', href: `${base}/${zone}/analytics/traffic`, why: 'Requests by status, path and country across the zone.' },
    ...(worker ? [{ label: 'After Worker metrics', href: `${base}/workers/services/view/${worker}/production/metrics`, why: 'Invocations, errors and latency for the protected site.' }] : []),
  ] : [];
  return <section className="card deeper" id="deeper" aria-labelledby="deeper-heading">
    <p className="eyebrow">Step 4</p><h2 id="deeper-heading">Go deeper in Cloudflare</h2>
    {!links.length ? <p className="muted" role="status">Dashboard links appear once the lab is configured.</p> : <>
      <p>Open the dashboard to see the same events in Cloudflare itself. Sign in to your Cloudflare account; this page never handles credentials.</p>
      {ray && <p className="ray">Filter Security events by this Ray ID: <code>{ray}</code></p>}
      <ul className="deeper-links">{links.map(l => <li key={l.label}><a className="button-link" href={l.href} target="_blank" rel="noopener noreferrer">{l.label} ↗</a><span className="small muted">{l.why}</span></li>)}</ul>
    </>}
  </section>;
}
