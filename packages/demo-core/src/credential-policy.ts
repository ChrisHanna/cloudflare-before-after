export type CredentialRole = 'reader' | 'deployer' | 'collector' | 'runner' | 'setup';
type Credentials = Partial<Record<CredentialRole, string | undefined>>;

/** Only the two Cloudflare API roles may share a value, with explicit opt-in.
 * Collector, runner and setup secrets must never equal an API credential.
 * Errors intentionally contain no credential values or references.
 */
export function assertCredentialSeparation(credentials: Credentials, sharedApiToken = false): void {
  const roles: CredentialRole[] = ['reader', 'deployer', 'collector', 'runner', 'setup'];
  if (sharedApiToken && (!credentials.reader || !credentials.deployer || credentials.reader !== credentials.deployer)) {
    throw new Error('Shared API token mode requires matching reader and deployer credentials');
  }
  for (let i = 0; i < roles.length; i++) {
    const left = roles[i]!;
    for (const right of roles.slice(i + 1)) {
      if (credentials[left] === undefined || credentials[right] === undefined || credentials[left] !== credentials[right]) continue;
      if (sharedApiToken && left === 'reader' && right === 'deployer') continue;
      throw new Error('Separate application secrets required; API sharing requires explicit shared mode');
    }
  }
}
