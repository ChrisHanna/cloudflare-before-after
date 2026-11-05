# Cloudflare Before/After Workshop

A bounded security workshop with paired storefronts, separate Before/After D1 and R2 bindings, Cloudflare Images, Containers, origin receipts and optional security modules. The After hostname has a custom-WAF lab rule. Offline tests are not live Cloudflare proof.

## Live status — 2026-11-05

- Plan `2cd9f873-17bc-40a2-b4b2-05fe069b46af` applied successfully, 12/12 steps.
- Warm Before/After catalog readbacks returned HTTP 200 with Container-completed markers. The After custom-WAF test returned HTTP 403.
- Entry and completion receipts exist for both roles. Producer/checkpoint coverage remains incomplete; the workshop is not interview-verified.
- A Container restart can reset its local receipt sequence while its Durable Object keeps the producer identity. The resulting Before 503 is reproduced. An offline repair and storefront redesign are in progress and are not deployed.
- SQL-signature WAF, rate limiting, and live analytics are not in the current applied profile. Waiting Room access was denied. Do not present these as live.

See [`docs/workshop.md`](docs/workshop.md) for run commands, evidence rules and limitations, and [`docs/teardown-checklist.md`](docs/teardown-checklist.md) for a non-executable cleanup checklist.

## Local checks

Use Node.js 22 and pinned pnpm 10.34.9. With dependencies already installed:

```sh
pnpm install --offline --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:browser
pnpm build
pnpm ci:offline
```

Wait until the single-writer restart/UI repair is frozen before running full suites. Check its focused tests first; then run the clean offline gates.

## Live planning

Capability discovery and planning do not approve an apply. Review the exact saved plan, resource scope, cost and expiry. Approve only that digest in an interactive terminal. Failed attempts consume their approval and retain a local lease; never retry or recover one automatically.

In WSL, set Terraform's temporary directory on Linux storage for every plan, approval and apply process. The provider plugin handshake failed when Terraform used `/mnt/c/.../tool-home` for `TMPDIR`.

```sh
export KIROCREW_SCRATCH="$(mktemp -d /tmp/cf-terraform-XXXXXX)"
pnpm --silent lab capabilities --profile core-waf --config /absolute/path/to/.lab/intent.json --json
pnpm --silent lab plan --profile core-waf --config /absolute/path/to/.lab/intent.json --json
```

Use the returned `planPath`; review and approve that exact plan separately. Plans expire after fifteen minutes. The $100 monthly ceiling and $80 working estimate are planning figures, not provider-enforced billing caps. Public storefront traffic can increase usage.

This checkout currently has no Git history. Do not commit credentials, `.lab`, `.evidence`, Wrangler state, Terraform state, receipts or generated deployment output.
