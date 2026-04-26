const ADMIN_EMAILS = new Set(["tranthanhhung1641@gmail.com"]);

export function isAdminUser(user?: { email?: string | null; role?: string | null } | null) {
  const email = user?.email?.trim().toLowerCase();
  return user?.role === "admin" || (email ? ADMIN_EMAILS.has(email) : false);
}
