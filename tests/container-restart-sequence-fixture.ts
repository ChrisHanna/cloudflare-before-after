import { createHash, createHmac, randomUUID } from 'node:crypto';
/** Test-only trusted issuer for app fixtures that intentionally bypass the DO.
 * It is NOT the durable allocator or proof of restart safety. */
const counters = new Map<string, number>();
export function fixtureReservationHeaders(body: Record<string, any>, options: { producerId: string; releaseDigest: string; internalSecret: string }) {
  const key = `${options.producerId}:${body.targetRole}:${body.scenarioId}:${body.runId}`; const first = (counters.get(key) ?? 0) + 1; counters.set(key, first + 1);
  const encoded = JSON.stringify({ schemaVersion: 1, producerId: options.producerId, role: body.targetRole, scenarioId: body.scenarioId, runId: body.runId, releaseDigest: options.releaseDigest, requestId: body.requestId, payloadDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'), observedAt: new Date().toISOString(), entry: { id: randomUUID(), sequence: first }, completion: { id: randomUUID(), sequence: first + 1 } });
  return { 'x-origin-receipt-reservation': encoded, 'x-origin-receipt-signature': createHmac('sha256', options.internalSecret).update(`origin-receipt-reservation-v1\n${encoded}`).digest('hex') };
}
export async function fixtureReservedRequest(request: Request, options: { producerId: string; releaseDigest: string; internalSecret: string }): Promise<Request> {
  if (new URL(request.url).pathname !== '/internal/render') return request;
  const body = await request.clone().json() as Record<string, any>; const reserved = new Request(request);
  for (const [key, value] of Object.entries(fixtureReservationHeaders(body, options))) reserved.headers.set(key, value);
  return reserved;
}
