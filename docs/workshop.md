# Cloudflare workshop

## State and limits

Offline tests use fixtures. They prove code paths, not Cloudflare readiness.
Core, deployment, interview, workshop and saved fallback claims stay separate.
Live qualification is not complete. `pnpm verify:live` exits nonzero and names
its missing collectors. It never deploys or presents fixtures as live proof.
The golden path joins real planners, approval, CLI, journal and reports.
Live mode now reaches those production paths after explicit opt-in.
Its bounded default reader now checks binding readback, image ownership,
actual decoded image bytes, and a fresh authenticated seed-inventory contract.
The shared Worker seed-inventory route is not yet implemented. That gap must
fail repeatability; no live pass or supported provider API is implied.
It also opens the actual React app in installed Chromium, checks paired labels,
loads the CLI-owned run read-only, and compares displayed counts with evidence.
The page uses a loopback proxy to the real authenticated control server.
Remote browser requests are blocked. No browser or package download occurs.
It does not prove a fresh install, deployed storefront views, actual resource
convergence or deployed service use. Old reports, journals, readiness records
and setup state are refused before discovery. Missing browsers fail the exact
command-center stage. Owned servers and browsers are closed on failure too.

## Tools and local checks

Use Node 22 and the pinned pnpm version in package.json. Terraform and Wrangler
versions are pinned in the infrastructure module. The operator must supply
these tools and an already installed Playwright Chromium browser.
Do not use a package runner that silently downloads a tool.

On a host with dependencies already installed, these commands need no pnpm:

```sh
node scripts/check-node.mjs
node node_modules/typescript/bin/tsc --noEmit
node node_modules/typescript/bin/tsc -p apps/storefront-worker/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node node_modules/vite/bin/vite.js build apps/command-center
node node_modules/@playwright/test/cli.js test --workers=1
node scripts/golden-path.mjs
node node_modules/vitest/vitest.mjs run tests/documentation-contract.test.ts tests/deployment-cli-smoke.test.ts --maxWorkers=1
```

Set KIROCREW_SCRATCH (or LAB_TEST_SCRATCH for Playwright output) to an owned
local scratch folder. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH only when using
an existing compatible Chromium binary. No browser download fallback exists.
The browser fixture server binds to 127.0.0.1. No live credentials are needed.

Fresh installation is a separate operator step. These install commands are
for the operator, not this coding run:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

The explicitly activated live harness uses the frozen offline install command.
It never downloads a package or browser. A missing cached package fails checkout.
The CI runner uses an already populated store and `--offline`. Missing packages
or tools fail the check; no install or Terraform check is inferred from tests.
Executable CLI smoke tests compile and run real entrypoints with direct Node.
Their separate pnpm package-script test is explicitly skipped without pnpm.
That skip is an unmet pnpm check, not a package-script validation pass.
Terraform CI requires an explicitly approved local filesystem mirror, not a
previously initialized checkout or Terraform's implicit global plugin cache.
Set OFFLINE_TF_PROVIDER_MIRROR to its absolute directory. Each package must be
unpacked at `registry.terraform.io/cloudflare/cloudflare/5.28.1/linux_amd64/`
(or `linux_arm64/`) below that directory. Supply the complete original package,
including any license files. Symlinks and nested package files are refused.
The package's h1 hash must match each checked-in read-only lock before any
Terraform command runs. Missing or changed locks/packages fail the gate.
Set OFFLINE_TERRAFORM_BIN to the absolute pinned Terraform 1.17.1 executable.
Outside CI, omitting that executable path uses installed `terraform` on PATH;
its real JSON version must still match. No version fallback exists.
Wrangler fixture/schema checks are not a real deployed dry-run.

The CI entrypoint runs every required gate with a clean environment and fresh
scratch per batch. Missing tools fail their exact checks, not unrelated work:

```sh
node scripts/offline-gates.mjs
node scripts/offline-gates.mjs --tools
```

