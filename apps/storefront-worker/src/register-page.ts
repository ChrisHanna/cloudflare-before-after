import type { z } from 'zod';
import type { TurnstileConfigSchema } from '../../../packages/contracts/src/schemas.js';
type Role = 'before' | 'after';
type Config = z.infer<typeof TurnstileConfigSchema>;
export type CheckReason = 'baseline-only' | 'missing' | 'invalid' | 'accepted' | 'unavailable';
const MODE_TEXT = { test: 'TEST MODE — not production enforcement', disabled: 'Before baseline only — no verification', live: 'Live verification configured — proof still required' } as const;
const RESULTS: Record<CheckReason, { status: 200 | 403 | 503; kind: 'accepted' | 'rejected' | 'unavailable'; heading: string; text: string }> = {
  'baseline-only': { status: 200, kind: 'accepted', heading: 'Accepted', text: 'This hostname has no application-side verification, so the submission was accepted as is.' },
  accepted: { status: 200, kind: 'accepted', heading: 'Accepted', text: 'The Turnstile token was verified on the server with Siteverify.' },
  missing: { status: 403, kind: 'rejected', heading: 'Rejected', text: 'No Turnstile token was submitted, so the application refused the submission.' },
  invalid: { status: 403, kind: 'rejected', heading: 'Rejected', text: 'The submitted token did not verify for this hostname.' },
  unavailable: { status: 503, kind: 'unavailable', heading: 'Verification unavailable', text: 'Siteverify could not be reached, so no decision was made. Try again.' },
};
function shell(role: Role, title: string, body: string, widget: boolean): string {
  const name = role === 'before' ? 'Before' : 'After';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — ${name}</title><link rel="stylesheet" href="/assets/register.css">${widget ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}</head><body><a class="skip" href="#main">Skip to content</a><header class="site-header"><p class="brand">Storefront lab</p><nav class="nav" aria-label="Lab pages"><a href="/">Shop</a><a href="/register">Registration check</a></nav><p class="role-badge">${name} — ${role === 'before' ? 'baseline' : 'protected'}</p></header><main id="main">${body}</main><footer>Synthetic workshop content. This check stores nothing.</footer></body></html>`;
}
export function registerPage(role: Role, config: Config): string {
  const expect = role === 'before'
    ? '<li>Before accepts every submission. This hostname has no verification.</li>'
    : '<li>After refuses a submission without a valid token. The application decides with Siteverify; no Cloudflare edge rule is involved.</li><li>Let the widget finish before submitting to see an accepted result, or submit early to see the rejection.</li>';
  return shell(role, 'Registration check', `<h1>Registration check</h1><p class="lead">Submit this synthetic form to see what application-side verification changes.</p><p><span class="mode">${MODE_TEXT[config.mode]}</span></p><form method="post" action="/register/check">${config.sitekey ? `<div class="cf-turnstile" data-sitekey="${config.sitekey}" data-action="register"></div>` : ''}<p><button type="submit">Run registration check</button></p></form><section class="panel" aria-labelledby="expect-title"><h2 id="expect-title">What to expect</h2><ul>${expect}</ul><p class="muted">Registrations are written only by the authorized lab runner. This form stores nothing.</p></section>`, role === 'after' && config.sitekey !== null);
}
export function registerResultPage(role: Role, config: Config, reason: CheckReason): { html: string; status: 200 | 403 | 503 } {
  const result = RESULTS[reason];
  return { status: result.status, html: shell(role, `Check ${result.kind}`, `<h1>Registration check</h1><p><span class="mode">${MODE_TEXT[config.mode]}</span></p><section class="panel result ${result.kind}" role="status" aria-labelledby="result-title"><h2 id="result-title">${result.heading}</h2><p>${result.text}</p><p class="muted">This decision was made by the application, not by a Cloudflare edge rule.</p></section><p><a class="button" href="/register">Run the check again</a></p>`, false) };
}
export function notEnabledPage(role: Role): string {
  return shell(role, 'Registration check', '<h1>Registration check</h1><section class="panel" role="status"><h2>Not enabled in this deployment</h2><p>Turnstile verification has not been configured for this hostname.</p></section>', false);
}
export const REGISTER_CSS = `:root{color-scheme:light;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#172d32;background:#f5f3ed}*{box-sizing:border-box}body{margin:0}
.skip{position:absolute;left:1rem;top:-5rem;background:#fff;padding:1rem;z-index:1}.skip:focus{top:1rem}
.site-header,main,footer{max-width:760px;margin:auto;padding:1.5rem 1.25rem}.site-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;border-bottom:1px solid #b5c3c0}
.brand{font-weight:750;letter-spacing:-.03em;font-size:1.25rem;margin:0}.role-badge{border:1px solid #607c73;border-radius:2rem;padding:.5rem .8rem;font-size:.75rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:0}
.nav{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem}.nav a{text-decoration:none;font-weight:650;padding:.5rem 0}.nav a:hover{text-decoration:underline}.site-header{flex-wrap:wrap}
h1{font-size:clamp(1.9rem,4vw,2.75rem);letter-spacing:-.04em;line-height:1.1;margin:1.5rem 0 1rem}h2{font-size:1.35rem;margin:0 0 .5rem}.lead{font-size:1.125rem;line-height:1.7}
.mode{display:inline-block;border:1px solid #607c73;border-radius:.4rem;padding:.35rem .6rem;font-weight:700;font-size:.85rem;background:#e6ece5}
form,.panel{background:#fff;border:1px solid #b5c3c0;border-radius:1rem;padding:1.5rem;margin:1.5rem 0}ul{padding-left:1.25rem;line-height:1.7}
button,.button{display:inline-block;background:#174e40;color:#fff;border:0;border-radius:.4rem;padding:.9rem 1.3rem;font:inherit;font-weight:650;cursor:pointer;text-decoration:none}
a{color:#174e40}button:focus-visible,a:focus-visible{outline:3px solid #075cbd;outline-offset:4px}
.result{border-left:.5rem solid #174e40}.result.rejected{border-left-color:#8a2b1f}.result.unavailable{border-left-color:#7a5a00}
.muted,footer{color:#405b59;font-size:.875rem;line-height:1.65}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
`;
