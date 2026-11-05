terraform {
  required_version = "= 1.17.1"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.1"
    }
  }
}
provider "cloudflare" {}