The tools-only command runs actual installed Wrangler and Terraform versions,
formatting, and bootstrap/validation of all three trusted Terraform roots:
`infra/terraform`, `infra/terraform/core-public`, and `infra/terraform/routing`.
The workflow takes the two OFFLINE_TF_* paths from approved repository variables.
An absent mirror is a named failure, never an omitted root or download request.

Only static `.tf` files and each root's checked-in `.terraform.lock.hcl` are
staged in fresh init/validate roots. Static `.tftest.hcl` files use a separate
format-only copy, preserving fmt coverage without executing Terraform tests.
No state, `.terraform`, tfvars or credentials are copied from the checkout.
The package is snapshotted and hash checked before
execution. A generated CLI config permits only that filesystem mirror, with
no direct or network mirror fallback. Every root then runs, through argv:

```sh
terraform -chdir=/owned/scratch/root init -backend=false -input=false -get=false -upgrade=false -lockfile=readonly -no-color
terraform -chdir=/owned/scratch/root validate -no-color
```

The paths above illustrate runner-owned copies, not operator source folders.
Init failure blocks that root's validate; a wrong real tool version blocks all
Terraform execution beyond the version probe. Lock bytes are checked again.
Provider package mismatch fails before even that probe. This does not rely on
an empty HOME to prevent registry fallback. No plan, apply or backend runs.
Each command has a fresh HOME, clean allowlisted environment and metrics off.
Version has a 15-second cap, fmt 30 seconds, init/validate 120 seconds each;
output is capped at 128 KiB and saved logs at 64 KiB. Owned work, provider
copies and homes are removed on exit; bounded logs remain under KIROCREW_SCRATCH.
Other gates keep their existing 15-minute command caps and one-worker tests.

CI also needs a populated pnpm store. Set PNPM_STORE_DIR to that existing cache
when using a clean tool home. The genuine `pnpm install --offline --frozen-lockfile`
gate stays separate: Terraform-only success cannot prove frozen installation
or package-script checks. Do not claim a complete clean-checkout CI pass without
that real install and the full sequence. CI uses no Cloudflare credentials and
cannot qualify deployed readiness.

## Configuration and separate setup

Build first, then print a validated, deliberately blocked template:

```sh
node dist/packages/demo-core/src/example-config.js
```

Save reviewed JSON outside source control, under the checkout's ignored .lab
folder. Replace example account/zone IDs, three lab hostnames, release digest,
and all unknown prices. Confirm resource ownership before enabling liveOptIn.
The output contains secret references only. The generator never reads secrets.

| Reference | Use |
| --- | --- |
| LAB_READER | Read-only account, configuration and evidence |
| LAB_COLLECTOR | Read scoped origin receipts only |
| LAB_DEPLOYER | Separate setup writes only |
| LAB_RUN_SECRET | Scoped synthetic application requests |
| LAB_SETUP_SECRET | Explicit seed/setup operations |

Separate API tokens remain the default. An operator can explicitly choose one
Cloudflare API token for both setup reads and deployment by setting
`discovery.credentials.apiTokenMode` to `"shared"` and setting both `reader`
and `deployer` to the same environment reference, for example
`"env:LAB_API_TOKEN"`. The resolved API values must match in this mode.
Collector, runner and setup application secrets must still be distinct from
that token and from each other. These are app secrets, not additional
Cloudflare API tokens. No secret is generated from the Cloudflare token.

Risk: shared mode gives the runtime reader a deployment-capable credential.
Transport routes still enforce read-only behavior for scenario commands, but
this does not make the credential itself read-only. Scope it to the owned
account and zone and use a short expiry. Optional-product setup obeys the same
explicit shared-mode rule. Changing the mode or references invalidates a saved
plan and requires new exact approval. Cost, ownership and permission checks
are unchanged; shared mode never authorizes deployment by itself.

