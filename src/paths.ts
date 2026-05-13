import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the npm package (directory containing package.json / dist/). */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** Per-user app data (profile, history, optional instructions file). */
export function miraStateDir(): string {
  return path.join(homedir(), ".mira");
}

/** Persistent Chromium profile; session survives across REPL runs */
export function defaultProfileDir(): string {
  return path.join(miraStateDir(), "chromium-profile");
}

/** Saved conversation threads (URLs + titles) for `list` / `resume`. */
export function chatHistoryPath(): string {
  return path.join(miraStateDir(), "conversations.json");
}
