import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { apiShieldModule, type ApiShieldPolicy } from './api-shield.js';
import type { Dispatch } from './transport.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { operationGuard, type PolicyTransportGuard } from './policy-operation-scope.js';

export interface LabClientCertificate { certificate: string; privateKey: string }
const CERTIFICATE_ALERTS = new Set(['ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED', 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN', 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED', 'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED']);
export class MtlsDispatchError extends Error {
  readonly certificateRejected: boolean;
  constructor(code: unknown) { super('mTLS transport failed'); this.certificateRejected = typeof code === 'string' && CERTIFICATE_ALERTS.has(code); }
}
// Inject this dispatch into GuardedClient, not around it: permits, origin
// allowlists, deadlines, bounded bodies and redaction remain the shared client's job.
export function apiShieldDispatch(policy: ApiShieldPolicy, certificateRef: string | null, resolveCertificate: (ref: string) => LabClientCertificate, guard?: PolicyTransportGuard): { dispatch: Dispatch; redactor: Redactor; readonly certificateRejected: boolean } {
  apiShieldModule(policy); const authorize = operationGuard(guard, 'api-shield');
  const origin = new URL(policy.afterOrigin).origin;
  if (certificateRef !== null && certificateRef !== policy.authorizedCertificate.ref && certificateRef !== policy.invalidCertificateRef) throw new Error('Unapproved lab certificate reference');
  let credentials: LabClientCertificate | undefined;
  if (certificateRef !== null) {
    try {
      credentials = resolveCertificate(certificateRef);
      if (!credentials.certificate.includes('-----BEGIN CERTIFICATE-----') || !/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(credentials.privateKey)) throw new Error('Invalid certificate material');
      credentials = { certificate: credentials.certificate, privateKey: credentials.privateKey };
    } catch { throw new MtlsDispatchError(null); }
  }
  const redactor = new Redactor(credentials ? [credentials.certificate, credentials.privateKey] : []);
  let certificateRejected = false;
  const dispatch: Dispatch = async (url, init) => {
    authorize(init); const u = new URL(url);
    if (u.origin !== origin || u.pathname !== '/api' || u.search || u.hash || u.username || u.password || init.method !== 'GET' || init.body || init.redirect !== 'manual') throw new Error('mTLS dispatch is scoped to the protected lab API');
    init.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      try {
        const req = httpsRequest(u, { method: 'GET', headers: Object.fromEntries(new Headers(init.headers)), agent: false, rejectUnauthorized: true, ...(init.signal ? { signal: init.signal } : {}), ...(credentials ? { cert: credentials.certificate, key: credentials.privateKey } : {}) }, message => {
          const status = message.statusCode ?? 502;
          const headers = new Headers();
          for (const [name, values] of Object.entries(message.headers)) if (values !== undefined) for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
          const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(message) as ReadableStream<Uint8Array>;
          if (body === null) message.resume();
          resolve(new Response(body, { status, headers }));
        });
        req.once('error', (error: NodeJS.ErrnoException) => { const safe = new MtlsDispatchError(error.code); certificateRejected = safe.certificateRejected; reject(safe); });
        req.end();
      } catch { reject(new MtlsDispatchError(null)); }
    });
  };
  return { redactor, dispatch: guard?.wrapDispatch ? guard.wrapDispatch(dispatch) : dispatch, get certificateRejected() { return certificateRejected; } };
}
