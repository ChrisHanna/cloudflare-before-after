import { z } from 'zod';
import { Digest, Time } from '../../contracts/src/schemas.js';
import type { AccessPolicy } from './access-policy.js';
import { digestValue } from './canonical.js';

export const AccessResourceId = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const Domain = z.string().min(1).max(512);
// Access-only projection. Keep every scope source, including ignored legacy fields.
// Unknown flags become a fixed unsupported bit, never an exported raw value.
const appFields = new Set(['id', 'aud', 'type', 'domain', 'destinations', 'self_hosted_domains',
  'allow_authenticate_via_warp', 'options_preflight_bypass', 'read_service_tokens_from_header',
  'service_auth_401_redirect', 'name', 'created_at', 'updated_at', 'app_launcher_visible',
  'logo_url', 'tags', 'allowed_idps', 'auto_redirect_to_identity', 'cors_headers',
  'enable_binding_cookie', 'http_only_cookie_attribute', 'path_cookie_attribute',
  'same_site_cookie_attribute', 'session_duration', 'skip_interstitial', 'allow_iframe',
  'custom_deny_message', 'custom_deny_url', 'custom_non_identity_deny_url', 'custom_pages', 'unsupported']);
const Destination = z.union([
  z.strictObject({ type: z.literal('public').optional(), uri: Domain }),
  z.object({ type: z.literal('private') }).transform(() => ({ type: 'private' as const })),
]);
export const AccessApplicationSchema = z.object({ id: AccessResourceId, aud: Digest.optional(), type: z.string().min(1).max(100),
  domain: Domain.optional(), destinations: z.array(Destination).max(32).optional(),
  self_hosted_domains: z.array(Domain).max(32).optional(),
  allow_authenticate_via_warp: z.boolean().optional(), options_preflight_bypass: z.boolean().optional(),
  read_service_tokens_from_header: z.string().max(128).optional(), service_auth_401_redirect: z.boolean().optional(),
  allowed_idps: z.array(AccessResourceId).max(32).optional(), auto_redirect_to_identity: z.boolean().optional(),
  enable_binding_cookie: z.boolean().optional(), http_only_cookie_attribute: z.boolean().optional(), path_cookie_attribute: z.boolean().optional(),
  same_site_cookie_attribute: z.enum(['lax', 'strict', 'none']).optional(), session_duration: z.string().regex(/^[0-9.a-zµ]{1,100}$/).optional(),
  skip_interstitial: z.boolean().optional(),
  unsupported: z.boolean().optional(),
}).catchall(z.unknown()).transform(app => ({ id: app.id, aud: app.aud, type: app.type, domain: app.domain,
  destinations: app.destinations, self_hosted_domains: app.self_hosted_domains,
  allow_authenticate_via_warp: app.allow_authenticate_via_warp, options_preflight_bypass: app.options_preflight_bypass,
  read_service_tokens_from_header: app.read_service_tokens_from_header, service_auth_401_redirect: app.service_auth_401_redirect,
  allowed_idps: app.allowed_idps, auto_redirect_to_identity: app.auto_redirect_to_identity,
  enable_binding_cookie: app.enable_binding_cookie, http_only_cookie_attribute: app.http_only_cookie_attribute, path_cookie_attribute: app.path_cookie_attribute,
  same_site_cookie_attribute: app.same_site_cookie_attribute, session_duration: app.session_duration, skip_interstitial: app.skip_interstitial,
  unsupported: app.unsupported === true || app.cors_headers !== undefined || Object.keys(app).some(key => !appFields.has(key)),
}));
const ruleFields = new Set(['id', 'decision', 'precedence', 'include', 'exclude', 'require', 'approval_required',
  'isolation_required', 'purpose_justification_required', 'name', 'created_at', 'updated_at', 'session_duration', 'unsupported']);
export const AccessServiceRuleSchema = z.object({ id: AccessResourceId, decision: z.string().max(100), precedence: z.number().int().nonnegative(),
  include: z.array(z.strictObject({ service_token: z.strictObject({ token_id: AccessResourceId }) })).max(32),
  exclude: z.array(z.unknown()).max(32).default([]), require: z.array(z.unknown()).max(32).default([]),
  approval_required: z.boolean().optional(), isolation_required: z.boolean().optional(), purpose_justification_required: z.boolean().optional(),
  session_duration: z.string().regex(/^[0-9.a-zµ]{1,100}$/).optional(),
  unsupported: z.boolean().optional(),
}).catchall(z.unknown()).transform(rule => ({ id: rule.id, decision: rule.decision, precedence: rule.precedence, include: rule.include,
  // Retain presence, not the personal/custom contents of unsupported conditions.
  exclude: rule.exclude.map(() => true), require: rule.require.map(() => true),
  approval_required: rule.approval_required, isolation_required: rule.isolation_required,
  purpose_justification_required: rule.purpose_justification_required, session_duration: rule.session_duration,
  unsupported: rule.unsupported === true || Object.keys(rule).some(key => !ruleFields.has(key)),
}));
export type AccessApplication = z.infer<typeof AccessApplicationSchema>;

