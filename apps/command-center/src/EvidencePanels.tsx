import React from 'react';
import type { Job } from './api.js';
const count = (value: number | null) => value === null ? 'Unknown' : String(value);
export function EvidencePanels({ job }: { job: Job | null }) {
  const evidence = job?.evidence;
  return <section className="card results" aria-label="Run evidence">
    <p className="eyebrow">Run-scoped sources</p><h2>Evidence counts</h2>
    {!evidence ? <p role="status">Evidence unavailable. Counts are unknown.</p> : <>
      <p className="provenance">{evidence.mode === 'fixture' ? 'FIXTURE' : job?.historical || evidence.mode === 'saved' ? 'SAVED EVIDENCE' : 'LIVE capture'} · {evidence.scenarioId}</p>
      <p className="small muted">Run <code>{evidence.runId}</code></p>
      <p className="small muted">Window <time>{evidence.startedAt}</time> → <time>{evidence.endedAt}</time></p>
      <p className="small muted">Scripted HTTP only; setup and evidence reads excluded.</p>
      <div className="paired">{evidence.roles.map(role => <article key={role.role} aria-label={`${role.role === 'before' ? 'Before' : 'After'} evidence counts`}>
        <h3>{role.role === 'before' ? 'Before' : 'After'}</h3>
        <dl className="limit-grid">{[['Requests', role.requests], ['Origin received', role.originReceived], ['Origin absent', role.originAbsent], ['Origin unknown', role.originUnknown], ['Edge events', role.edgeEvents], ['Rule IDs', role.rules]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd data-count={label}>{count(value as number | null)}</dd></div>)}</dl>
        <ul className="small">{role.sources.map(source => <li key={source.source}>{source.source}: <strong>{source.state}</strong>{source.sampling && <> · sampling {source.sampling}</>} · <time>{source.observedAt ?? 'Unknown time'}</time></li>)}</ul>
        {role.actions.length > 0 && <div className="table-scroll" tabIndex={0}><table><caption>Observed edge actions</caption><thead><tr><th>Product</th><th>Action</th><th>Rule ID</th><th>Events</th></tr></thead><tbody>{role.actions.map((action, index) => <tr key={index}><td>{action.product}</td><td>{action.action}</td><td><code>{action.ruleId ?? 'Unknown'}</code></td><td>{action.count}</td></tr>)}</tbody></table></div>}
        <details><summary>Evidence artifacts ({role.evidenceIds.length})</summary><ul>{role.evidenceIds.map(id => <li key={id}><a target="_blank" rel="noopener noreferrer" href={`/api/${job?.readOnly ? 'journal-runs' : 'runs'}/${job?.id}/evidence/${id}`}>{id}</a></li>)}</ul></details>
      </article>)}</div>
      <p className="small muted">Observed counts are not a mitigation verdict.</p>
    </>}
  </section>;
}