An owner may separately accept an existing broad API token by setting
`discovery.credentials.allowBroadApiToken` to `true`. This accepts only the
provider's documented all-account and all-zone grant keys alongside the exact
required permission names. It does not accept arbitrary wildcard strings,
foreign exact resources, missing grants or unresolved deny/IP policies.
Without explicit consent, exact-resource grants remain required. Request
allowlists still restrict all operations to the selected account and zone.
The consent is part of the intent digest, so changing it invalidates a prior
approval. Risk: a stolen broad token can affect resources outside this lab,
even though this runner cannot target them.

Never paste values into config, flags, reports, URLs or browser storage. Do not
use personal Cloudflare login credentials. Runner commands have no deployment executor.
Required permission gaps stay unknown; a denied read is not missing entitlement.

The following flow is for a separately authorized owned lab, not ordinary CI.
Use `pnpm --silent` when reading JSON; normal pnpm script banners are not JSON.
This preserves the CLI's strict single-document output without stripping text.

```sh
pnpm --silent lab capabilities --profile core-waf --config /absolute/intent.json --json
pnpm --silent lab plan --profile core-waf --config /absolute/intent.json --json
```

Read the emitted JSON. Use its actual absolute planPath, never a guessed name.
Capture that actual output and parse its planPath:

```sh
PLAN_JSON="$(pnpm --silent lab plan --profile core-waf --config /absolute/intent.json --json)"
PLAN_PATH="$(printf '%s' "$PLAN_JSON" | node --input-type=module -e 'let s=""; for await (const c of process.stdin) s+=c; const p=JSON.parse(s); if (!p.planPath?.startsWith("/")) process.exit(2); console.log(p.planPath)')"
export PLAN_PATH
```

Set PLAN_PATH to that value. Review resource changes, excluded products, costs,
operation caps and deadline. Then approve that exact saved plan interactively:

```sh
pnpm --silent lab approve --config /absolute/intent.json --plan "$PLAN_PATH" --json
pnpm --silent lab apply --config /absolute/intent.json --plan "$PLAN_PATH" --json
pnpm --silent demo doctor --scope core-waf --json
pnpm --silent demo doctor --json
pnpm command-center
pnpm --silent demo waf-custom --json --max-runtime 120 --requests 60
```

Approval requires the exact printed digest and a terminal. Plans expire after
15 minutes. A changed source, scope, capability, cost or desired state needs a
new reviewed plan. Core-WAF doctor may pass while full-catalog doctor fails.
Neither doctor result proves workshop readiness. Unavailable Enterprise products
stay visible and must not trigger purchases or implicit policy repair.

