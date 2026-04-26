const ADMIN_EMAILS = new Set(["tranthanhhung1641@gmail.com"]);

export function isAdminEmail(email?: string | null) {
  const normalized = email?.trim().toLowerCase();
  return normalized ? ADMIN_EMAILS.has(normalized) : false;
}
