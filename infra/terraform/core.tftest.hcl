mock_provider "cloudflare" {}

run "separate_core_resources_without_optional_products" {
  command = plan
  variables {
    account_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    lab_id     = "workshop-test"
  }
  assert {
    condition     = length(cloudflare_d1_database.storefront) == 2 && length(cloudflare_r2_bucket.storefront) == 2
    error_message = "Both storefronts require separate real D1 and R2 resources."
  }
  assert {
    condition     = cloudflare_d1_database.storefront["before"].name != cloudflare_d1_database.storefront["after"].name && cloudflare_r2_bucket.storefront["before"].name != cloudflare_r2_bucket.storefront["after"].name
    error_message = "Environment names must not alias."
  }
  assert {
    condition     = cloudflare_image_variant.catalog.id == "workshop-test-catalog" && cloudflare_image_variant.catalog.options.metadata == "none"
    error_message = "An owned small metadata-free Images variant is required."
  }
}
