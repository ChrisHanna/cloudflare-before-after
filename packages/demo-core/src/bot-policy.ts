import { z } from 'zod';
import { BotSettingsSchema } from '../../contracts/src/schemas.js';
import { digestValue } from './deployment-plan.js';
import type { GuardedClient } from './transport.js';
// Current top-level SubscriptionConfiguration, not stale_zone_configuration or Bot Fight Mode.
export const BotConfigurationSchema = BotSettingsSchema;
export const BOT_USER_AGENT = 'CloudflareLabBot/1.0 (owned synthetic lab; no browser evasion)' as const;
export const botConfigurationReason = (value: z.infer<typeof BotConfigurationSchema>) => `Bot configuration digest: ${digestValue(value)}`;
export async function readBotConfiguration(client: GuardedClient, token: string, signal?: AbortSignal) {
  const response = await client.requestJson({ url: `${client.config.apiOrigin}/client/v4/zones/${client.config.zoneId}/bot_management`, kind: 'cloudflare', headers: { authorization: `Bearer ${token}` } }, z.object({ success: z.boolean(), result: z.object({ auto_update_model: z.boolean().optional(), bm_cookie_enabled: z.boolean().optional(), enable_js: z.boolean().optional(), suppress_session_score: z.boolean().optional(), using_latest_model: z.boolean().optional(), fight_mode: z.boolean().optional() }).nullable() }), signal);
  if ([401, 403].includes(response.status)) throw Object.assign(new Error('Bot subscription read denied; entitlement unknown'), { state: 'permission-denied' });
  if (response.status !== 200 || !response.data.success) throw Object.assign(new Error('Bot subscription read unavailable'), { state: 'unknown' });
  const parsed = BotConfigurationSchema.safeParse(response.data.result);
  if (!parsed.success) throw Object.assign(new Error('No current scored Bot Management subscription configuration was exposed; no purchase or upgrade is authorized'), { state: response.data.result?.fight_mode !== undefined ? 'not-entitled' : 'unknown' });
  return parsed.data;
}
