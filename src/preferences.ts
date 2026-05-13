import fs from "node:fs";
import path from "node:path";
import { preferencesPath } from "./paths.js";

export type MiraPreferences = {
  /** When true, assistant inline images are redrawn as sixels when supported (TTY). */
  sixelsEnabled: boolean;
};

const DEFAULT_PREFERENCES: MiraPreferences = {
  sixelsEnabled: false,
};

function parsePrefs(raw: unknown): MiraPreferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFERENCES };
  const o = raw as Record<string, unknown>;
  const six =
    o.sixelsEnabled === true ||
    o.sixelsEnabled === "true" ||
    o.sixelsEnabled === 1 ||
    o.sixelsEnabled === "1";
  return { sixelsEnabled: Boolean(six) };
}

/** Load ~/.mira/preferences.json or defaults when missing / invalid. */
export function loadPreferences(): MiraPreferences {
  const p = preferencesPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_PREFERENCES };
  try {
    const raw = fs.readFileSync(p, "utf8");
    return parsePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

/** Atomically write preferences (creates ~/.mira when needed). */
export function savePreferences(prefs: MiraPreferences): void {
  const p = preferencesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
}
