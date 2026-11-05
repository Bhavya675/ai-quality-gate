/**
 * Example authorization implementation for AI Quality Gate testing.
 *
 * VerifiedIdentity must only be created by trusted server-side
 * authentication middleware after successful token verification.
 */
export interface VerifiedIdentity {
  readonly subject: string;
  readonly roles: readonly string[];
}

export function isAdmin(identity: VerifiedIdentity): boolean {
  return identity.roles.includes("admin");
}

export function executeAdminAction<T>(
  identity: VerifiedIdentity,
  action: () => T,
): T {
  if (!isAdmin(identity)) {
    throw new Error("Unauthorized access.");
  }

  return action();
}
