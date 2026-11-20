import 'dotenv/config';
// Production entry point: auth is enabled unless explicitly running development/test.
process.env.NODE_ENV = 'production';

console.info('[ZERO BOOT] Production entry point loaded; importing server module.');

try {
  await import('./server.ts');
} catch (error) {
  console.error('[ZERO BOOT] Server module import failed:', error);
  process.exitCode = 1;
}
