import React from 'react';
import type { Catalog } from './api.js';
import { isReady } from './TestLibrary.js';
const TRACK = [
  ['Problem', 'One storefront, two identical deployments. Before has no edge protection; After sits behind Cloudflare.'],
  ['Action', 'Send the same bounded, synthetic test traffic to both and watch each site live.'],
  ['Proof', 'Cloudflare edge events plus missing origin receipts show the blocked request never reached the app.'],
  ['Value', 'No code change. The control lives at the edge and is repeatable from Terraform and Wrangler.'],
] as const;
const DECISIONS = [
  ['Reviewed deploys', 'Every change is a saved plan, approved by typing its digest. Source edits invalidate stale plans.'],
  ['Owned resources only', 'Resources are tagged to this lab. Nothing is overwritten and teardown is documented.'],
  ['Cost guardrail', 'A $100 monthly planning ceiling blocks any plan that would exceed it. No upgrade is silently bought.'],
  ['Honest evidence', 'A status code alone is never treated as proof. Each result is labelled live, saved or fixture.'],
  ['Least privilege', 'Cloudflare credentials stay out of the browser. Separate reader, collector and deployer roles.'],
  ['Real products only', 'Tests that need an Enterprise entitlement say so instead of faking a pass.'],
] as const;
export function StoryPanel({ catalog, scenario, runnable, busy, active, onRun, onSelect }: { catalog: Catalog | null; scenario?: Catalog['scenarios'][number] | undefined; runnable: boolean; busy: boolean; active: boolean; onRun: () => void; onSelect: (id: string) => void }) {
  const track = scenario ? [['Problem', scenario.notes.problem], ['Before', scenario.expectedBefore], ['After', scenario.expectedAfter], ['Limits', scenario.notes.limitations]] as const : TRACK;
  return <section className="card story" id="story" aria-labelledby="story-heading">
    <p className="eyebrow">The story in 60 seconds</p>
    <label className="field story-picker">Pick a test to walk through<select value={scenario?.id ?? ''} disabled={!catalog || busy || active} onChange={event => onSelect(event.target.value)}>{!scenario && <option value="">Overview</option>}{catalog?.scenarios.map(item => <option key={item.id} value={item.id}>{item.product}{isReady(item.id) || item.id === 'ddos-evidence' ? '' : ' \u2014 needs setup'}</option>)}</select></label>
    <h2 id="story-heading">{scenario ? `${scenario.product}: same app, one change at the edge` : 'Same app. One change at the edge. Provable difference.'}</h2>
    <ol className="talk-track">{track.map(([label, text]) => <li key={label}><strong>{label}</strong><span>{text}</span></li>)}</ol>
    <div className="story-actions"><button className="primary" disabled={!catalog?.configured || !runnable || busy || active} onClick={onRun}>{active ? 'A test is running\u2026' : runnable ? (scenario ? `Run the ${scenario.product} test` : 'Run the headline demo (custom WAF)') : 'Needs setup in this lab'}</button>{scenario && <span className="muted small">Question to ask: {scenario.notes.question}</span>}</div>
    <details className="decisions"><summary>Engineering decisions worth asking about</summary><dl>{DECISIONS.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl></details>
  </section>;
}
