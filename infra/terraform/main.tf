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

resource "cloudflare_image_variant" "catalog" {
  account_id                = var.account_id
  id                        = "${var.lab_id}-catalog"
  never_require_signed_urls = false
  options = {
    fit      = "contain"
    width    = 64
    height   = 64
    metadata = "none"
  }
  lifecycle {
    prevent_destroy = true
  }
}

# Owned synthetic images are uploaded by the separately approved API action.
# Worker/Container deployment belongs to Wrangler, never a competing TF resource.
# Routing is a separate root applied only after the Worker scripts exist.
output "core_inventory" {
  value = {
    schema_version = 1
    account_id     = var.account_id
    lab_id         = var.lab_id
    image_variant  = cloudflare_image_variant.catalog.id
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
