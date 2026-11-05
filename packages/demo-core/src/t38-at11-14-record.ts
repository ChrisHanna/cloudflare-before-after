import { randomUUID } from 'node:crypto';
import { AcceptanceSchema, type ScenarioResult } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { ArtifactSchema, type Artifact } from './reports.js';

export const AT_REQUIREMENTS = {
  'AT-11A': ['11.1', '11.2', '11.3', '11.4', '11.5', '11.7', '11.9'],
  'AT-11B': ['11.3', '11.8', '11.9', '11.10'],
  'AT-12A': ['12.1', '12.2', '12.6', '12.8'],
  'AT-12B': ['12.3', '12.4', '12.5', '12.7'],
  'AT-13A': ['13.1', '13.2', '13.3', '13.4', '13.5', '13.6', '13.8'],
  'AT-13B': ['13.7', '13.8'],
  'AT-14A': ['14.1', '14.2', '14.3', '14.4', '14.5'],
  'AT-14B': ['14.6'],
} as const;
export type AtId = keyof typeof AT_REQUIREMENTS;
/** Exact design gates. A partial suite names every unexecuted predicate rather
 * than hiding them behind one permanently false placeholder. These records are
 * fixture-only and never authenticate live execution or qualify readiness. */
export const AT_PREDICATES: Record<AtId, readonly string[]> = {
  'AT-11A': ['paired-hostname-release-views', 'selected-policy-limits-proof-before-start', 'ui-runner-same-run-id', 'unique-correlated-container-counts', 'actions-rules-match-evidence', 'final-comparison-retained', 'pending-stale-unavailable-times', 'unknown-never-zero-or-verified', 'refresh-reconnect-zero-dispatch', 'frame-refusal-paired-tabs-unchanged-policy'],
  'AT-11B': ['cli-contract-all-six-controls', 'duplicate-one-run', 'stop-no-new-dispatch', 'dry-run-no-client-or-browser', 'keyboard-controls-text-outcomes', 'unauthorized-origin-csrf-before-runner', 'no-secrets-responses-streams', 'cards-match-at13-runner-records'],
  'AT-12A': ['both-binding-readbacks-release-parity', 'owned-d1-product-read', 'r2-detail-read', 'owned-image-browser-decode', 'actual-container-operation-receipts', 'equivalent-content-digests', 'run-scoped-d1-write-read', 'run-scoped-r2-write-read', 'missing-binding-names-block-readiness'],
  'AT-12B': ['both-environments-two-runs-two-scenarios', 'foreign-read-update-cleanup-denied', 'container-state-separated', 'cleanup-only-owned-temporary-data', 'catalog-image-digests-unchanged', 'repeat-setup-inventory-seed-counts-stable'],
  'AT-13A': ['independent-actual-contexts', 'baseline-unqueued-launch-product', 'q-qualified-visible-queue', 'distinct-a-shops-while-q-queued', 'q-same-context-later-admitted', 'waiting-room-scope-readback', 'transition-times-render-container-receipts', 'in-memory-cookie-continuity-no-values', 'session-request-time-caps'],
  'AT-13B': ['no-transition-blocks-verification', 'missing-receipt-blocks-verification', 'request-time-exhaustion-stops-traffic', 'broken-cookie-continuity-blocks', 'actual-observations-inspectable', 'fallback-labeled-saved', 'no-interview-readiness-from-negative-test'],
  'AT-14A': ['all-manifest-products-settings', 'enabled-action-host-path-difference', 'safe-link-exact-navigation-resource-id', 'own-login-no-embedded-credentials', 'observation-times-desired-live-labels', 'missing-entitlement-read-explicit', 'panel-readback-report-agreement'],
  'AT-14B': ['hostname-enabled-action-mismatch-blocks', 'unreadable-config-unverified', 'description-link-ray-status-not-proof', 'actual-result-retained'],
};
export interface AtCheck { name: string; passed: boolean; evidenceIds?: string[] }
/** Partial fixture records retain unmet contract gates; no full AT pass is claimed. */
export function atRecord(input: {
  id: AtId; checks: readonly AtCheck[]; artifacts?: readonly Artifact[];
  result?: ScenarioResult; releaseDigest: string; durationMs: number;
  requestsUsed: number; secrets?: readonly string[];
}) {
  if (!input.checks.length) throw new Error('Executable assertions required');
  const artifacts = (input.artifacts ?? []).map(a => ArtifactSchema.parse(a));
  const ids = new Set(artifacts.map(a => a.id));
  const runId = input.result?.runId ?? artifacts[0]?.runId ?? randomUUID();
  if (artifacts.some(a => a.mode !== 'fixture' || a.runId !== runId)) throw new Error('Foreign acceptance evidence');
  for (const check of input.checks) if (check.evidenceIds?.some(id => !ids.has(id))) throw new Error('Unlinked acceptance evidence');
  const record = AcceptanceSchema.parse({
    schemaVersion: 1, id: input.id, mode: 'fixture', requirements: AT_REQUIREMENTS[input.id],
    runId, releaseDigest: input.releaseDigest,
    observedConfigDigest: input.result?.observedConfigDigest ?? null,
    assertions: [...input.checks.map(c => ({ ...c, evidenceIds: c.evidenceIds ?? [...ids].slice(0, 100) })), ...AT_PREDICATES[input.id].filter(name => !input.checks.some(c => c.name === name)).map(name => ({ name, passed: false, evidenceIds: [] }))],
    requestsUsed: input.requestsUsed, durationMs: input.durationMs,
    outcome: input.checks.some(c => !c.passed) ? 'failed' : AT_PREDICATES[input.id].every(name => input.checks.some(c => c.name === name && c.passed)) ? 'passed' : 'unavailable',
  });
  const redactor = new Redactor(input.secrets ? [...input.secrets] : []);
  return AcceptanceSchema.parse(JSON.parse(redactor.serialize(AcceptanceSchema, record)));
}
