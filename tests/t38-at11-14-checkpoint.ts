/** Saved call-2 checkpoint. Fixture evidence only; this file is not a test pass. */
export const T38_CHECKPOINT = {
  schemaVersion: 1,
  status: 'incomplete',
  projectRoot: '/mnt/c/users/NotAPC/Desktop/cloudflare_before_after',
  taskChecked: false,
  liveQualification: 'not_run',
  finalTests: {
    command: 'cd /mnt/c/users/NotAPC/Desktop/cloudflare_before_after && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/ot KIROCREW_SCRATCH=/tmp/t38v.zSwO TMPDIR=/tmp/t38v.zSwO node node_modules/vitest/vitest.mjs run tests/t38-at11-14-control.test.ts tests/t38-at11-14-services.test.ts tests/t38-at11-14-queue.test.ts tests/t38-at11-14-browser.test.ts tests/at38-live-harness.test.ts tests/at38-joined-queue.test.ts tests/at38-production-boundaries.test.ts --maxWorkers=1',
    exitCode: 1, total: 44, passed: 42, failed: 2,
    evidencePath: '/tmp/t38v.zSwO/tests.log',
  },
  typechecks: [
    { command: 'cd /mnt/c/users/NotAPC/Desktop/cloudflare_before_after && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/ot KIROCREW_SCRATCH=/tmp/t38t.WQeQ TMPDIR=/tmp/t38t.WQeQ node node_modules/typescript/bin/tsc --noEmit', exitCode: 0, evidencePath: '/tmp/t38t.WQeQ/root.log' },
    { command: 'cd /mnt/c/users/NotAPC/Desktop/cloudflare_before_after && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/ot KIROCREW_SCRATCH=/tmp/t38t.WQeQ TMPDIR=/tmp/t38t.WQeQ node node_modules/typescript/bin/tsc -p apps/storefront-worker/tsconfig.json --noEmit', exitCode: 0, evidencePath: '/tmp/t38t.WQeQ/worker.log' },
  ],
  earlierAttemptLogs: ['/tmp/t38b.nE0E/tests.log', '/tmp/t38d.uD9C/tests.log', '/tmp/t38e.bEg8/tests.log', '/tmp/t38f.0XcT/tests.log', '/tmp/t38g.ScDo/tests.log', '/tmp/t38h.Sjdy/tests.log', '/tmp/t38i.7FW2/tests.log', '/tmp/t38j.3d5D/tests.log'],
  sourceSha256: {
    'packages/demo-core/src/t38-at11-14-harness.ts': 'a0a7f5e35dcc290c6315f08740b88aecd6079c63f37737a7f4c293420c407f85',
    'packages/demo-core/src/t38-at11-14-record.ts': '6b0fa4d6838f2df20ffacaebd2b0e1499745f5721aa1a40994764b87f9fdbaa0',
    'tests/t38-at11-14-bindings.ts': 'a0283e3a5db535d0d0299320c55c8320a31e4b745dfede4b9d6e3d704563fe13',
    'tests/t38-at11-14-browser.test.ts': '0cf4d8fb0923159f074aec0038ba388b46b6ab3006444c43e1b114e8618eb8d0',
    'tests/t38-at11-14-control.test.ts': '30aaf35eee25b2d219dc37ba8c03a181306e8d486d07dfe5ae720b01551ea15c',
    'tests/t38-at11-14-queue.test.ts': 'a2bfaa3497e08e08053ae5b2e3d335a9a82d3a8fc452b636a947532177efb0f9',
    'tests/at38-live-harness.test.ts': 'aec742a6e3af2d6f1110d59112231036131c65a8251cc58866fabb4e24b544fa',
    'tests/at38-joined-queue.test.ts': 'b038b6dd57259ad6d8fd629d335abb5aee1a9aa8c98804506b89c81690cbd942',
    'tests/at38-production-boundaries.test.ts': 'c5e594e3a5fdc2602b95ff221ff50795aa916849ef38b031631c6840699a1db1',
  },
  sharedFixesNeeded: [
    'infrastructure.ts seed PNG has color type 4; trusted-collectors-image.ts permits only 2/6. Two real joined image assertions fail. Regenerate a supported bounded RGBA seed or extend strict decoding; retain decode/hash predicates.',
    'workshop-runner.ts default ownership fails with existing WAF inventory: observeRuntimeOwnership returns no policy IDs before assertLiveReady. Join actual policy readback; never blindly copy inventory ownership. Joined queue test injects the real budgeted CloudflareReader for this gap.',
    'BrowserFixtureResponse.body supports UTF-8 only; add bounded binary fixture delivery for owned images. Current joined queue fixture returns an explicit 503 for binary assets; image decode is separately exercised at the real collector/browser boundary.',
    'Guarded CLI collection is implemented but complete live UI/isolation/AT orchestration is not. Full AT-11B aggregate UI controls, AT-12 repeated setup inventory and AT-14 enabled readback/report agreement still need complete joins.',
  ],
  provenOffline: ['React/authenticated control/actual CLI/Worker/Container/local D1/R2/authenticated telemetry/report join', 'Q visible while A navigates; actual masked frames; same-context Q admission and linked Container receipts', 'Exact opt-in/plan/config/source/age gates reject before credentials, transports or browsers', 'Authorized fixture harness runs actual CLI twice with fresh IDs and immutable reports', 'Every missing AT design predicate remains an explicit non-pass in fixture records'],
  stopEvidence: '',
} as const;
