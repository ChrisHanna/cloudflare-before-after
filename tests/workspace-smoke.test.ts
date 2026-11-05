import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONTRACT_VERSION } from '../packages/contracts/src/index.js';
import { assertSupportedNode } from '../packages/demo-core/src/index.js';
import config from '../playwright.config.js';
describe('workspace-smoke', () => {
  it('pins real workspace boundaries', () => {
    for (const name of ['command-center', 'control-server', 'storefront-worker', 'storefront-container']) {
      const p = JSON.parse(readFileSync(`apps/${name}/package.json`, 'utf8'));
      expect(p.private).toBe(true);
      expect(p.name).toBe(`@lab/${name}`);
    }
    expect(CONTRACT_VERSION).toBe(1);
  });
  it('checks supported Node versions', () => {
    expect(() => assertSupportedNode('22.12.0')).not.toThrow();
    expect(() => assertSupportedNode('24.0.0')).not.toThrow();
    for (const v of ['20.19.0', '22.11.0', '23.0.0', 'invalid']) expect(() => assertSupportedNode(v)).toThrow();
  });
  it('binds browser test servers to loopback', () => {
    expect(config.webServer).toMatchObject({ url: 'http://127.0.0.1:4173', reuseExistingServer: false });
    expect((config.webServer as { command: string }).command).toContain('tests/browser/start-fixture.mjs');
    expect(config.webServer).toMatchObject({ env: { LAB_UI_FIXTURE: '1' } });
    expect(readFileSync('apps/control-server/src/server.ts', 'utf8')).toContain("server.listen(port, '127.0.0.1'");
  });
});
