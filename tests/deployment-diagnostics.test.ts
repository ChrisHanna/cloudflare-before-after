import { describe, expect, it } from 'vitest';
import { terraformFailure, DeploymentToolError, ToolFailureSchema } from '../packages/demo-core/src/deployment-diagnostics.js';
import { ApplyRecordSchema } from '../packages/demo-core/src/deployment-store.js';
const secret = 'private-unregistered-tool-canary';
const line = (changes: Record<string, unknown> = {}) => JSON.stringify({ type: 'diagnostic', diagnostic: { severity: 'error', summary: 'failed to make http request', address: 'cloudflare_image_variant.catalog', detail: `POST https://example.invalid/${secret}: 400 Bad Request {"errors":[{"code":5400,"message":"${secret}"}]}`, ...changes } });
describe('allowlisted deployment failure metadata, never raw output', () => {
  it('retains the resource, HTTP status and numeric provider codes only', () => {
    const failure = terraformFailure(line(), 1, false);
    expect(failure).toEqual({ exitCode: 1, stopped: false, diagnostics: [{ reason: 'provider-http', resource: 'cloudflare_image_variant.catalog', httpStatus: 400, providerCodes: [5400] }] });
    const error = new DeploymentToolError(failure);
    expect(JSON.stringify(error)).not.toContain(secret); expect(error.message).not.toContain('example.invalid');
    expect(Object.isFrozen(error.failure.diagnostics[0]!.providerCodes)).toBe(true);
  });
  it('does not retain unknown summaries, addresses, non-JSON logs or fields', () => {
    const failure = terraformFailure(`${secret}\n${line({ summary: secret, address: secret })}\nnot-json`, 1, false);
    expect(failure.diagnostics[0]).toMatchObject({ reason: 'terraform-error', resource: null });
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(() => ToolFailureSchema.parse({ ...failure, raw: secret })).toThrow();
  });
  it('does not collect diagnostics after cancellation or an output cap', () => {
    expect(terraformFailure(line(), null, true)).toEqual({ exitCode: null, stopped: true, processQuiescence: 'unproven', diagnostics: [] });
  });
  it('bounds records and codes, rejects unknown resource indexes and ignores warnings', () => {
    const codes = Array.from({ length: 20 }, (_, i) => `{"code":${i}}`).join(',');
    const many = Array.from({ length: 20 }, () => line({ detail: codes, address: `cloudflare_image_variant.catalog["${secret}"]` })).join('\n');
    const failure = terraformFailure(line({ severity: 'warning' }) + '\n' + many, 1, false);
    expect(failure.diagnostics).toHaveLength(8); expect(failure.diagnostics[0]!.providerCodes).toHaveLength(8);
    expect(failure.diagnostics.every(d => d.resource === null)).toBe(true); expect(JSON.stringify(failure)).not.toContain(secret);
  });
  it('reads legacy apply records and permits only structured safe metadata', () => {
    const legacy = { schemaVersion: 1, planId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', planDigest: 'a'.repeat(64), startedAt: '2026-11-04T00:00:00Z', finishedAt: '2026-11-04T00:00:01Z', status: 'failed', completedSteps: [], resources: [], failure: 'Setup stopped' };
    expect(ApplyRecordSchema.parse(legacy)).not.toHaveProperty('toolFailure');
    expect(ApplyRecordSchema.parse({ ...legacy, toolFailure: terraformFailure(line(), 1, false) }).toolFailure?.diagnostics).toHaveLength(1);
    expect(() => ApplyRecordSchema.parse({ ...legacy, toolFailure: { ...terraformFailure(line(), 1, false), detail: secret } })).toThrow();
  });
});
