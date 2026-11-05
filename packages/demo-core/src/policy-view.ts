import { desiredRateLimit } from './rate-policy.js';
import { PolicyModule, WafModule } from './product-state.js';
import { CATALOG } from '../../../scenarios/catalog.js';
import { PolicyViewSchema, type PolicyView } from '../../contracts/src/schemas.js';
import type { LabConfig } from './config.js';
import { desiredCustomWaf } from './custom-waf.js';
import { digestValue } from './deployment-plan.js';
import type { Artifact } from './reports.js';
// Official dashboard product selectors require the presenter's own account/zone choice.
// IDs and exact navigation remain visible; we never guess a zone name or resource route.
const pages = {
  'waf-sqli': ['/:account/:zone/security/security-rules', 'Security', 'Security rules', 'Custom rules or managed rules'],
  'waf-xss': ['/:account/:zone/security/security-rules', 'Security', 'Security rules', 'Custom rules or managed rules'],
  'waf-custom': ['/:account/:zone/security/security-rules', 'Security', 'Security rules', 'Custom rules'],
  'rate-limit': ['/:account/:zone/security/security-rules', 'Security', 'Security rules', 'Rate limiting rules'],
  bot: ['/:account/:zone/security/settings', 'Security', 'Settings', 'Bot Management'],
  turnstile: ['/:account/turnstile', 'Turnstile', 'Select widget', 'Settings'],
  'api-shield': ['/:account/:zone/ssl-tls/client-certificates', 'SSL/TLS', 'Client Certificates', 'mTLS rule'],
  access: ['', 'Zero Trust', 'Access controls', 'Applications', 'Select application', 'Policies'],
  'waiting-room': ['/:account/:zone/traffic/waiting-rooms', 'Traffic', 'Waiting Room', 'Select room', 'Settings'],
  'ddos-evidence': ['/:account/:zone/security/analytics', 'Security', 'Analytics', 'Filter DDoS product events', 'Select evidence window'],
  analytics: ['/:account/:zone/security/analytics', 'Security', 'Analytics', 'Select run window'],
} as const;
const settings: Partial<Record<PolicyView['scenarioId'], readonly string[]>> = {
  'rate-limit': ['Counting key', 'Threshold', 'Counting window', 'Mitigation duration'], bot: ['Policy ID', 'Score visibility', 'Configured action'],
  turnstile: ['Widget ID', 'Verification mode', 'Protected registration route'], 'api-shield': ['Client certificate required', 'Certificate policy ID', 'Protected API route'],
  access: ['Application ID', 'Audience', 'Policy ID', 'Identity requirement'], 'waiting-room': ['Room ID', 'Hostname', 'Route', 'Capacity', 'Session duration'],
  'ddos-evidence': ['Evidence source', 'Window start', 'Window end'], analytics: ['Selected run ID', 'UTC window', 'Event source', 'Sampling'],
};
export function policyViews(config: LabConfig, capture?: { runId: string; artifacts: readonly Artifact[]; historical: boolean; readbackComplete?: boolean }, now = Date.now()): PolicyView[] {
  return CATALOG.map(manifest => {
    const [page, ...navigation] = pages[manifest.id];
    const desired = manifest.id === 'rate-limit' ? desiredRateLimit(config.labId, config.environments[1].origin) : desiredCustomWaf(config.labId, config.environments[1].origin, WafModule.safeParse(manifest.id).success ? WafModule.parse(manifest.id) : 'waf-custom');
    const candidates = capture?.artifacts.filter(a => a.runId === capture.runId && a.scenarioId === manifest.id && a.targetRole === 'after' && a.source === 'configuration' && 'kind' in a.payload && a.payload.kind === 'configuration') ?? [];
    const artifact = candidates.at(-1); const payload = artifact?.payload;
    const rule = payload && 'kind' in payload && payload.kind === 'configuration' ? payload : null;
    const mismatches: string[] = [];
    if (rule && PolicyModule.safeParse(manifest.id).success) {
      if (rule.expression !== desired.expression || rule.afterHostname !== desired.hostname) mismatches.push('Observed hostname/path expression differs from the declared After-only rule');
      if (!rule.enabled) mismatches.push('Observed rule is disabled');
      if (rule.action !== desired.action) mismatches.push('Observed action differs from block');
      if (rule.ref !== desired.ref) mismatches.push('Observed rule reference differs from the owned lab rule');
    }
    if (rule && manifest.id === 'rate-limit') {
      const actual = rule.rateLimit; const expected = desiredRateLimit(config.labId, config.environments[1].origin).ratelimit;
      if (!actual || actual.period !== expected.period || actual.requests_per_period !== expected.requests_per_period || actual.mitigation_timeout !== expected.mitigation_timeout || actual.characteristics.join(',') !== expected.characteristics.join(',') || actual.requests_to_origin === true || (actual.counting_expression !== undefined && actual.counting_expression !== desired.expression)) mismatches.push('Observed rate threshold, window, counting key or mitigation duration differs');
    }
    if (new Set(candidates.map(a => digestValue(a.payload))).size > 1) mismatches.push('Policy readback changed during the captured run');
    const age = artifact ? now - Date.parse(artifact.observedAt) : null;
    const historical = capture?.historical || artifact?.mode === 'saved';
    const state = mismatches.length ? 'mismatch' : !rule || !artifact || capture?.readbackComplete === false || (manifest.id === 'bot' && !rule.botManagement) ? 'unknown' : artifact.mode === 'fixture' ? 'fixture' : historical ? 'saved' : age === null || age < 0 || age > 60000 ? 'stale' : 'last-checked';
    const observed = { state, runId: artifact?.runId ?? null, observedAt: artifact?.observedAt ?? null, digest: rule ? digestValue(rule) : null, name: rule?.ref ?? null, resourceId: rule?.ruleId ?? null, rulesetId: rule?.rulesetId ?? null, version: rule?.rulesetVersion ?? null, enabled: rule?.enabled ?? null, action: rule?.action ?? null, expression: rule?.expression ?? null, priority: null, order: rule?.order ?? null, mode: artifact?.mode ?? null };
    return PolicyViewSchema.parse({ scenarioId: manifest.id, product: manifest.product, desired: [...manifest.configuration, ...(PolicyModule.safeParse(manifest.id).success ? [desired.expression] : [])], before: manifest.expectedBefore, after: manifest.expectedAfter,
      targets: config.environments.map(e => ({ role: e.role, hostname: new URL(e.origin).hostname, paths: [...new Set(manifest.inputs.map(i => i.path))] })),
      settings: manifest.id === 'bot' ? [{ name: 'Policy type', value: rule ? 'Custom WAF rule using Bot Management score' : null }, { name: 'Scored subscription readback', value: rule?.botManagement ? 'Current configuration captured; see mode and time' : null }, { name: 'Action', value: rule?.action ?? null }, { name: 'Score', value: null }] : manifest.id === 'rate-limit' ? [{ name: 'Counting key', value: rule?.rateLimit?.characteristics.join(' + ') ?? null }, { name: 'Threshold', value: rule?.rateLimit ? String(rule.rateLimit.requests_per_period) : null }, { name: 'Counting window seconds', value: rule?.rateLimit ? String(rule.rateLimit.period) : null }, { name: 'Mitigation seconds', value: rule?.rateLimit ? String(rule.rateLimit.mitigation_timeout) : null }] : WafModule.safeParse(manifest.id).success ? [{ name: 'Observed rule type', value: rule ? 'Custom WAF rules; not managed detection' : null }] : (settings[manifest.id] ?? []).map(name => ({ name, value: null })),
      inspection: { url: manifest.id === 'access' ? 'https://one.dash.cloudflare.com/' : `https://dash.cloudflare.com/?to=${page}`, accountId: config.accountId, zoneId: config.zoneId, navigation: ['Select the shown account', ...(page.includes(':zone') ? ['Select the shown zone'] : []), ...navigation], resourceId: rule?.ruleId ?? null, selector: true }, observed, mismatches,
      readinessBlocked: state !== 'last-checked' || rule?.order === undefined || rule.order === null, mitigationVerified: false,
      reason: mismatches.length ? 'Policy mismatch blocks affected readiness; the captured run result is unchanged' : !rule || capture?.readbackComplete === false ? 'Authorized readback unavailable or incomplete; check entitlement, permissions and adapter' : state === 'fixture' ? 'Fixture readback is not a deployed policy check' : state === 'saved' ? 'Historical capture is not current policy readback' : state === 'stale' ? 'Readback expired; run a bounded check before a readiness claim' : 'Captured After rule only; Before policy, priority and behavioral proof need their own checks',
    });
  });
}
