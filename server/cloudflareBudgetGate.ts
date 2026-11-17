/**
 * Cloudflare Workers AI is blocked unless the operator explicitly enables it
 * after verifying that the account is on Workers Free and cannot incur paid AI
 * usage. These flags are operator attestations, not provider-side verification.
 */
export function isCloudflareWorkersAiAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.ZERO_CLOUDFLARE_AI_ENABLED === 'true' &&
    env.ZERO_CLOUDFLARE_WORKERS_FREE_PLAN_CONFIRMED === 'true';
}

export function assertCloudflareWorkersAiAllowed(
  env: Record<string, string | undefined> = process.env,
): void {
  if (!isCloudflareWorkersAiAllowed(env)) {
    throw new Error(
      'Cloudflare Workers AI ist gesperrt. Erst nach manueller Prüfung des Workers-Free-Tarifs und Ausschluss kostenpflichtiger Nutzung beide ZERO-Freigaben setzen.',
    );
  }
}
