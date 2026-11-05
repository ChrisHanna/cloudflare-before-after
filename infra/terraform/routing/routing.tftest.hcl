mock_provider "cloudflare" {}

run "three_owned_worker_domains" {
  command = plan
  variables {
    account_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    zone_id    = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    routes = {
      before    = { hostname = "before.example.test", worker_name = "workshop-test-before" }
      after     = { hostname = "after.example.test", worker_name = "workshop-test-after" }
      telemetry = { hostname = "receipts.example.test", worker_name = "workshop-test-telemetry" }
    }
  }
  assert {
    condition     = length(cloudflare_workers_custom_domain.lab) == 3 && cloudflare_workers_custom_domain.lab["before"].hostname != cloudflare_workers_custom_domain.lab["after"].hostname
    error_message = "Before, After and telemetry require distinct routed hostnames."
  }
}