/** No wildcard, scheme, port, percent encoding, query, dot segment or ambiguous slash. */
export function exactAccessTarget(value: string): { hostname: string; path: string } | null {
  if (!/^[a-z0-9.-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(value) || value.length > 512) return null;
  const [hostname, ...segments] = value.split('/');
  if (!hostname || !z.hostname().safeParse(hostname).success || hostname.endsWith('.') || hostname.length > 253) return null;
  const path = segments.length ? `/${segments.join('/')}` : '/';
  if (path.includes('//') || path.length > 1 && path.endsWith('/')) return null;
  return { hostname, path };
}
export function effectiveAccessTargets(app: AccessApplication): { hostname: string; path: string }[] | null {
  if (app.type !== 'self_hosted' || app.unsupported || app.allow_authenticate_via_warp || app.read_service_tokens_from_header) return null;
  const primary = app.domain ? exactAccessTarget(app.domain) : null;
  if (app.domain && !primary) return null;
  // Vendor: destinations supersede self_hosted_domains. Primary is display metadata
  // when an explicit destination list exists; it must still be a known exact form.
  const values = app.destinations !== undefined
    ? app.destinations.map(d => d.type === 'private' ? null : d.uri)
    : app.self_hosted_domains !== undefined ? app.self_hosted_domains : app.domain ? [app.domain] : [];
  if (!values.length || values.some(v => v === null)) return null;
  const targets = values.map(v => v === null ? null : exactAccessTarget(v));
  if (targets.some(t => !t)) return null;
  const exact = targets as { hostname: string; path: string }[];
  if (new Set(exact.map(t => `${t.hostname}${t.path}`)).size !== exact.length) return null;
  return exact;
}
export function evaluateAccessReadback(policy: AccessPolicy, tokenId: string | null, apps: AccessApplication[], rules: z.infer<typeof AccessServiceRuleSchema>[]) {
  const app = apps.find(a => a.id === policy.applicationId);
  if (!app || apps.length >= 100 || new Set(apps.map(a => a.id.toLowerCase().replaceAll('-', ''))).size !== apps.length)
    return { state: 'unknown' as const, value: null, gaps: ['Incomplete or ambiguous Access application inventory'] };
  const allTargets = apps.map(a => ({ app: a, targets: effectiveAccessTargets(a) }));
  const functionalDigest = digestValue({ apps, rules });
  if (allTargets.some(a => !a.targets)) return { state: 'unsupported' as const, value: { product: 'access' as const, matches: false, priority: 0,
    readback: null, providerRevision: null, functionalDigest }, gaps: ['Access scope contains unsupported or ambiguous destinations'] };
  if (rules.length !== 1 || rules[0]!.id !== policy.policyId) return { state: 'unknown' as const, value: null, gaps: ['Access policy inventory is not the qualified single-policy form'] };
  const rule = rules[0]!; const afterHost = new URL(policy.afterOrigin).hostname; const beforeHost = new URL(policy.beforeOrigin).hostname;
  const selectedTargets = allTargets.find(a => a.app.id === policy.applicationId)!.targets!;
  const coversAdmin = (t: { hostname: string; path: string }) => [beforeHost, afterHost].includes(t.hostname) && (t.path === '/' || t.path === '/admin' || t.path.startsWith('/admin/'));
  const baselineExcluded = allTargets.every(a => a.targets!.every(t => a.app.id === policy.applicationId
    ? t.hostname !== beforeHost : !coversAdmin(t)));
  const serviceTokenAllowed = tokenId !== null && rule.include.length === 1 && rule.include[0]!.service_token.token_id === tokenId
    && rule.exclude.length === 0 && rule.require.length === 0 && !rule.unsupported && !rule.approval_required && !rule.isolation_required && !rule.purpose_justification_required;
  const exactScope = selectedTargets.length === 1 && selectedTargets[0]!.hostname === afterHost && selectedTargets[0]!.path === '/admin';
  const matches = policy.enabled && policy.baselineExcluded && exactScope && app.aud === policy.audience
    && rule.decision === 'non_identity' && baselineExcluded && serviceTokenAllowed;
  const readback = { applicationId: app.id, policyId: rule.id, audience: app.aud!, hostname: afterHost, path: '/admin',
    enabled: exactScope, baselineExcluded, serviceTokenAllowed, decision: rule.decision, bypass: rule.decision === 'bypass' };
  return { state: matches ? 'observed' as const : 'mismatch' as const, value: { product: 'access' as const, matches, priority: rule.precedence,
    readback: matches ? readback : null, providerRevision: null, functionalDigest }, gaps: matches ? [] : ['Access effective scope, audience or service-token policy differs'] };
}

/** Internal map only. The caller must project before transport excerpts are made. */
export const AccessTokenMapSchema = z.object({ id: AccessResourceId, client_id: z.string().regex(/^[A-Za-z0-9._-]{8,256}$/), expires_at: Time });
export type AccessTokenMap = z.infer<typeof AccessTokenMapSchema>;
