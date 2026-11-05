import { z } from 'zod';
import { Digest } from '../../contracts/src/schemas.js';
const CloudflareId = z.string().regex(/^[a-f0-9]{32}$/);
export const WafModule = z.enum(['waf-custom', 'waf-sqli', 'waf-xss', 'bot']);
export type WafModule = z.infer<typeof WafModule>;
export const PolicyModule = z.enum([...WafModule.options, 'rate-limit']);
export const ProductStateSchema = z.strictObject({
  module: PolicyModule, digest: Digest,
  rulesetId: CloudflareId.nullable(), rulesetVersion: z.string().max(128).nullable(),
  ruleId: CloudflareId.nullable(), enabled: z.boolean().nullable(),
  desiredExpression: z.string().min(1).max(4096), owned: z.boolean(),
});
export type ProductState = z.infer<typeof ProductStateSchema>;
export const IMPLEMENTED_DEPLOYMENT_MODULES = Object.freeze(['core', ...PolicyModule.options] as const);
