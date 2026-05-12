import { homedir } from "node:os";
import path from "node:path";

/** Persistent Chromium profile; session survives across REPL runs */
export function defaultProfileDir(): string {
  return path.join(homedir(), ".chatgpt-repl", "chromium-profile");
}
