import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the npm package (directory containing package.json / dist/). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Persistent Chromium profile; session survives across REPL runs */
export function defaultProfileDir(): string {
  return path.join(homedir(), ".chatgpt-repl", "chromium-profile");
}
