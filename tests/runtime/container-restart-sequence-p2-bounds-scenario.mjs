export default String.raw`
  const postControl = value => call('/fixture/retention', { method: 'POST', body: JSON.stringify(value) });
  const snapshot = async () => (await call('/fixture/retention')).json();
  const first = payload(); assert.equal((await render(first)).status, 200);
  const originalOwner = (await identity()).identity.producerId;
  const beforeRetry = (await rows()).length;
  await postControl({ requestId: first.requestId, ageMs: 14 * 60 * 1000 });
  assert.equal((await render(first)).status, 200); assert.equal((await rows()).length, beforeRetry); assert.equal((await identity()).allocator.highWater, 2); checks++;
  failStage = 'entry'; const pendingEntry = payload(); assert.equal((await render(pendingEntry)).status, 503);
  holdStage = 'completion'; const crashed = payload(); const crash = render(crashed);
  for (let n = 0; n < 200 && !held; n++) await new Promise(r => setTimeout(r, 10)); assert.ok(held);
  await stopNode(); holdStage = ''; held.resolve(); held = undefined; await crash; await startNode(config); restarts++;
  loseReceiptAck = 'entry'; const lostAck = payload(); assert.equal((await render(lostAck)).status, 503);
  const pendingIds = [pendingEntry.requestId, crashed.requestId, lostAck.requestId];
  let missingSettlement;
  for (let n = 0; n < 96; n += 4) {
    const inputs = Array.from({ length: Math.min(4, 96 - n) }, () => payload()); missingSettlement = inputs.at(-1);
    const responses = await Promise.all(inputs.map(value => render(value))); assert.ok(responses.every(value => value.status === 200));
  }
  const full = await snapshot(); assert.equal(full.count, 100); assert.equal(full.allocator.knownRequestIds.length, 100); assert.equal(full.allocator.highWater, 200); assert.equal(full.allocator.unresolved, 3); checks++;
  const capRows = (await rows()).length; assert.equal((await render()).status, 503); const denied = await snapshot(); assert.equal(denied.count, 100); assert.equal(denied.allocator.highWater, 200); assert.equal((await rows()).length, capRows); checks++;
  // Test-only settlement aging; no source clock, receipt timestamp or SQL data is changed.
  await postControl({ ageMs: 16 * 60 * 1000 }); await postControl({ forgetSettlement: missingSettlement.requestId });
  assert.equal((await render()).status, 503); const pruned = await snapshot();
  assert.equal(pruned.count, 4); assert.equal(pruned.allocator.highWater, 200); assert.equal(pruned.allocator.unresolved, 3); assert.equal(pruned.allocator.healthy, false); assert.equal(pruned.allocator.knownRequestIds.length, 100); checks++;
  for (const id of pendingIds) { assert.ok(pruned.records.some(value => value.requestId === id && !value.complete)); checks++; }
  assert.ok(pruned.records.some(value => value.requestId === missingSettlement.requestId && value.complete && value.settledAt === undefined));
  assert.equal((await render(missingSettlement)).status, 503); checks++;
  assert.equal((await render(first)).status, 503); assert.equal((await render({ ...first, detail: 'changed expired request' })).status, 503); assert.equal((await snapshot()).allocator.highWater, 200); checks++;
  try { await call('/fixture/evict'); } catch {}
  const persisted = await snapshot(); assert.equal(persisted.count, 4); assert.equal(persisted.allocator.highWater, 200); assert.equal(persisted.allocator.unresolved, 3); assert.equal(persisted.allocator.knownRequestIds.length, 100); assert.equal((await identity()).identity.producerId, originalOwner); checks++;
  assert.equal((await render(first)).status, 503); assert.equal((await render()).status, 503); assert.equal((await snapshot()).allocator.highWater, 200); checks++;
  // Pending retries stay eligible even when settlement metadata is old and the run budget is spent.
  assert.equal((await render(pendingEntry)).status, 200); const retried = await snapshot(); assert.equal(retried.allocator.highWater, 200); assert.equal(retried.allocator.knownRequestIds.length, 100); assert.equal(retried.allocator.unresolved, 2); assert.equal(retried.allocator.healthy, false); checks++;
  const query = new URLSearchParams({ role, runId, scenarioId: 'analytics', start: new Date(Date.now() - 60000).toISOString(), end: new Date().toISOString() });
  const coverage = await (await mf.dispatchFetch('https://telemetry.example.test/receipts?' + query, { headers: { authorization: 'Bearer ' + collector } })).json(); assert.equal(coverage.originCount, null); assert.equal(coverage.coverage.complete, false); checks++;
  assert.ok(!collectorStatuses.includes(409)); assert.ok(!logs.includes('PRIVATE_CANARY'));
  console.log(JSON.stringify({ kind: 'restart-p2-bounds', role, productionHandler: productionServer, checks, cap: 100, highWater: retried.allocator.highWater, retainedUnresolved: retried.allocator.unresolved, knownIds: retried.allocator.knownRequestIds.length, liveRecords: retried.count, coverage: 'unknown', cloudRequests: 0, version, binarySha256 }));
`;
