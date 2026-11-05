import { describe, expect, it, vi } from 'vitest';
import { renderDeployment } from '../packages/demo-core/src/infrastructure.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';
import { apiShieldModule } from '../packages/demo-core/src/api-shield.js';
import { accessPolicyModule } from '../packages/demo-core/src/access-policy.js';
import { waitingRoomSetupModule } from '../packages/demo-core/src/waiting-room.js';
import { apiOptions, accessOptions } from './api-shield-fixtures.js';

describe('static workshop deployment hooks', () => {
  it('renders paired Turnstile modes and server-only secret requirements without network', () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    try {
      const f = infrastructureFixture();
      const after = { mode: 'test' as const, sitekey: '1x00000000000000000000AA', hostname: new URL(f.settings.origins.after).hostname, action: 'register' as const };
      const result = renderDeployment(f.inventory, { ...f.settings, turnstile: after }, process.cwd());
      const before = result.environments[0]!; const protectedEnv = result.environments[1]!;
      expect(JSON.parse(before.config.vars.TURNSTILE_CONFIG_JSON!)).toEqual({ mode: 'disabled', sitekey: null, hostname: new URL(f.settings.origins.before).hostname, action: 'register' });
      expect(JSON.parse(protectedEnv.config.vars.TURNSTILE_CONFIG_JSON!)).toEqual(after);
      expect(before.requiredSecrets).not.toContain('TURNSTILE_SECRET'); expect(protectedEnv.requiredSecrets).toContain('TURNSTILE_SECRET');
      expect(JSON.stringify(result)).not.toContain('1x0000000000000000000000000000000AA'); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it('rejects a protected verifier on the wrong host or disabled mode', () => {
    const f = infrastructureFixture();
    expect(() => renderDeployment(f.inventory, { ...f.settings, turnstile: { mode: 'test', sitekey: '1x00000000000000000000AA', hostname: 'other.example.test', action: 'register' } }, process.cwd())).toThrow('After hostname');
    expect(() => renderDeployment(f.inventory, { ...f.settings, turnstile: { mode: 'disabled', sitekey: null, hostname: new URL(f.settings.origins.after).hostname, action: 'register' } }, process.cwd())).toThrow('After hostname');
  });
  it('preserves independent optional setup scopes without acquiring providers', () => {
    const api = apiOptions(); const access = accessOptions();
    expect(apiShieldModule(api.policy).expression).not.toContain(new URL(api.policy.beforeOrigin).hostname);
    expect(accessPolicyModule(access.policy).application.domain).toBe('after.lab.example/admin');
    expect(waitingRoomSetupModule({ hostname: 'after.lab.example', path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false, queue_all: false }).phase).toBe('setup-only');
  });
});
