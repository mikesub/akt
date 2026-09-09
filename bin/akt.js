#!/usr/bin/env node
import { main, releaseActiveLock } from '../src/cli.js';

// .env is optional: this slice needs no secrets.
try {
  process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseActiveLock();
    process.exit(1);
  });
}

process.exitCode = await main(process.argv.slice(2));
