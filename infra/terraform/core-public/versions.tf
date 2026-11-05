terraform {
  required_version = "= 1.17.1"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.1"
    }
  }
}

# Credentials are resolved by the provider from the operator's environment.
# No token is written into configuration, outputs, or the inventory.
provider "cloudflare" {}
