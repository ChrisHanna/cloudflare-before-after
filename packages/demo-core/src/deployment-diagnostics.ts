import { z } from 'zod';

const Resource = z.enum([
  'cloudflare_image_variant.catalog',
  'cloudflare_d1_database.storefront["before"]', 'cloudflare_d1_database.storefront["after"]',
  'cloudflare_r2_bucket.storefront["before"]', 'cloudflare_r2_bucket.storefront["after"]',
  'cloudflare_workers_custom_domain.lab["before"]', 'cloudflare_workers_custom_domain.lab["after"]', 'cloudflare_workers_custom_domain.lab["telemetry"]',
]);
export const ToolFailureSchema = z.strictObject({
  exitCode: z.number().int().nullable(), stopped: z.boolean(), processQuiescence: z.literal('unproven').optional(),
  diagnostics: z.array(z.strictObject({
    reason: z.enum(['provider-http', 'provider-decode', 'provider-state', 'terraform-error']),
    resource: Resource.nullable(), httpStatus: z.number().int().min(400).max(599).nullable(),
    providerCodes: z.array(z.number().int().min(0).max(999999999)).max(8),
  })).max(8),
});
export type ToolFailure = z.infer<typeof ToolFailureSchema>;

/** Never retain arbitrary summaries, details, URLs, source snippets or stderr. */
export function terraformFailure(output: string, exitCode: number | null, stopped: boolean): ToolFailure {
  const diagnostics: ToolFailure['diagnostics'] = [];
  if (!stopped) for (const line of output.split('\n')) {
    if (diagnostics.length === 8) break;
    try {
      const message = JSON.parse(line);
      if (message?.type !== 'diagnostic' || message.diagnostic?.severity !== 'error') continue;
      const d = message.diagnostic;
      const reason = d.summary === 'failed to make http request' ? 'provider-http'
        : d.summary === 'failed to deserialize http request' ? 'provider-decode'
        : d.summary === 'Provider produced inconsistent result after apply' ? 'provider-state' : 'terraform-error';
      const resource = Resource.safeParse(d.address);
      const detail = typeof d.detail === 'string' ? d.detail : '';
      const status = /(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?: code)?\s*[:=]?\s*|:\s*)([45]\d{2})\b/i.exec(detail);
      const codes = [...detail.matchAll(/"code"\s*:\s*(\d{1,9})\b/g)].slice(0, 8).map(match => Number(match[1]));
      diagnostics.push({ reason, resource: resource.success ? resource.data : null, httpStatus: status ? Number(status[1]) : null, providerCodes: codes });
    } catch { /* Non-JSON and malformed lines stay private. */ }
  }
  return ToolFailureSchema.parse({ exitCode, stopped, ...(stopped ? { processQuiescence: 'unproven' } : {}), diagnostics });
}

export class DeploymentToolError extends Error {
  readonly failure: ToolFailure;
  constructor(failure: ToolFailure) {
    super('Deployment tool failed or exceeded its bounds; no raw output retained');
    this.name = 'DeploymentToolError';
    const parsed = ToolFailureSchema.parse(failure);
    for (const diagnostic of parsed.diagnostics) { Object.freeze(diagnostic.providerCodes); Object.freeze(diagnostic); }
    Object.freeze(parsed.diagnostics); this.failure = Object.freeze(parsed);
  }
}
