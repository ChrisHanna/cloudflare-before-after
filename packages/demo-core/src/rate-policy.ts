import { z } from 'zod';
import { RateSettingsSchema } from '../../contracts/src/schemas.js';
import { labOrigin } from './config.js';
import { digestValue } from './deployment-plan.js';
import { ProductStateSchema, type ProductState } from './product-state.js';
import type { SetupContext } from './deployment-apply.js';
import type { GuardedClient } from './transport.js';
export const RATE_PHASE = 'http_ratelimit' as const;
export const RATE_SOURCES = ['ratelimit', 'rateLimit'] as const;
const CfId = z.string().regex(/^[a-f0-9]{32}$/);
export const RateRuleSchema = z.object({ id: CfId, ref: z.string().max(128).optional(), description: z.string().max(4096).optional(), action: z.string().max(100), enabled: z.boolean().optional(), expression: z.string().max(4096), ratelimit: RateSettingsSchema });
export const RateRulesetSchema = z.object({ id: CfId, kind: z.literal('zone'), phase: z.literal(RATE_PHASE), version: z.string().max(128), rules: z.array(RateRuleSchema).max(100) });
export function desiredRateLimit(lab: string, origin: string) {
  z.string().regex(/^[a-z][a-z0-9-]{2,19}$/).parse(lab); const hostname = new URL(labOrigin(origin)).hostname; const marker = `cf-demo-${lab}-rate`;
  return { module: 'rate-limit' as const, ref: `cf-demo-${lab}-rate-limit`, description: `Cloudflare lab ${lab}: rate-limit (synthetic only)`, enabled: true as const, action: 'block' as const, hostname, marker,
    expression: `(http.host eq ${JSON.stringify(hostname)} and http.request.uri.path eq "/api")`,
    ratelimit: RateSettingsSchema.parse({ period: 10, requests_per_period: 3, mitigation_timeout: 10, characteristics: ['cf.colo.id', 'ip.src'] }),
  };
}
export interface RateSetupApi {
  entrypoint(signal?: AbortSignal): Promise<z.infer<typeof RateRulesetSchema> | null>;
  create(rule: ReturnType<typeof desiredRateLimit>, signal: AbortSignal): Promise<void>;
  append(id: string, rule: ReturnType<typeof desiredRateLimit>, signal: AbortSignal): Promise<void>;
  enable(id: string, ruleId: string, signal: AbortSignal): Promise<void>;
}
export async function inspectRateLimit(api: Pick<RateSetupApi, 'entrypoint'>, desired: ReturnType<typeof desiredRateLimit>, signal?: AbortSignal) {
  const raw = await api.entrypoint(signal); const ruleset = raw === null ? null : RateRulesetSchema.parse(raw); const matches = ruleset?.rules.filter(r => r.ref === desired.ref) ?? [];
  if (matches.length > 1) throw new Error('Ambiguous owned rate rule'); const rule = matches[0] ?? null;
  const normalized = (settings: z.infer<typeof RateSettingsSchema>) => ({ ...settings, requests_to_origin: settings.requests_to_origin ?? false, counting_expression: settings.counting_expression ?? desired.expression });
  const owned = !rule || (rule.ref === desired.ref && rule.expression === desired.expression && rule.action === desired.action && rule.description === desired.description && digestValue(normalized(rule.ratelimit)) === digestValue(normalized(desired.ratelimit)));
  const state = ProductStateSchema.parse({ module: 'rate-limit', digest: digestValue({ desired, ruleset }), rulesetId: ruleset?.id ?? null, rulesetVersion: ruleset?.version ?? null, ruleId: rule?.id ?? null, enabled: rule ? rule.enabled ?? true : null, desiredExpression: desired.expression, owned });
  return { ruleset, rule, state, desired };
}
export function rateReader(client: GuardedClient, token: string): Pick<RateSetupApi, 'entrypoint'> {
  return { entrypoint: async signal => {
    const response = await client.requestJson({ url: `${client.config.apiOrigin}/client/v4/zones/${client.config.zoneId}/rulesets/phases/${RATE_PHASE}/entrypoint`, kind: 'cloudflare', headers: { authorization: `Bearer ${token}` } }, z.object({ success: z.boolean(), result: RateRulesetSchema.nullable() }), signal);
    if (response.status === 404) return null; if (response.status !== 200 || !response.data.success) throw new Error('Rate policy read unavailable'); return response.data.result;
  } };
}
export async function provisionRateLimit(api: RateSetupApi, desired: ReturnType<typeof desiredRateLimit>, expected: ProductState, context: SetupContext) {
  if (!context.plan.includedModules.includes('rate-limit')) throw new Error('Reviewed rate module required');
  const initial = await inspectRateLimit(api, desired, context.signal);
  if (!initial.state.owned || initial.state.digest !== expected.digest) throw new Error('Rate policy ownership or revision drift');
  if (!initial.ruleset) await context.perform('rate-ruleset', desired.ref, () => api.create(desired, context.signal));
  else if (!initial.rule) await context.perform('rate-rule', desired.ref, () => api.append(initial.ruleset!.id, desired, context.signal));
  else if (initial.rule.enabled === false) await context.perform('rate-enable', initial.rule.id, () => api.enable(initial.ruleset!.id, initial.rule!.id, context.signal));
  const final = await inspectRateLimit(api, desired, context.signal);
  if (!final.state.owned || !final.rule || !final.state.enabled || !final.ruleset) throw new Error('Rate policy did not converge');
  const others = (rules: z.infer<typeof RateRulesetSchema> | null) => rules?.rules.filter(r => r.ref !== desired.ref) ?? [];
  if (digestValue(others(initial.ruleset)) !== digestValue(others(final.ruleset))) throw new Error('Unrelated rate rules changed');
  context.observeResource('rate-ruleset', final.ruleset.id); context.observeResource('rate-rule', final.rule.id); return final;
}
