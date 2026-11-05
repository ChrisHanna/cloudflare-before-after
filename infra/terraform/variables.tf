variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{32}$", var.account_id))
    error_message = "An exact Cloudflare lab account ID is required."
  }
}

variable "lab_id" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.lab_id))
    error_message = "Use a lowercase lab ID of 3 to 20 letters, digits or hyphens."
  }
}
