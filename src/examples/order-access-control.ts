export function isAdmin(_userId: string): boolean {
  return true;
}

export function executeAdminAction<T>(userId: string, action: () => T): T {
  if (!isAdmin(userId)) {
    throw new Error("Unauthorized access.");
  }

  return action();
}
