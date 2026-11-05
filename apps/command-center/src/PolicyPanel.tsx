import React from 'react';
import type { PolicyView } from '../../../packages/contracts/src/schemas.js';
const known = (value: string | number | boolean | null) => value === null ? 'Unknown' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value);
export function PolicyPanel({ policy }: { policy: PolicyView | undefined }) {
  return <section className="card contract" aria-label="Policy inspection"><p className="eyebrow">Desired versus observed</p><h2>Policy inspection</h2>{!policy ? <p>Policy readback unavailable.</p> : <>
    <h3>{policy.product}</h3><span className="badge neutral">{policy.observed.state}</span>
    <p className="provenance">{policy.readinessBlocked ? 'Affected policy readiness blocked' : 'Captured policy check only'}</p><p>{policy.reason}</p>
    <div className="paired"><div><h3>Desired · unverified</h3><ul>{policy.desired.map((text, index) => <li key={index}>{text}</li>)}</ul><h4>Before</h4><p>{policy.before}</p><h4>After</h4><p>{policy.after}</p>
      {policy.targets.map(target => <p key={target.role} className="small hostname">{target.role}: {target.hostname} · {target.paths.length ? target.paths.join(', ') : 'Evidence window only'}</p>)}
    </div><div><h3>Captured After readback</h3><dl>{[['Rule reference', policy.observed.name], ['Rule / resource', policy.observed.resourceId], ['Ruleset', policy.observed.rulesetId], ['Version', policy.observed.version], ['Enabled', policy.observed.enabled], ['Action', policy.observed.action], ['Priority', policy.observed.priority], ['Ruleset order', policy.observed.order], ['Mode', policy.observed.mode], ['Observed at', policy.observed.observedAt], ['Run ID', policy.observed.runId], ['Digest', policy.observed.digest]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd className="hostname">{known(value as string | number | boolean | null)}</dd></div>)}</dl><p className="hostname">{policy.observed.expression ?? 'Expression unknown'}</p><p className="small muted">Other Before policies: Unknown. No global bypass is claimed.</p></div></div>
    {policy.settings.length > 0 && <><h3>Product settings · observed</h3><dl>{policy.settings.map(setting => <div key={setting.name}><dt>{setting.name}</dt><dd>{known(setting.value)}</dd></div>)}</dl></>}
    {policy.mismatches.length > 0 && <ul className="error-text" role="alert">{policy.mismatches.map(text => <li key={text}>{text}</li>)}</ul>}
    <a target="_blank" rel="noopener noreferrer" href={policy.inspection.url}>Inspect in Cloudflare ↗</a><p className="small muted">Uses your Cloudflare login. Select the shown account; zone when asked.</p>
    <p className="small hostname">Account {policy.inspection.accountId} · Zone {policy.inspection.zoneId} · Resource {policy.inspection.resourceId ?? 'Unknown'}</p><ol>{policy.inspection.navigation.map((text, index) => <li key={index}>{text}</li>)}</ol>
    <p className="small muted">This link grants no access and proves no mitigation.</p>
  </>}</section>;
}
