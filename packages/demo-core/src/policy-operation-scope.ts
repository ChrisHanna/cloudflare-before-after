import { z } from 'zod';
import type { Dispatch } from './transport.js';
import { Id } from '../../contracts/src/schemas.js';
export const PolicyOperationScopeSchema = z.strictObject({ runId: Id, requestId: Id, scenarioId: z.enum(['api-shield', 'access']) });
export type PolicyOperationScope = z.infer<typeof PolicyOperationScopeSchema>;
export interface PolicyTransportGuard {
  scope: PolicyOperationScope;
  wrapDispatch?: (dispatch: Dispatch) => Dispatch;
}
/** Copy the authorization scope before any async operation or credential read. */
export function operationGuard(guard?: PolicyTransportGuard, expected?: PolicyOperationScope['scenarioId']) {
  const scope = guard ? Object.freeze(PolicyOperationScopeSchema.parse(guard.scope)) : null;
  if (scope && scope.scenarioId !== expected) throw new Error('Foreign policy operation scope');
  return (init: RequestInit) => {
    if (!scope) return;
    const headers = new Headers(init.headers);
    if (headers.get('x-demo-run-id') !== scope.runId || headers.get('x-demo-request-id') !== scope.requestId || headers.get('x-demo-scenario') !== scope.scenarioId) throw new Error('Foreign run or request at credential dispatch');
  };
}
