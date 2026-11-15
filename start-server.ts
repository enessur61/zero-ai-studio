// Production entry point: auth is enabled unless explicitly running development/test.
process.env.NODE_ENV ??= 'production';
await import('./server.ts');
