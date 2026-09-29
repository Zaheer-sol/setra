import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Load the repository's .env for CLI scripts (Node's built-in parser; existing env vars win). */
export function loadEnvFile(): void {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
