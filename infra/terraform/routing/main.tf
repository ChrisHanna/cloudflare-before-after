variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "An exact lab account ID is required."
  }
}
variable "zone_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.zone_id))
    error_message = "An exact lab zone ID is required."
  }
}
variable "routes" {
  type = map(object({ hostname = string, worker_name = string }))
  validation {
    condition = (
      toset(keys(var.routes)) == toset(["before", "after", "telemetry"]) &&
      length(distinct([for route in values(var.routes) : route.hostname])) == 3 &&
      alltrue([for route in values(var.routes) : can(regex("^[a-z0-9]+([.-][a-z0-9]+)+$", route.hostname)) && can(regex("^[a-z][a-z0-9-]{2,62}$", route.worker_name))])
    )
    error_message = "Three distinct exact hostnames and owned Worker names are required."
  }
}
resource "cloudflare_workers_custom_domain" "lab" {
  for_each   = var.routes
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = each.value.hostname
  service    = each.value.worker_name
  lifecycle {
    prevent_destroy = true
  }
}
output "lab_routes" {
  value = { for role, route in cloudflare_workers_custom_domain.lab : role => { hostname = route.hostname, worker_name = route.service } }
}
