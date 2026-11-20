/** Pure fail-closed checks shared by runtime code and regression tests. */
export function validatePostgresConnectionString(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('DATABASE_URL fehlt; PostgreSQL-Verbindung wird verweigert.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL ist ungültig; PostgreSQL-Verbindung wird verweigert.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname || parsed.hostname.includes(',') ||
      parsed.pathname.length < 2 || parsed.pathname === '/' ||
      !parsed.username || parsed.searchParams.has('host') ||
      parsed.searchParams.has('hostaddr') || parsed.searchParams.has('service')) {
    throw new Error('DATABASE_URL muss genau ein explizites PostgreSQL-Ziel und eine Datenbank enthalten; Fallback-Ziele sind nicht erlaubt.');
  }
  return value;
}

export function isAuthConfigurationValid(adminPassword: string | undefined, sessionSecret: string | undefined): boolean {
  return typeof adminPassword === 'string' && adminPassword.length >= 12 &&
    typeof sessionSecret === 'string' && sessionSecret.length >= 32;
}

export function requireSessionSecret(sessionSecret: string | undefined): string {
  if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
    throw new Error('ZERO_SESSION_SECRET fehlt oder ist zu kurz; Session wird verweigert.');
  }
  return sessionSecret;
}
