// Local development entry point: disables production login only for npm run dev.
process.env.NODE_ENV = 'development';
await import('./server.ts');
