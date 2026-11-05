# Reviewed optional product setup

This module is offline-tested code, not deployed product qualification.
It does not run Wrangler, resolve credentials, purchase products or deploy.
The REST routes were checked against the installed Wrangler 4.157.0 bundle.
No unsupported `wrangler access` or `wrangler waiting-room` command is invented.

## Public code

- `packages/demo-core/src/optional-product-setup.ts`: closed product selections,
  observed-state planning, exact extension approval, guarded apply and REST encoding.
- `packages/demo-core/src/optional-product-setup-store.ts`: durable exclusive intent
  records. Possible writes cannot be repeated. Confirmed records cannot change.
- `tests/optional-product-setup.test.ts`: injected provider tests, including actual
  file-journal recovery. Fixture success is not live proof.

## Integrator hooks (shared files were not edited)

1. In `createDeploymentPlan`, register `api-shield`, `access` and `waiting-room`
   through its `implementedModules` argument only when their adapters are wired.
   Do not add these modules to the existing WAF-only `PolicyModule` schema.
2. Call `planOptionalProductSetup` after bounded read-only product discovery.
   Supply prior ownership IDs from the retained setup inventory, not resource names.
   Persist the returned extension and its digest next to the central saved plan.
3. Extend the explicit review/approval surface to approve BOTH the exact central
   digest and exact extension digest. Central approval alone is insufficient.
   `OptionalProductApproval` must come from that trusted approval loader, never
   browser input or a demo command. Include all optional costs in the central estimate.
4. From `LiveSetupExecutor.execute`, route each matching `product-policy` step to
   `executeOptionalProductSetupStep(step, options)`. It dispatches only that step.
   Pass the existing `SetupContext`, signal, operation cap and lab lease.
5. Bind `revalidate` to reload `DeploymentStore.load`, check `DeploymentStore.approval`,
   repeat capability/source/intent/cost checks, then return the exact central plan.
   Bind the optional approval to its saved digest and freshness checks as well.
6. Use `OptionalProductFileJournal(projectRoot, evidenceDirectory)` for production
   intent storage. Never use the tests' in-memory map for real setup.
7. Bind `OptionalProductWireIO.exchange` to the bounded authenticated provider
   transport. Its input is a closed operation union, not an arbitrary URL or API proxy.
   Enforce the configured account/zone, Cloudflare API origin, redirect rejection,
   byte/time/read caps and secret-safe errors. A genuine missing ruleset entrypoint
   may normalize to `{success:true,result:{id:null,rules:[]}}`; denied reads may not.
8. Bind `inspectCertificate` to trusted current certificate/hostname association
   readback. This is a REQUIRED collector dependency, not a caller attestation.
   The code requires an existing certificate and Access service-token ID. It
   never uploads a private key, creates tokens or buys entitlements.

## Operations and boundaries

- mTLS: create an absent custom-phase zone ruleset, or append the exact After `/api`
  rule to the existing ruleset. Verified, revoked and SHA-256 fingerprint checks
  are encoded in its expression. No unrelated rule is replaced or deleted.
- Access: create an After `/admin` self-hosted application with one inline
  `non_identity` service-token policy. No bypass policy or personal login flow.
- Waiting Room: create an After `/launch` room using the existing validated
  supported capacity/session schema. No demo-time room changes or forced queueing.
- Existing identical owned resources become no-ops only after readback. Existing
  resources with changed functional fields are blocked, not automatically updated.
- A partial/uncertain write stops setup. Recovery requires a fresh reviewed
  extension with observed resource IDs. No retries, rollback or implicit teardown.
- Other WAF setup can change the shared ruleset. Such drift blocks the extension;
  inspect the final intended predecessor state and obtain a fresh review rather
  than rewriting its approved digest during apply.

The default trusted certificate collector, central approval persistence/CLI wiring
and live product proof are not supplied by these isolated files. Waiting Room's
supported minimum capacity does not prove three browsers can queue or transition
within the interview limit. Those claims remain blocked until separately observed.