Release rules enforced by the planner and executor: every new `releaseDigest`
needs a fresh `viewRunId` (a reused ID is a plan blocker, because the public
view's Durable Object is bound to one release). Terraform and Wrangler run with
`TMPDIR` on Linux storage; set `KIROCREW_SCRATCH` to a `/tmp` path, and a path
on a Windows-mounted drive is refused. The final storefront readback retries
transient failures (cold start, 429, 5xx) up to three times and fails at once
on a wrong role, release or body.

Optional `"turnstile": { "mode": "test" }` in the intent deploys Cloudflare's
documented test keys to After (Before stays unverified). It adds a public
`/register` check form that verifies a token on the server and stores nothing.
The test secret accepts any token, so test mode shows the flow, not detection
quality, and a live `pnpm demo turnstile` run stays inconclusive by design.

Risk: $100/month is an estimate ceiling, not a provider-enforced spending cap.
Unknown material costs block setup. Budget consent alone does not permit apply.
Failed setup retains confirmed/possible resources and needs explicit recovery.
No automatic rollback, teardown or removal of excluded products is allowed.
Terraform apply uses structured JSON output. Failed attempts can retain only
allowlisted resource addresses, classified reasons, HTTP status and numeric
provider codes; raw tool messages, details, URLs and stderr are not retained.
This metadata survives audit boundaries but is not ownership or readiness proof.
Stopped or output-capped tools retain no parsed diagnostic records. Their
`processQuiescence: "unproven"` marker means only the tool wait was stopped,
not that every escaped descendant exited. Deadlines, abort and output caps
settle without waiting indefinitely for descendant-held pipes. Failed leases
and possibly changed resources remain retained; do not infer safe recovery
from quick Promise settlement or a dead parent PID alone.

## Managed client-certificate prerequisites

API Shield selections can explicitly declare `certificateSource: "zone-managed"`.
The ID must identify an existing API Shield client certificate in the selected
zone, not an uploaded account CA or an outbound Worker mTLS certificate binding.
No source is inferred when that field is absent. Custom-CA setup remains blocked
until its separate certificate-chain and hostname contracts are qualified.

The default reader uses only the documented zone client-certificate GET and the
managed-CA hostname-association GET. It checks the zone/account first, then the
actual certificate ID, active status, issued/expiry times and API-returned SHA-256
fingerprint against the reviewed selection. The After hostname must be associated
exactly once; the Before hostname, wildcard/ambiguous lists and capped/incomplete
readbacks fail closed. No association update, certificate creation or revocation
is performed. Every request uses the read credential and existing setup caps.

Only ID, canonical fingerprint, matching hostname and prerequisite readiness leave
this reader. Certificate PEM, CSR, subject details and private-key fields are not
serialized. A valid prerequisite is not per-request TLS verification or a completed
mTLS comparison. Scoped request facts and exact rule-event proof are described
below; uploaded/custom-CA qualification remains incomplete.

Pinned SDK references:
- [API Shield zone client certificates](https://raw.githubusercontent.com/cloudflare/cloudflare-typescript/v5.2.0/src/resources/client-certificates.ts)
- [Managed versus uploaded-CA hostname associations](https://raw.githubusercontent.com/cloudflare/cloudflare-typescript/v5.2.0/src/resources/certificate-authorities/hostname-associations.ts)

## Independent Worker code fingerprints

The default deployment collector now reads each owned script's actual provider
bytes before and after probes. It uses the SDK's named GET
`/accounts/{account}/workers/scripts/{script}/content/v2`, not a release header,
caller-supplied digest or desired deployment object. The SDK response contract was
checked against the public Cloudflare TypeScript v5.2.0 source; no account was read.

Only a SHA-256 code digest, byte/module counts and public requested-script scope
survive. Source text, module names, private snippets and response errors are not
saved. The guarded transport has a hash-only operation; ordinary content-route reads
are refused. That gate is rechecked before every redirect/retry hop. Ambiguous
encoded control-plane paths are rejected rather than decoded by guesswork.
Discovery account scope and read-only methods are also rechecked at each hop.
Reads share the permit, deadline, cancellation and ownership gates.
Bodies are capped at 4 MiB, and module packages at 32 entries.

JavaScript fingerprints cover MIME type and raw bytes. Qualified multipart/form-data packages
require the provider's explicit main-module header and safe, unique file parts.
The digest covers entrypoint, names, MIME types and each file's bytes, in sorted
order; random boundaries and part ordering do not change it. Unknown MIME types,
missing/ambiguous main modules, duplicate/unsafe parts and denied or oversized reads
remain unavailable rather than becoming an expected fingerprint.

Four additional reads are reserved before dispatch. The complete default probe
allowance is now 22 requests, previously 18. Default collection retains four
hash-only artifacts, two per role, without claiming a deployed runtime release.
Container digest, complete functional readback, write/read and isolation proof
remain separate and unknown. Matching code bytes alone cannot verify deployment.
T36 remains unchecked. This is offline implementation, not live qualification.

### Read-only partial drift snapshots

The existing default binding/content reads now retain a strict `worker-readback`
artifact before and after probes for each role. These contain only observed code
and binding digests, source times, mode and requested-script scope. Missing,
denied, stale, future or wrong-scope reads stay null. Bindings are independently
hashed and checked against their returned functional digest, never an expected
release field.

Default verification reports separate availability, unchanged-code and unchanged-
bindings checks. Actual changes or unreadable parts add named blockers and mark
evidence historical. Matching partial digests cannot populate a complete release,
Container digest or deployment fingerprint; those remain unknown. Four partial
artifacts use the same existing requests, without adding reads or writes.

## Explicit D1 write/read verification

A separate authenticated POST `/internal/d1-write-read` accepts only
`{"action":"d1-write-read"}` with explicit run/request IDs and `waf-custom` scope.
It requires the configured resource identity and a real scoped Container response
before writing the probe. It is not a registration bypass, SQL proxy or setup endpoint.

Migration `0005_verification_probes.sql` keeps fixed synthetic markers outside
application registrations. The server generates a probe ID. Each row is scoped
by role, scenario, run, request and probe. A successful insert must independently
report one changed row; the subsequent read validates every actual owner field
and hashes that row. Cleanup deletes only that exact newly inserted tuple and
fixed marker, then reads again to confirm absence. Existing collisions are not
deleted. DELETE must acknowledge success and exactly one changed row before
absence can confirm cleanup. Uncertain insertion metadata, read failures and
cleanup failures remain explicitly unknown. Possibly effectful writes are never automatically retried.

`TrustedCollectors.d1WriteRead(scope, true)` is an explicit effectful operation,
not part of default read-only deployment collection. The boolean is caller opt-in,
not operator approval. Live use still requires separate reviewed exact-plan
approval. Three HTTP operations are atomically reserved across every ancestor
ledger before dispatch, alongside collector read slots. Concurrent requests cannot
consume that proof allowance; unused quota is released without charging requests.
The actual POST, checkpoint and authenticated telemetry reads still acquire the
shared concurrency permits and deadlines. Denied mutation or origin reads retain
their permission state and exact blocker rather than implying an ambiguous write.
The receipt must match nonce, role, release, resource, time, marker digest and
actual Container completion. Missing evidence is not a zero or an isolation pass.

This component proves only the selected binding's synthetic write/read and
confirmed cleanup. Independent binding identity, runtime/Container fingerprints,
R2 write/read and true cross-binding isolation remain separate required work.
No live writes, migrations or cloud changes were performed for these checks.

## Explicit R2 write/read verification

A separate authenticated POST `/internal/r2-write-read` accepts only
`{"action":"r2-write-read"}` with explicit run/request IDs and `waf-custom` scope.
The server chooses the key beneath its verification role/run/request/probe prefix;
clients cannot select buckets, keys, probe IDs or content. Actual scoped Container
handling must finish before the object operation.

The installed Workers types support conditional PUT with `etagDoesNotMatch: '*'`.
Only an acknowledged new object with matching key, version, ETag, size and owner/
digest metadata establishes ownership. The actual body is bounded to 2 KiB,
decoded strictly and compared to the full fixed marker scope before hashing.
Collisions, unknown PUT replies and foreign versions are never overwritten or
cleaned by guesswork. Read aborts and body disposal initiate cancellation without
awaiting an untrusted, potentially never-settling cancel hook, so cleanup can
still run. A fresh HEAD must still match the new owned version before
DELETE; another HEAD must confirm absence. Failed or unsupported checks remain
unknown, and effectful calls are never automatically retried.

The binding has no conditional DELETE API. The generated key is not exposed until
this server-owned operation finishes; cleanup does not claim safety against an
out-of-band privileged writer racing that key. Such concurrency and physical
cross-binding isolation remain unqualified, not inferred from these operations.

`TrustedCollectors.r2WriteRead(scope, true)` is explicit and non-default, with the
same ancestor/collector proof reservations and authenticated completion joins as
D1. Caller opt-in is not live operator approval. Default deployment/readiness
collection performs no new object writes. All checks here used local R2 fixtures;
no live writes or cloud operations ran. T36 remains incomplete.

## Request-scoped platform TLS facts

Authorized synthetic API Shield requests to the After `/api` route can receive
allowlisted facts from the actual Worker request's `cf.tlsClientAuth`. These are
not read from HTTP verification headers. Before, public, unrelated-scenario,
unauthorized and incompletely correlated requests do not receive the record.

The record binds run/request IDs, role, hostname, release and observation time.
It contains only presented/verified/revoked flags, the supported verification
status and a canonical SHA-256 fingerprint. Subject/issuer names, serials, PEM,
certificate chains and private-key fields are never exported. Missing or malformed
platform data returns null; it is not guessed false. Unsupported fingerprint
lengths are rejected, never truncated to manufacture a match.

The runner decodes the same bounded API response, checking its actual role,
release, MIME type, size, nonce and time window. It sends no extra probe. The
immutable artifact is `tls-client-verification`, not a policy action or policy ID.
Those facts alone do not complete T28. An admitted-control join now requires:
- The independently observed rule snapshot and its exact configuration artifact.
- The same response's TLS facts, HTTP observation and matching artifact digest.
- Exactly one matching Container entry with its authenticated origin reference.

Mode, nonce, role, release, host, time, optional Ray and all reference digests must
agree. `allow` means observed Container admission, not a guess from TLS flags or a
status alone. Actual unverified, revoked, missing or wrong-fingerprint facts are
preserved so an admitted authorized control can fail rather than be rewritten to
match desired settings. A complete observed join takes precedence over a conflicting
adapter assertion. Missing or ambiguous evidence supplies no admission signal.

Protected controls can now use a distinct `cloudflare-mtls-rule-event` record:
- A fresh private snapshot must read the exact mTLS rule expression for this run.
  The run is bound before event lookup; superseded refreshes cannot revive it.
- Exactly one matching custom-rule block event must join the request's Ray and time.
- Its observed configuration digest must match the comparison's actual readback.
- The origin collector must independently prove healthy, complete absence.

This records a rule's observed block, not a TLS handshake or individual certificate
state. Presentation, verified/revoked flags and fingerprint remain unknown. Generic
WAF events, status alone, missing/duplicate events, stale snapshots and unhealthy
origin coverage cannot pass. A missing invalid-certificate control also prevents a
verified scenario. HTTP-less TLS alerts remain unsupported without independent
proof. Fixture success does not establish live Cloudflare readiness; uploaded-CA
qualification remains incomplete.

Observed HTTP or scoped TLS contradictions remain failed when origin collection
or final policy readback becomes unavailable. Missing origin evidence stays unknown,
never a zero count or permission to infer admission. TLS-only contradictions do
not create an allowed/blocked action; they remain separate control facts.

### Offline build boundary

The Worker bundle check uses actual Wrangler with `--containers-rollout=none` and
an unavailable `WRANGLER_DOCKER_BIN`. It validates Worker bundles and configuration,
not a Container image. Wrangler's plain `--dry-run` can still build Docker images.
An earlier test unexpectedly reached Dockerfile package installation and failed
with SIGBUS. Further image builds/install attempts need separate approval; no
successful current Container-image build is claimed.

## Access authentication evidence limits

The default reader can query the documented Access authentication-audit endpoint
with the same guarded request ledger. It requests one bounded account/time page
and joins only the exact protected application, domain, response Ray ID and event
time. Personal email, IP address, connection and assertion fields are discarded
before evidence serialization. Denied reads do not imply missing entitlement;
missing pages, cap-sized results and ambiguous joins stay explicit.

These are authentication events, not complete policy-enforcement evidence. The
pinned SDK contract does not expose a policy ID, audience or lab service-token ID
for these records. Stored `access-authentication` artifacts therefore keep
`policyId` and `audience` null and `identity` unknown. Even `allowed: true` cannot
become a verification signal or a completed Access comparison. T29 stays incomplete
until those missing bindings have a supported independent contract.

The contract was checked against Cloudflare SDK 5.2.0 bundled by the installed
Wrangler, not guessed from an HTTP status:
- [Access audit endpoint and query parameters](https://raw.githubusercontent.com/cloudflare/cloudflare-typescript/v5.2.0/src/resources/zero-trust/access/logs/access-requests.ts)
- [Authentication audit response fields](https://raw.githubusercontent.com/cloudflare/cloudflare-typescript/v5.2.0/src/resources/zero-trust/access/logs/scim/scim.ts)

These public SDK references require no account credentials. No account API call
is needed for ordinary offline tests; they use injected boundary responses.

## Reviewed Waiting Room execution settings

An optional Waiting Room selection may include an `execution` object. It is part
of the exact reviewed optional-plan digest, not a provider API setting or observed
queue proof. Omit it when timing and page contracts are unknown; runtime output
then retains the confirmed room ID/settings without inventing runnable controls.

Example public selection for a separately owned lab:

```json
[
  {
    "module": "waiting-room",
    "settings": {
      "hostname": "after.owned-lab.example",
      "path": "/launch",
      "total_active_users": 200,
      "new_users_per_minute": 200,
      "session_duration": 1,
      "queue_all": false,
      "suspended": false
    },
    "execution": {
      "queueContract": "cloudflare-json-v1",
      "expectedTransitionMs": 15000,
      "perNavigationRequests": 2,
      "refreshes": 1,
      "queueSelector": "[data-queue]",
      "storefrontSelector": "[data-storefront]"
    }
  }
]
```

The 15-second value is an example declared allowance, not a measured wait or
promise of admission. It cannot force Cloudflare to queue any session. Use only
owned synthetic page selectors and separately observed lab expectations. Never
create extra traffic or change setup during a demonstration to manufacture proof.

Changing execution settings changes the optional plan digest and requires a new
exact approval. These fields are never sent to the Cloudflare provisioning API.
After fresh confirmed readback, runtime configuration carries the reviewed values.
The runner still checks all request/session/deadline limits before launching a
browser. An interview plan that cannot fit its 75-second slot is refused.

Live queue qualification still requires an owned browser's actual documented
Cloudflare JSON response, cookie continuity and scoped Container receipts. A
selector, planned delay, resource ID or `queueContract` string supplies no proof.
Synthetic fixture selector qualification remains fixture-only. A missing queue or
same-session transition remains inconclusive, not a completed live demonstration.

## Guarded golden-path entrypoint

Default execution is the offline fixture suite. These commands do not opt in:

```sh
pnpm test:golden-path
pnpm verify:live
```

The second command exits nonzero before provider calls. After separate live-plan
authorization, an operator may use the following flow. Keep intent configuration
at the ignored .lab/intent.json path with ownedLab and liveOptIn set explicitly.

```sh
pnpm test:golden-path --live --opt-in
pnpm test:golden-path --live --opt-in --approve --resume-plan "$PLAN_PATH"
```

The first activated call saves the real emitted plan path and pauses. The
second reloads that exact plan and asks for its digest through the real approval
command. It never writes an approval string itself. Changed, stale, wrong-owner
or over-budget plans must fail before any provider write. Resuming a completed
or partly applied plan is not automatic recovery; create a separately reviewed
recovery plan after inspecting its bounded attempt record.

Each completed stage saves an immutable numbered checkpoint under the configured
evidence directory's golden-path folder. Failed stages retain bounded reasons,
actual command exit codes, the plan path and any fresh run IDs. Earlier live
proof cannot replace a failed current stage. Reports and artifact digests are
rechecked after the repeat run, not merely loaded before it.

Live paired-tab loads use their own 30-request, two-session, 60-second allowance.
Requests retain frame protections and never forward the local presenter cookie.
No infrastructure change may follow apply. The setup journal detects local
attempt changes, but cannot prove no external console repair. Default seed and
inventory readers require the shared authenticated Worker route below. Copied
count assertions cannot prove live convergence. Those gaps block T40 completion, even when fixtures pass.

### Shared seed-inventory boundary required by call 5

Implement GET /internal/seed-inventory in the shared deployed Worker. This is
an application contract, not an asserted Cloudflare API capability. Require the
runner token, exact configured hostname, waf-custom scenario and valid random
run/request IDs. Perform only prepared catalog count/content reads and bounded
R2 catalog listing/content reads. Reject truncated listings and unknown counts.
Return GoldenSeedInventorySchema from the production golden-path module:

- schemaVersion 1; source owned-seed-inventory/v1.
- Fresh echoed runId/requestId, role, labId, releaseDigest and observedAt.
- Actual databaseId, bucketName, catalogCount and objectCount.
- Canonical catalogDigest and objectDigest from actual immutable seed contents.
- The owned ImageAssetSchema delivery tuple, never secret bindings.

The reader independently checks provider Worker bindings and image metadata,
then decodes actual image bytes through collectTrustedImage. Unknown, stale,
wrong-owner, replayed and unsupported-image observations fail. Image upload
source hashes are not assumed equal to transformed delivery hashes. The measured
delivery hash must match the owned runtime asset's expectedDigest.

Fixture tests seed actual local D1/R2 twice. They also call the default reader
with injected boundary transports and actual local Chromium image decoding.
The grayscale seed fixture remains rejected by the strict PNG decoder; a valid
RGBA variant is tested separately. Neither fixture is a live image observation.
The seed-inventory route and the independent setup-to-run execution audit still
need shared integration before T40 can be complete.

## Presentation

The command center prints its loopback URL. Match the sign-in code in its
terminal. Use paired tabs when frame protections block embedding. Never weaken
CSP or collect a person's password. CLI-owned runs appear read-only through the
same evidence journal; refreshing the display must not send target probes.

| Command | Story | Proof limit |
| --- | --- | --- |
| waf-sqli | Inert SQL signature | Exact WAF rule, no exploitation |
| waf-xss | Inert XSS signature | Never render active payloads |
| waf-custom | Synthetic header | Origin plus exact edge rule |
| rate-limit | Bounded API burst | Window, shared key and cooldown |
| bot | Automated client | Scores and blocks are not promised |
| turnstile | Registration check | Application-side, label test keys |
| api-shield | Client certificate | Not API-key validation |
| access | Admin identity gate | No personal login automation |
| waiting-room | Queued and continuing shoppers | Same context must reach admission |
| ddos-evidence | Dated event review | No attack traffic or resilience claim |
| analytics | Joined counts | Unknown is not zero; no revenue claim |

Each manifest supplies the problem, solution, limits and architecture question.
`pnpm demo --help` lists exact flags and budgets. Defaults are 30 total requests,
concurrency 2 and 60 seconds. Hard caps are 100, 4 and 120 seconds, with at most
8 browser sessions. Reads, redirects, retries and browser assets spend permits.
Interview has 100 requests/300 seconds; all/rehearsal has 300/900 seconds.

Interview slots are 0–45, 45–105, 105–165, 165–240 and 240–300 seconds.
Advance never resets time. Waiting Room has only 75 seconds in that agenda.
No queue transition means incomplete proof, never a reason to bypass the room.
Rate-limit reports include cooldownUntil. Wait until it passes; do not reset
shared counters through infrastructure writes.

## Evidence and cleanup

The configured absolute evidence directory is local, ignored and never uploaded.
Reports are immutable JSON/HTML with linked artifact digests. Keep the prior run
when repeating. Corrupt or mismatched release/configuration evidence is not an
eligible fallback. Fixtures are always labeled FIXTURE. Saved results show age
and SAVED EVIDENCE; they never replace a failed live outcome.

Stop closes only runner-owned sessions. Owned temporary registrations and objects
are scoped by environment/scenario/run. Inspect incomplete cleanup and follow
its exact owned leftovers. Never delete shared catalog assets or account-wide
resources. Local evidence retention/deletion is operator-controlled; choose a
retention period and remove only reviewed folders within the configured owned
evidence directory after all writers stop. Cloud teardown is a separate action.
