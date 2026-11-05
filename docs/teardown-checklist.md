# Manual teardown checklist

**Checklist only. Nothing here authorizes or performs deletion.** Permanent cloud teardown is not implemented. Require a separate reviewed deletion plan and exact approval.

## Before planning removal

- [ ] Stop public demos and scheduled traffic. Confirm active runs and leases are settled.
- [ ] Make a protected Linux-filesystem backup of current `core/terraform.tfstate`, `routing/terraform.tfstate`, and `.lab/intent.json`. Backup `~/.local/share/cloudflare-before-after-backups/20261105T070651Z` contains those three files and SHA-256 manifest only; it is not a full `.evidence` backup.
- [ ] Read current Terraform state and provider inventory. Match every proposed action to a proven lab-owned ID, hostname and current configuration.
- [ ] Record all unknown, shared or changed resources as blockers. Do not repair ownership by guessing.
- [ ] Review the exact saved deletion plan and costs. Failed deletion attempts may leave partial resources; no rollback or automatic retry.

## Always preserve

- [ ] Original Before and After D1 database IDs in retained state.
- [ ] Original Before and After R2 bucket names in retained state.
- [ ] Shared Images variant `public`; it is not owned by this lab.
- [ ] Unrelated DNS records, Workers, Containers, rules or rulesets.
- [ ] Receipts, reports, audit evidence and state backups until a separate retention decision.

## Candidate lab-owned resources (verify each before planning)

- [ ] Worker scripts `cf-interview-before`, `cf-interview-after`, `cf-interview-telemetry`.
- [ ] Images assets `cf-interview-before-product` and `cf-interview-after-product` (plus the retired 1x1 placeholders `cf-interview-before-shirt` and `cf-interview-after-shirt`).
- [ ] The Before, After and receipts custom-domain bindings, only if fresh state/provider reads still confirm ownership.
- [ ] Container applications and Durable Object bindings, only where ownership is explicit.
- [ ] The exact `waf-custom` rule recorded by the current plan; remove only that rule, never the containing ruleset or unrelated rules.
- [ ] Lab-specific secrets only after all consuming Workers and Containers are retired; never expose or copy secret values into the checklist.

## Safe removal order for a future approved plan

- [ ] Re-read capabilities, ownership, state and active leases immediately before planning.
- [ ] Stop traffic and remove only exact lab-owned custom-domain/routing bindings in the reviewed plan.
- [ ] Remove the exact lab WAF rule if and only if its ID and expression still match the approved plan.
- [ ] Remove lab-owned Worker scripts, Container applications and owned Images assets only when listed by the approved plan.
- [ ] Keep the original D1/R2 resources, `public` Images variant, evidence and unrelated account resources.
- [ ] Verify removals with bounded read-only reads. Stop on drift, unknown ownership, partial failure or a retained lease.

No destructive command is provided. Do not run teardown without its own fresh exact plan and approval.
