import { desiredCustomWaf, inspectCustomWaf, provisionCustomWaf, CustomWafRulesetSchema, type CustomWafRuleset, type CustomWafSetupApi } from './custom-waf.js';
import { WafModule, type ProductState } from './product-state.js';
import { digestValue } from './deployment-plan.js';
import type { LabConfig } from './config.js';
import type { SetupContext } from './deployment-apply.js';
export function observedWafPolicies(config: LabConfig, ruleset: CustomWafRuleset): string[] {
  return ruleset.rules.filter(rule => WafModule.options.some(module => {
    const desired = desiredCustomWaf(config.labId, config.environments[1].origin, module);
    return rule.ref === desired.ref && rule.expression === desired.expression && rule.action === desired.action && rule.description === desired.description;
  })).map(rule => `policy:after:${rule.id}`);
}
/** Review all sibling rules before any write; only our own additive changes advance the checkpoint. */
export async function provisionWafModules(api: (module: WafModule) => CustomWafSetupApi, labId: string, origin: string, modules: readonly WafModule[], expected: readonly ProductState[], context: SetupContext) {
  if (!modules.length || new Set(modules).size !== modules.length) throw new Error('Distinct selected WAF modules required');
  const read = async (adapter: CustomWafSetupApi) => { const raw = await adapter.entrypoint(context.signal); return raw === null ? null : CustomWafRulesetSchema.parse(raw); };
  let checkpoint = await read(api(modules[0]!));
  for (const module of modules) {
    const state = (await inspectCustomWaf({ entrypoint: async () => checkpoint }, desiredCustomWaf(labId, origin, module))).state;
    if (!expected.some(s => s.module === module && s.digest === state.digest && s.owned)) throw new Error('Reviewed sibling WAF policy drift');
  }
  const ids = new Map<WafModule, string>();
  for (const module of modules) {
    const adapter = api(module); const current = await read(adapter);
    if (digestValue(current) !== digestValue(checkpoint)) throw new Error('Concurrent WAF change; no further writes');
    const desired = desiredCustomWaf(labId, origin, module);
    const before = await inspectCustomWaf({ entrypoint: async () => current }, desired);
    const after = await provisionCustomWaf(adapter, desired, before.state, context);
    const others = (ruleset: CustomWafRuleset | null) => ruleset?.rules.filter(r => r.ref !== desired.ref) ?? [];
    if (digestValue(others(current)) !== digestValue(others(after.ruleset))) throw new Error('Unrelated WAF rules changed during setup');
    checkpoint = after.ruleset; ids.set(module, after.rule!.id);
  }
  return { ids, ruleset: checkpoint };
}
