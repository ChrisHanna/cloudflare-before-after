import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import boundsScenario from './container-restart-sequence-p2-bounds-scenario.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Reuse only the known closed local runtime/real production Node server adapter.
// Scenario code is owned here; reviewer repros and frozen files stay unchanged.
let source = await readFile(`${root}/tests/runtime/container-restart-sequence-runner.mjs`, 'utf8');
const replaceOnce = (from, to) => { if (source.split(from).length !== 2) throw new Error('Owned fixture anchor drift'); source = source.replace(from, to); };
replaceOnce("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');", `const root = ${JSON.stringify(root)};`);
replaceOnce("await import(mfPath)", "await import('file://' + mfPath)");
replaceOnce("tests/runtime/container-restart-sequence-worker.fixture", "tests/runtime/container-restart-sequence-p2-worker.fixture");
replaceOnce('const bridge = createServer', "let loseReceiptAck = ''; const bridge = createServer");
replaceOnce('ingestStatuses.push(response.status); res.writeHead', "ingestStatuses.push(response.status); if (receipt.stage === loseReceiptAck && response.status === 204) { loseReceiptAck = ''; await response.body?.cancel(); res.writeHead(503); res.end(); return; } res.writeHead");
const begin = source.indexOf('  if (!baseline) { failRegistryAck'); const end = source.indexOf('} finally { if (held)');
if (begin < 0 || end < begin) throw new Error('Owned fixture scenario anchor drift');
const scenario = process.argv.includes('--bounds-only') ? boundsScenario : `
  const red = process.argv.includes('--red'); const adoptionOnly = process.argv.includes('--adoption-only');
  const start = new Date(Date.now() - 10).toISOString();
  holdStage = 'completion'; const delayed = payload(); const pending = render(delayed);
  for (let n = 0; n < 200 && !held; n++) await new Promise(r => setTimeout(r, 10));
  assert.ok(held); const windowEnd = new Date().toISOString();
  assert.equal((await rows()).filter(v => v.request_id === delayed.requestId && v.stage === 'completion').length, 0);
  await new Promise(r => setTimeout(r, 120)); const releaseAt = new Date().toISOString(); holdStage = ''; held.resolve(); held = undefined;
  assert.equal((await pending).status, 200);
  const checkpoint = await call('/internal/checkpoint?scenarioId=analytics&runId=' + runId, { headers: { authorization: 'Bearer ' + secret } }); assert.equal(checkpoint.status, 200); await checkpoint.body?.cancel();
  const query = new URLSearchParams({ role, runId, scenarioId: 'analytics', start, end: windowEnd });
  const coverage = await (await mf.dispatchFetch('https://telemetry.example.test/receipts?' + query, { headers: { authorization: 'Bearer ' + collector } })).json();
  const completion = coverage.receipts.find(v => v.requestId === delayed.requestId && v.stage === 'completion');
  const stored = JSON.parse((await db.prepare('SELECT payload FROM origin_receipts WHERE request_id=? AND stage=?').bind(delayed.requestId, 'completion').first()).payload);
  if (red) { assert.ok(completion); assert.ok(stored.observedAt <= windowEnd); }
  else if (!adoptionOnly) {
    const accepted = await db.prepare('SELECT accepted_at FROM origin_receipt_acceptance WHERE receipt_id=?').bind(stored.id).first();
    assert.equal(completion, undefined, 'late completion must not be backdated into an earlier query'); assert.ok(accepted.accepted_at >= releaseAt);
    assert.ok(stored.observedAt <= windowEnd, 'container report must be preserved, not reinterpreted as trusted time');
    assert.equal(coverage.originCount, null); assert.equal(coverage.coverage.healthy, false); assert.equal(coverage.coverage.complete, false);
  }
  if (!adoptionOnly) checks++;
  const originalRows = (await db.prepare('SELECT rowid,receipt_id,producer_id,sequence,environment,scenario_id,run_id,request_id,stage,observed_at,payload FROM origin_receipts ORDER BY sequence').all()).results;
  const originalAcceptance = (await db.prepare('SELECT receipt_id,payload_digest,accepted_at FROM origin_receipt_acceptance').all()).results;
  if (!red) {
    await db.prepare('DELETE FROM origin_receipt_acceptance WHERE receipt_id=?').bind(stored.id).run();
    assert.equal((await render(delayed)).status, 200); assert.equal(await db.prepare('SELECT accepted_at FROM origin_receipt_acceptance WHERE receipt_id=?').bind(stored.id).first(), null, 'legacy NULL must not be backfilled by replay');
    const legacy = await (await mf.dispatchFetch('https://telemetry.example.test/receipts?' + query, { headers: { authorization: 'Bearer ' + collector } })).json(); assert.equal(legacy.originCount, null); assert.equal(legacy.coverage.complete, false); checks++;
    for (const row of originalAcceptance) await db.prepare('INSERT OR IGNORE INTO origin_receipt_acceptance(receipt_id,payload_digest,accepted_at) VALUES(?,?,?)').bind(row.receipt_id,row.payload_digest,row.accepted_at).run();
  }
  const owner = await identity(); await db.prepare('UPDATE origin_receipts SET payload=? WHERE producer_id=?').bind(JSON.stringify({ releaseDigest: release }), owner.identity.producerId).run();
  await call('/fixture/forget-allocator'); const count = (await rows()).length; const response = await render();
  assert.equal(response.status, red ? 200 : 503, 'malformed history must fail strict adoption');
  assert.equal((await rows()).length, red ? count + 2 : count); checks++;
  if (!red) {
    const checkpointOriginal = await db.prepare('SELECT * FROM producer_checkpoints WHERE producer_id=?').bind(owner.identity.producerId).first();
    const registryOriginal = await db.prepare('SELECT * FROM producer_registry WHERE producer_id=?').bind(owner.identity.producerId).first();
    const restore = async () => {
      for (const row of originalRows) await db.prepare('UPDATE origin_receipts SET receipt_id=?,producer_id=?,sequence=?,environment=?,scenario_id=?,run_id=?,request_id=?,stage=?,observed_at=?,payload=? WHERE rowid=?').bind(row.receipt_id,row.producer_id,row.sequence,row.environment,row.scenario_id,row.run_id,row.request_id,row.stage,row.observed_at,row.payload,row.rowid).run();
      await db.prepare('UPDATE producer_checkpoints SET environment=?,scenario_id=?,run_id=?,last_attempted_sequence=?,healthy=?,watermark=? WHERE producer_id=?').bind(checkpointOriginal.environment,checkpointOriginal.scenario_id,checkpointOriginal.run_id,checkpointOriginal.last_attempted_sequence,checkpointOriginal.healthy,checkpointOriginal.watermark,owner.identity.producerId).run();
      await db.prepare('UPDATE producer_registry SET environment=?,scenario_id=?,run_id=?,release_digest=? WHERE producer_id=?').bind(registryOriginal.environment,registryOriginal.scenario_id,registryOriginal.run_id,registryOriginal.release_digest,owner.identity.producerId).run();
      await call('/fixture/forget-allocator');
    };
    const reject = async () => { const before = (await rows()).length; assert.equal((await render()).status, 503); assert.equal((await rows()).length, before); assert.equal((await identity()).allocator, undefined); checks++; };
    const original = JSON.parse(originalRows[0].payload);
    const payloadCases = [ ['malformed-json', '{'], ['oversize', 'x'.repeat(4097)], ['unknown-field', JSON.stringify({ ...original, privateField: 'PRIVATE_CANARY' })], ['foreign-release', JSON.stringify({ ...original, releaseDigest: 'b'.repeat(64) })], ['id-mismatch', JSON.stringify({ ...original, id: randomUUID() })], ['request-mismatch', JSON.stringify({ ...original, requestId: randomUUID() })], ['seq-mismatch', JSON.stringify({ ...original, sequence: original.sequence + 5 })], ['stage-mismatch', JSON.stringify({ ...original, stage: 'completion' })], ['wrong-type', JSON.stringify({ ...original, sequence: '1' })] ];
    for (const key of Object.keys(original)) { const value = { ...original }; delete value[key]; payloadCases.push(['missing-' + key, JSON.stringify(value)]); }
    for (const [name, text] of payloadCases) { await restore(); await db.prepare('UPDATE origin_receipts SET payload=? WHERE rowid=?').bind(text, originalRows[0].rowid).run(); await reject(); }
    for (const [column, value] of [['receipt_id', randomUUID()], ['sequence', 9], ['request_id', randomUUID()], ['observed_at', new Date(Date.now() - 5000).toISOString()]]) { await restore(); try { await db.prepare('UPDATE origin_receipts SET ' + column + '=? WHERE rowid=?').bind(value, originalRows[0].rowid).run(); } catch { assert.equal(column, 'receipt_id'); checks++; continue; } await reject(); }
    for (const [field, column, value] of [['targetRole','environment',role === 'before' ? 'after' : 'before'],['scenarioId','scenario_id','waf-custom'],['runId','run_id',randomUUID()]]) { await restore(); await db.prepare('UPDATE origin_receipts SET ' + column + '=?,payload=? WHERE rowid=?').bind(value, JSON.stringify({ ...original, [field]: value }), originalRows[0].rowid).run(); await reject(); }
    for (const [column, value] of [['run_id',randomUUID()],['scenario_id','waf-custom'],['environment',role === 'before' ? 'after' : 'before'],['watermark','not-time'],['watermark','2099-01-01T00:00:00.000Z'],['last_attempted_sequence',1.5]]) { await restore(); await db.prepare('UPDATE producer_checkpoints SET ' + column + '=? WHERE producer_id=?').bind(value,owner.identity.producerId).run(); await reject(); }
    for (const [column, value] of [['release_digest','b'.repeat(64)],['run_id',randomUUID()],['scenario_id','waf-custom'],['environment',role === 'before' ? 'after' : 'before']]) { await restore(); await db.prepare('UPDATE producer_registry SET ' + column + '=? WHERE producer_id=?').bind(value,owner.identity.producerId).run(); await reject(); }
    await restore();
    for (let seq = 3; seq <= 201; seq++) { const value = { ...original, id: randomUUID(), requestId: randomUUID(), sequence: seq }; await db.prepare('INSERT INTO origin_receipts(receipt_id,producer_id,sequence,environment,scenario_id,run_id,request_id,stage,observed_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(value.id,value.producerId,value.sequence,value.targetRole,value.scenarioId,value.runId,value.requestId,value.stage,value.observedAt,JSON.stringify(value)).run(); }
    await reject();
  }
  console.log(JSON.stringify({ kind: red ? 'restart-p2-RED' : adoptionOnly ? 'restart-p2-adoption-only' : 'restart-p2-repaired', role, productionHandler: productionServer, checks, lateCompletionIncluded: !!completion, actualReleaseAfterEnd: releaseAt > windowEnd, malformedAdoptionStatus: response.status, cloudRequests: 0, version, binarySha256 }));
`;
source = source.slice(0, begin) + scenario + source.slice(end);
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
