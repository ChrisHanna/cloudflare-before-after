import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Digest, Id, ReceiptSchema, Role, ScenarioId, RayId, type Receipt } from '../../../packages/contracts/src/schemas.js';
import { ProductSchema } from '../../storefront-worker/src/d1.js';
const Payload = z.strictObject({
  runId: Id, requestId: Id, scenarioId: ScenarioId, targetRole: Role, rayId: RayId.nullable(),
  operation: z.enum(['catalog', 'registration', 'api', 'admin', 'launch']),
  product: ProductSchema,
  imageUrl: z.url().refine(v => { const u = new URL(v); return u.origin === 'https://imagedelivery.net' && !u.search && !u.hash && !u.username && !u.password; }),
  detail: z.string().max(4096),
  registration: z.strictObject({ record_id: Id, display_name: z.string().regex(/^synthetic-[A-Za-z0-9 _-]{1,64}$/), note: z.string().max(256) }).nullable(),
});
const ReservedReceipt = z.strictObject({ id: Id, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const Reservation = z.strictObject({ schemaVersion: z.literal(1), producerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), role: Role, scenarioId: ScenarioId, runId: Id, releaseDigest: Digest, requestId: Id, payloadDigest: Digest, observedAt: z.iso.datetime(), entry: ReservedReceipt, completion: ReservedReceipt }).refine(v => v.completion.sequence === v.entry.sequence + 1);
export interface ContainerOptions {
  role: z.infer<typeof Role>; scenarioId: z.infer<typeof ScenarioId>; runId: string;
  producerId: string; releaseDigest: string; internalSecret: string;
  sendReceipt(receipt: Receipt, signal?: AbortSignal, ticket?: { encoded: string; signature: string }): Promise<void>;
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function authorized(value: string, secret: string): boolean {
  const actual = Buffer.from(value); const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const STOREFRONT_STYLE = `
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172d32;background:#f5f3ed}*{box-sizing:border-box}body{margin:0}a{color:inherit}a:focus-visible{outline:3px solid #075cbd;outline-offset:5px}.skip{position:absolute;left:1rem;top:-5rem;background:white;padding:1rem;z-index:1}.skip:focus{top:1rem}.site-header,main,footer{max-width:1160px;margin:auto;padding:1.5rem clamp(1.25rem,5vw,4rem)}.site-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid #b5c3c0}.brand{font-weight:750;letter-spacing:-.03em;font-size:1.25rem}.role-badge,.eyebrow{text-transform:uppercase;letter-spacing:.1em;font-size:.75rem;font-weight:700}.role-badge{border:1px solid #607c73;border-radius:2rem;padding:.65rem .9rem}.hero{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:center;gap:clamp(2rem,6vw,5rem);padding:3rem 0}.eyebrow{color:#36594e}h1{font-size:clamp(2.5rem,5vw,4.75rem);letter-spacing:-.06em;line-height:1.04;margin:1rem 0 1.5rem;overflow-wrap:anywhere}.detail{font-size:1.125rem;line-height:1.7;overflow-wrap:anywhere}.scope-note,figcaption,footer{font-size:.875rem;line-height:1.65;color:#405b59}.button{display:inline-block;background:#174e40;color:#fff;text-decoration:none;padding:1rem 1.4rem;border-radius:.4rem;font-weight:650;margin-top:1rem}figure{margin:0;padding:1.5rem;background:#e6ece5;border-radius:1rem}img{display:block;width:100%;height:auto;max-height:30rem;object-fit:contain}figcaption{margin-top:1rem}.product-details{border-top:1px solid #b5c3c0;padding:2rem 0}h2{font-size:1.5rem;letter-spacing:-.03em}dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}dt{font-size:.8rem;color:#405b59}dd{margin:.5rem 0 0;font-weight:650;overflow-wrap:anywhere}.registration-note{white-space:pre-wrap;overflow-wrap:anywhere}footer{border-top:1px solid #b5c3c0}.announce{margin:0;background:#174e40;color:#fff;text-align:center;font-size:.8rem;padding:.5rem 1rem;letter-spacing:.04em}.cart{margin:0;font-weight:650;border:1px solid #b5c3c0;border-radius:2rem;padding:.55rem .9rem;font-size:.85rem;background:#fff}.crumbs{margin:0 0 .5rem;font-size:.8rem;color:#405b59}.rating{margin:0 0 .5rem;color:#b26a00}.rating span{color:#405b59;font-size:.85rem}.price{font-size:1.8rem;font-weight:750;margin:.25rem 0 1rem;letter-spacing:-.02em}.sizes{display:flex;gap:.5rem;list-style:none;padding:0;margin:1rem 0}.sizes li{min-width:2.75rem;text-align:center;border:1px solid #607c73;border-radius:.4rem;padding:.55rem .75rem;background:#fff;font-weight:650}.sizes li.on{background:#174e40;color:#fff;border-color:#174e40}.ghost{background:#fff;color:#174e40;border:1px solid #174e40;border-radius:.4rem;padding:1rem 1.4rem;font:inherit;font-weight:650;margin:1rem 0 0 .5rem;opacity:.7}.trust{display:flex;flex-wrap:wrap;gap:.5rem 2rem;list-style:none;max-width:1160px;margin:auto;padding:1rem clamp(1.25rem,5vw,4rem);border-top:1px solid #b5c3c0;font-size:.875rem;color:#405b59}.related{border-top:1px solid #b5c3c0;padding:2rem 0}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;list-style:none;padding:0}.cards li{background:#fff;border:1px solid #b5c3c0;border-radius:.75rem;padding:1rem;display:grid;gap:.4rem}.swatch{display:block;height:7rem;border-radius:.5rem}.s1{background:linear-gradient(135deg,#d8e4dc,#9fbfb0)}.s2{background:linear-gradient(135deg,#f0e1c8,#d9b77e)}.s3{background:linear-gradient(135deg,#d5dbe8,#8fa3c7)}.nav{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem}.nav a{text-decoration:none;font-weight:650;padding:.5rem 0;border-bottom:2px solid transparent}.nav a:hover{border-bottom-color:#174e40}.tour{border-top:1px solid #b5c3c0;padding:2rem 0}.tour ol{padding-left:1.25rem;line-height:1.7;margin:.5rem 0}.tour li{margin:.4rem 0}@media(max-width:640px){.cards{grid-template-columns:1fr}.site-header{flex-wrap:wrap}.hero{grid-template-columns:1fr;padding:2rem 0}.site-header{align-items:flex-start}.role-badge{max-width:12rem}dl{grid-template-columns:1fr}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;
export function createContainerApp(options: ContainerOptions): Hono {
  Role.parse(options.role); ScenarioId.parse(options.scenarioId); Id.parse(options.runId); Digest.parse(options.releaseDigest);
  z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(options.producerId);
  if (options.internalSecret.length < 24) throw new Error('Internal service secret must have at least 24 characters');
  let lastAttemptedSequence = 0;
  let producerHealthy = true;
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Body exceeds limit' }, 413) }));
  app.use('*', async (c, next) => {
    if (!authorized(c.req.header('authorization') ?? '', options.internalSecret)) return c.json({ error: 'Service authorization required' }, 401);
    await next();
  });
  app.get('/internal/checkpoint', c => c.json({ producerId: options.producerId, targetRole: options.role, scenarioId: options.scenarioId, runId: options.runId, lastAttemptedSequence, healthy: producerHealthy, watermark: new Date().toISOString() }));
  app.post('/internal/render', async c => {
    let input: z.infer<typeof Payload>; let raw: string;
    try { raw = await c.req.text(); input = Payload.parse(JSON.parse(raw)); } catch { return c.json({ error: 'Invalid synthetic request' }, 400); }
    if (input.runId !== options.runId || input.targetRole !== options.role || input.scenarioId !== options.scenarioId) return c.json({ error: 'Foreign instance scope' }, 403);
    let reservation: z.infer<typeof Reservation>;
    let ticket: { encoded: string; signature: string };
    try {
      const encoded = z.string().min(1).max(2048).parse(c.req.header('x-origin-receipt-reservation'));
      const signature = z.string().regex(/^[a-f0-9]{64}$/).parse(c.req.header('x-origin-receipt-signature'));
      const expected = createHmac('sha256', options.internalSecret).update(`origin-receipt-reservation-v1\n${encoded}`).digest();
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) throw new Error('Unverified receipt allocation');
      reservation = Reservation.parse(JSON.parse(encoded));
      if (reservation.producerId !== options.producerId || reservation.role !== options.role || reservation.scenarioId !== options.scenarioId || reservation.runId !== options.runId || reservation.releaseDigest !== options.releaseDigest || reservation.requestId !== input.requestId || reservation.payloadDigest !== createHash('sha256').update(raw).digest('hex')) throw new Error('Foreign receipt allocation');
      ticket = { encoded, signature };
    } catch { return c.json({ error: 'Verified receipt reservation required', originCoverage: 'unknown' }, 403); }
    const receipt = (stage: 'entry' | 'completion') => {
      lastAttemptedSequence = Math.max(lastAttemptedSequence, reservation[stage].sequence);
      return ReceiptSchema.parse({ schemaVersion: 1, id: reservation[stage].id, runId: input.runId, requestId: input.requestId, scenarioId: input.scenarioId, targetRole: options.role, producerId: options.producerId, sequence: reservation[stage].sequence, observedAt: reservation.observedAt, rayId: input.rayId, releaseDigest: options.releaseDigest, stage });
    };
    // Do not execute/render a business operation until its entry receipt is acknowledged.
    try { c.req.raw.signal.throwIfAborted(); await options.sendReceipt(receipt('entry'), c.req.raw.signal, ticket); c.req.raw.signal.throwIfAborted(); } catch { producerHealthy = false; return c.json({ error: 'Origin telemetry unhealthy', originCoverage: 'unknown' }, 503); }
    if (input.operation === 'registration' && !input.registration) return c.json({ error: 'Synthetic registration required' }, 400);
    const title = input.operation === 'admin' ? 'Synthetic admin: no privileged operations' : input.product.title;
    const view = options.role === 'before' ? 'Before baseline' : 'After custom WAF lab';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STOREFRONT_STYLE}</style></head><body><a class="skip" href="#main">Skip to content</a><p class="announce">Free synthetic shipping on every order · Demo store, no purchases</p><header class="site-header"><p class="brand">Storefront lab</p><nav class="nav" aria-label="Lab pages"><a href="/">Shop</a><a href="/register">Registration check</a></nav><p class="cart">Bag (0)</p><p class="role-badge">${view}</p></header><main id="main" data-storefront><section class="hero" aria-labelledby="product-title"><div><p class="crumbs">Home / Shirts / Launch</p><p class="eyebrow" data-demo-public>Synthetic shopper · ${view}</p><h1 id="product-title">${escapeHtml(title)}</h1><p class="rating" aria-label="Rated 4.8 out of 5, synthetic">★★★★★ <span>4.8 · 128 synthetic reviews</span></p><p class="price">$24.00</p><p class="detail">${escapeHtml(input.detail)}</p><ul class="sizes" aria-label="Sizes"><li>S</li><li>M</li><li class="on">L</li><li>XL</li></ul><p class="scope-note">Synthetic workshop content. No purchase or privileged actions.</p><a class="button" href="#product-details">View product details</a><button class="ghost" type="button" disabled>Add to bag · demo only</button></div><figure><img src="${escapeHtml(input.imageUrl)}" alt="${escapeHtml(input.product.title)} — synthetic product image" width="640" height="640" decoding="async"><figcaption>${escapeHtml(input.product.title)}</figcaption></figure></section><ul class="trust"><li>Free synthetic shipping</li><li>30-day synthetic returns</li><li>Checkout disabled in this demo</li></ul><section id="product-details" class="product-details" aria-labelledby="details-title"><h2 id="details-title">Product details</h2><dl><div><dt>Product</dt><dd>${escapeHtml(input.product.product_id)}</dd></div><div><dt>Workshop view</dt><dd>${view}</dd></div></dl>${input.registration ? `<p class="registration-note">${escapeHtml(input.registration.note)}</p>` : ''}</section><section class="related" aria-labelledby="related-title"><h2 id="related-title">You may also like</h2><ul class="cards"><li><span class="swatch s1" aria-hidden="true"></span><strong>Synthetic hoodie</strong><span>$48.00</span></li><li><span class="swatch s2" aria-hidden="true"></span><strong>Synthetic cap</strong><span>$18.00</span></li><li><span class="swatch s3" aria-hidden="true"></span><strong>Synthetic tote</strong><span>$15.00</span></li></ul><p class="scope-note">Placeholder items for layout only. They are not in the catalog.</p></section><section class="tour" aria-labelledby="tour-title"><h2 id="tour-title">What to try</h2><ol><li><a href="/">Shop</a> is the same synthetic storefront on Before and After.</li><li>After has a custom WAF rule that blocks one synthetic test request. The Command Center sends it and shows the evidence.</li><li><a href="/register">Registration check</a> shows what application-side Turnstile verification changes.</li><li>Open the other site and compare. The only difference is the Cloudflare configuration in front of it.</li></ol></section></main><footer>Demo data only · Cloudflare workshop</footer></body></html>`;
    try { c.req.raw.signal.throwIfAborted(); await options.sendReceipt(receipt('completion'), c.req.raw.signal, ticket); c.req.raw.signal.throwIfAborted(); } catch { producerHealthy = false; return c.json({ error: 'Origin telemetry unhealthy', originCoverage: 'unknown' }, 503); }
    return c.json({ schemaVersion: 1, targetRole: options.role, runId: input.runId, requestId: input.requestId, releaseDigest: options.releaseDigest, html, operation: input.operation === 'registration' ? { type: 'create-registration', value: input.registration } : null });
  });
  app.onError((_error, c) => c.json({ error: 'Container operation failed' }, 500));
  return app;
}
export function receiptSender(url: string, secret: string, dispatch: typeof fetch = fetch): (receipt: Receipt, signal?: AbortSignal, ticket?: { encoded: string; signature: string }) => Promise<void> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.port || target.pathname !== '/ingest' || target.search || target.hash || secret.length < 24) throw new Error('Invalid receipt service configuration');
  return async (receipt, signal, ticket) => {
    const checkedTicket = ticket === undefined ? undefined : z.strictObject({ encoded: z.string().min(1).max(2048), signature: Digest }).parse(ticket);
    const response = await dispatch(target, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...(checkedTicket ? { 'x-origin-receipt-reservation': checkedTicket.encoded, 'x-origin-receipt-signature': checkedTicket.signature } : {}) }, body: JSON.stringify(ReceiptSchema.parse(receipt)), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    // A generic HTTP 200 is not an ingestion acknowledgment.
    if (response.status !== 204 || response.redirected || response.headers.get('x-receipt-id') !== receipt.id) { await response.body?.cancel(); throw new Error('Receipt acknowledgment missing'); }
    await response.body?.cancel();
  };
}
