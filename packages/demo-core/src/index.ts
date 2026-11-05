export { runWorkshopScenario, analyticsFromCapture, workshopMinimum, workshopWaitingRoomPlan, type WorkshopRunnerOptions, type WorkshopCapture, type OwnedRoomControl } from './workshop-runner.js';
export { runTurnstile, TURNSTILE_TOTAL_REQUESTS, type TurnstileOptions, type TurnstileRun } from './turnstile.js';
export { runApiShield, apiShieldModule, type ApiShieldOptions } from './api-shield.js';
export { runAccessPolicy, accessPolicyModule, type AccessOptions } from './access-policy.js';
export { BrowserTransport, type BrowserPreview, type BrowserTransportOptions, type BrowserFrame, type BrowserFrameScope } from './browser-transport.js';
export { runWaitingRoom, WaitingRoomStateMachine, planWaitingRoom, navigateWaitingRoomShopper } from './waiting-room.js';
export { collectDdosEvidence, reviewDdosEvidence } from './ddos-evidence.js';
export { joinAnalytics, AnalyticsSummarySchema } from './analytics.js';
export { runWorkshopAggregate, type AggregateRun } from './workshop-aggregation.js';
export { InterviewTimeline, INTERVIEW_STAGES, type InterviewRun } from './interview-timeline.js';
export { collectDeploymentVerification, evaluateDeployment } from './deployment-verification-core.js';
export { buildReadinessReport, ReadinessRecordStore, readinessHasCurrentAudit } from './readiness-report-core.js';
export { saveAggregateReadiness } from './workshop-readiness.js';
export { createTrustedCollectors, TrustedCollectors, compareTrustedReadbacks } from './trusted-collectors.js';
export { collectTrustedImage, inspectBoundedPng, TRUSTED_IMAGE_LIMITS } from './trusted-collectors-image.js';
export { readPlatformTlsVerification, bindPlatformTlsAdmission, type PlatformTlsScope, type PlatformTlsAdmission } from './platform-tls.js';
export { createExecutionAudit, assessExecutionAudit } from './execution-audit.js';
export { planOptionalProductSetup, applyOptionalProductSetup, executeOptionalProductSetupStep, createOptionalProductProvider, optionalProductDesired } from './optional-product-setup.js';
export { OptionalProductFileJournal } from './optional-product-setup-store.js';
export function assertSupportedNode(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (!((major === 22 && minor >= 12) || major >= 24)) {
    throw new Error('Node.js 22.12+ (22.x) or Node.js 24+ is required');
  }
}
