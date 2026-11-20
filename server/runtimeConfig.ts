/**
 * Runtime configuration facade.
 *
 * Local entry points populate process.env through dotenv before importing the
 * server. Prisma Compute populates the same object from typed service inputs
 * before dynamically importing the server. Keeping this reference stable also
 * preserves tests that temporarily modify process.env.
 */
export const runtimeConfig: NodeJS.ProcessEnv = process.env;

/** Remove inherited credentials that are not explicitly supplied to this runtime. */
export function clearRuntimeConfig(keys: readonly string[]): void {
  for (const key of keys) delete runtimeConfig[key];
}

export function configureRuntimeConfig(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) runtimeConfig[key] = value;
  }
}
