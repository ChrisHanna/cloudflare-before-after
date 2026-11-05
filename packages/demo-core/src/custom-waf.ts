import { z } from 'zod';
import { digestValue } from './deployment-plan.js';
import { labOrigin } from './config.js';
import { ProductStateSchema, WafModule, type ProductState } from './product-state.js';
import type { SetupContext } from './deployment-apply.js';
const CfId = z.string().regex(/^[a-f0-9]{32}$/);
const Text = z.string().max(4096);
export const CUSTOM_WAF_PHASE = 'http_request_firewall_custom' as const;
export const CUSTOM_WAF_SOURCES = Object.freeze(['firewallrules', 'firewallCustom'] as const);
export const CustomWafRuleSchema = z.object({ id: CfId, ref: z.string().max(128).optional(), action: z.string().max(100), expression: Text, enabled: z.boolean().optional(), description: Text.optional() });
export const CustomWafRulesetSchema = z.object({ id: CfId, kind: z.literal('zone'), phase: z.literal(CUSTOM_WAF_PHASE), version: z.string().min(1).max(128), rules: z.array(CustomWafRuleSchema).max(100) });
export type CustomWafRuleset = z.infer<typeof CustomWafRulesetSchema>;
export function desiredCustomWaf(labId: string, afterOrigin: string, module: WafModule = 'waf-custom') {
  z.string().regex(/^[a-z][a-z0-9-]{2,19}$/).parse(labId);
  const hostname = new URL(labOrigin(afterOrigin)).hostname;
  WafModule.parse(module);
  const marker = module === 'waf-custom' ? `cf-demo-${labId}-block` : module === 'bot' ? `cf-demo-${labId}-bot` : `cf-demo-${labId}:${module === 'waf-sqli' ? "inert-sql:' OR 1=1 -- synthetic only" : '<script>synthetic_inert_signature</script>'}`;
  return Object.freeze({ module, ref: `cf-demo-${labId}-${module}`, action: 'block' as const, enabled: true as const,
    description: `Cloudflare lab ${labId}: ${module} (synthetic only)`,
    expression: `(http.host eq ${JSON.stringify(hostname)} and http.request.uri.path eq "/catalog" and any(http.request.headers["x-demo-test"][*] eq ${JSON.stringify(marker)})${module === 'bot' ? ' and cf.bot_management.score gt 0 and cf.bot_management.score lt 30' : ''})`,
    marker, hostname,
  });
}
export interface CustomWafReader { entrypoint(signal?: AbortSignal): Promise<CustomWafRuleset | null> }
export interface CustomWafSetupApi extends CustomWafReader {
  create(rule: ReturnType<typeof desiredCustomWaf>, signal: AbortSignal): Promise<void>;
  append(rulesetId: string, rule: ReturnType<typeof desiredCustomWaf>, signal: AbortSignal): Promise<void>;
  enable(rulesetId: string, ruleId: string, signal: AbortSignal): Promise<void>;
}
export async function inspectCustomWaf(api: CustomWafReader, desired: ReturnType<typeof desiredCustomWaf>, signal?: AbortSignal) {
  const raw = await api.entrypoint(signal); const ruleset = raw === null ? null : CustomWafRulesetSchema.parse(raw);
  const matches = ruleset?.rules.filter(r => r.ref === desired.ref) ?? [];
  if (matches.length > 1) throw new Error('Owned WAF reference is ambiguous');
  const rule = matches[0] ?? null;
  const owned = !rule || (rule.ref === desired.ref && rule.expression === desired.expression && rule.action === desired.action && rule.description === desired.description);
  const safeRule = rule && !owned ? { id: rule.id, ref: rule.ref, enabled: rule.enabled ?? true, ownershipMismatch: true } : rule;
  const state = ProductStateSchema.parse({ module: desired.module, digest: digestValue({ desired, ruleset: ruleset ? { id: ruleset.id, kind: ruleset.kind, phase: ruleset.phase, version: ruleset.version, order: rule ? ruleset.rules.findIndex(r => r.id === rule.id) + 1 : null, rule: safeRule } : null }), rulesetId: ruleset?.id ?? null, rulesetVersion: ruleset?.version ?? null, ruleId: rule?.id ?? null, enabled: rule ? rule.enabled ?? true : null, desiredExpression: desired.expression, owned });
  return { ruleset, rule, state, desired };
}
export async function provisionCustomWaf(api: CustomWafSetupApi, desired: ReturnType<typeof desiredCustomWaf>, expected: ProductState, context: SetupContext) {
  if (!context.plan.includedModules.includes(desired.module)) throw new Error('Custom WAF is not selected by this reviewed plan');
  const initial = await inspectCustomWaf(api, desired, context.signal);
  if (!initial.state.owned || initial.state.digest !== expected.digest) throw new Error('Custom WAF readback drift or ownership mismatch; create a new plan');
  if (!initial.ruleset) await context.perform('custom-waf-ruleset', desired.ref, () => api.create(desired, context.signal));
  else if (!initial.rule) await context.perform('custom-waf-rule', desired.ref, () => api.append(initial.ruleset!.id, desired, context.signal));
  else if (initial.rule.enabled === false) await context.perform('custom-waf-enable', initial.rule.id, () => api.enable(initial.ruleset!.id, initial.rule!.id, context.signal));
  const final = await inspectCustomWaf(api, desired, context.signal);
  if (!final.state.owned || !final.rule || !final.state.enabled || !final.ruleset) throw new Error('Custom WAF policy did not converge');
  context.observeResource('custom-waf-ruleset', final.ruleset.id); context.observeResource('custom-waf-rule', final.rule.id);
  return final;
}
