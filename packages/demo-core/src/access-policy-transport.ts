import { Redactor } from '../../contracts/src/redaction.js';
import { accessPolicyModule, type AccessPolicy } from './access-policy.js';
import type { Dispatch } from './transport.js';
import { operationGuard, type PolicyTransportGuard } from './policy-operation-scope.js';
export interface LabAccessServiceToken { clientId: string; clientSecret: string }
// Construct a distinct protected client per credential case. Supply BOTH returned
// fields to GuardedClient; the redactor knows secrets injected at dispatch time.
export function accessPolicyDispatch(policy: AccessPolicy, serviceTokenRef: string | null, resolveToken: (ref: string) => LabAccessServiceToken, dispatch: Dispatch, guard?: PolicyTransportGuard): { dispatch: Dispatch; redactor: Redactor } {
  accessPolicyModule(policy); const authorize = operationGuard(guard, 'access');
  const origin = new URL(policy.afterOrigin).origin;
  if (serviceTokenRef !== null && serviceTokenRef !== policy.serviceTokenRef) throw new Error('Unapproved lab service-token reference');
  let credentials: LabAccessServiceToken | undefined;
  if (serviceTokenRef !== null) {
    try {
      const token = resolveToken(serviceTokenRef);
      if (![token.clientId, token.clientSecret].every(v => typeof v === 'string' && v.length >= 24 && v.length <= 1024 && !/[\r\n]/.test(v))) throw new Error('Invalid service token');
      credentials = { clientId: token.clientId, clientSecret: token.clientSecret };
    } catch { throw new Error('Lab service-token resolution failed'); }
  }
  const redactor = new Redactor(credentials ? [credentials.clientId, credentials.clientSecret] : []);
  const credentialDispatch: Dispatch = async (url, init) => {
    authorize(init); const u = new URL(url);
    if (u.origin !== origin || u.pathname !== '/admin' || u.search || u.hash || u.username || u.password || init.method !== 'GET' || init.body || init.redirect !== 'manual') throw new Error('Access credentials are scoped to the protected lab admin route');
    init.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    if (headers.has('cookie') || headers.has('cf-access-jwt-assertion') || headers.has('cf-access-client-id') || headers.has('cf-access-client-secret')) throw new Error('Personal identity or caller-supplied Access headers are forbidden');
    if (credentials) { headers.set('cf-access-client-id', credentials.clientId); headers.set('cf-access-client-secret', credentials.clientSecret); }
    try { return await dispatch(url, { ...init, headers, redirect: 'manual' }); }
    catch { throw new Error('Access transport failed'); }
  };
  return { redactor, dispatch: guard?.wrapDispatch ? guard.wrapDispatch(credentialDispatch) : credentialDispatch };
}
