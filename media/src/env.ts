/**
 * Local `.env` loading, for development only.
 *
 * `config.ts` reads `process.env` and nothing else, which is the right shape
 * for production: on Fly the values arrive as real environment variables set
 * by `fly secrets`, and there is no file to read. But it meant that copying
 * `.env.example` to `.env` and filling it in did nothing at all, which is the
 * first thing anyone tries.
 *
 * So: read `.env` if it happens to be sitting next to the package, and say
 * nothing if it isn't. A missing file is the normal case in production and
 * also the normal case for the offline harness, neither of which should have
 * to care.
 *
 * Values already present in the environment win. `loadEnvFile` does not
 * overwrite them, so an explicit `ANTHROPIC_API_KEY=... npm run harness`
 * still beats whatever is in the file.
 */

import { fileURLToPath } from "node:url";

/** Absolute path to `media/.env`, resolved from this file rather than the cwd. */
const ENV_FILE = fileURLToPath(new URL("../.env", import.meta.url));

export function loadDotEnv(): void {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // No .env. Every value is expected to come from the real environment.
  }
}
