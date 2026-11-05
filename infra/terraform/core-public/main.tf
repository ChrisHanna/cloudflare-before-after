locals {
  roles = toset(["before", "after"])
}

resource "cloudflare_d1_database" "storefront" {
  for_each   = local.roles
  account_id = var.account_id
  name       = "${var.lab_id}-${each.key}-storefront"
  read_replication = {
    mode = "disabled"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "storefront" {
  for_each      = local.roles
  account_id    = var.account_id
  name          = "${var.lab_id}-${each.key}-objects"
  storage_class = "Standard"
  lifecycle {
    prevent_destroy = true
  }
}

# The explicitly selected public variant is an existing read-only dependency.
# There is no variant resource, data source, import, or adoption in this root.
# Lab-owned synthetic images still use the separately approved API upload.
# Use this source in the ORIGINAL core workspace; never move or replace state.
output "core_inventory" {
  value = {
    schema_version       = 1
    account_id           = var.account_id
    lab_id               = var.lab_id
    image_variant        = "public"
    image_variant_source = "existing-public-readonly"
    environments = {
      for role in local.roles : role => {
        worker_name    = "${var.lab_id}-${role}"
        database_name  = cloudflare_d1_database.storefront[role].name
        database_id    = cloudflare_d1_database.storefront[role].id
        bucket_name    = cloudflare_r2_bucket.storefront[role].name
        image_id       = "${var.lab_id}-${role}-product"
        image_owner    = "${var.lab_id}:${role}:immutable-catalog"
        container_name = "${var.lab_id}-${role}-origin"
      }
    }
  }
}
