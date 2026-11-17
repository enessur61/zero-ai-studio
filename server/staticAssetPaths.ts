export function migrateLegacyStaticAssetPaths(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + migrateLegacyStaticAssetPaths(item), 0);
  }
  if (!value || typeof value !== 'object') return 0;

  let migrated = 0;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item.startsWith('/src/assets/images/')) {
      (value as Record<string, unknown>)[key] = item.replace('/src/assets/images/', '/assets/images/');
      migrated += 1;
    } else if (item && typeof item === 'object') {
      migrated += migrateLegacyStaticAssetPaths(item);
    }
  }
  return migrated;
}
