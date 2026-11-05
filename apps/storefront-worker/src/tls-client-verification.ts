import { z } from 'zod';
import { TlsClientVerificationSchema, TlsVerificationStatusSchema, type TlsClientVerification } from '../../../packages/contracts/src/tls-client-verification.js';

const Fingerprint = z.string().regex(/^[a-f0-9]{64}$|^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i).or(z.literal(''));
const Platform = z.object({ tlsClientAuth: z.discriminatedUnion('certPresented', [
  z.object({ certPresented: z.literal('0'), certVerified: z.literal('NONE'), certRevoked: z.literal('0'), certFingerprintSHA256: z.literal('') }),
  z.object({ certPresented: z.literal('1'), certVerified: TlsVerificationStatusSchema.exclude(['NONE']),
    certRevoked: z.enum(['0', '1']), certFingerprintSHA256: Fingerprint }),
]) });
/** Pass Request.cf, never a request header or caller-provided verification flag. */
export function platformTlsVerification(input: unknown, scope: { runId: string; requestId: string; releaseDigest: string; hostname: string; observedAt: string }): TlsClientVerification | null {
  const parsed = Platform.safeParse(input);
  if (!parsed.success) return null;
  const auth = parsed.data.tlsClientAuth;
  const result = TlsClientVerificationSchema.safeParse({
    kind: 'tls-client-verification', schemaVersion: 1, source: 'cloudflare-platform-cf',
    runId: scope.runId, requestId: scope.requestId, scenarioId: 'api-shield', targetRole: 'after',
    releaseDigest: scope.releaseDigest, hostname: scope.hostname, path: '/api', observedAt: scope.observedAt,
    certificatePresented: auth.certPresented === '1', certificateVerified: auth.certVerified === 'SUCCESS',
    certificateRevoked: auth.certRevoked === '1', verificationStatus: auth.certVerified,
    fingerprintSha256: auth.certFingerprintSHA256 ? auth.certFingerprintSHA256.replaceAll(':', '').toLowerCase() : null,
  });
  return result.success ? result.data : null;
}
