import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defaultInstructionsPath } from "./cliInstructions.js";
import { miraStateDir, packageRoot } from "./paths.js";

function gitStdout(root: string, args: string[]): string | null {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 8_000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (r.status !== 0) return null;
  const s = String(r.stdout ?? "").trim();
  return s.length > 0 ? s : null;
}

/** Lines printed by `/version` (npm semver + git commit / branch / describe when available). */
export function formatInstalledVersionLines(): string[] {
  const root = packageRoot();
  const lines: string[] = [];

  let npmVersion = "";
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version) npmVersion = pkg.version;
  } catch {
    /* ignore */
  }

  const full = gitStdout(root, ["rev-parse", "HEAD"]);
  const short = gitStdout(root, ["rev-parse", "--short", "HEAD"]);

  if (!full && !short) {
    lines.push(npmVersion ? `npm package ${npmVersion}` : "Mira");
    lines.push("Git revision unavailable (.git missing or git not on PATH).");
    return lines;
  }

  lines.push(npmVersion ? `npm package ${npmVersion}` : "Mira");

  const branch = gitStdout(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchNote = branch && branch !== "HEAD" ? ` · ${branch}` : "";
  lines.push(`commit ${full ?? short}${branchNote}`);

  const describe = gitStdout(root, ["describe", "--tags", "--always", "--dirty"]);
  if (describe) lines.push(`describe ${describe}`);

  return lines;
}

/** Lines printed by `/whoami` (paths + active profile + short HEAD). */
export function formatWhoamiLines(activeBrowserProfileDir: string): string[] {
  const pkg = packageRoot();
  const lines: string[] = [];
  lines.push(`package ${pkg}`);
  const gt = gitStdout(pkg, ["rev-parse", "--show-toplevel"]);
  lines.push(gt ? `git root ${gt}` : "git root (none)");
  lines.push(`browser profile ${activeBrowserProfileDir}`);
  lines.push(`state dir ${miraStateDir()}`);
  lines.push(`instructions ${defaultInstructionsPath()}`);
  const sh = gitStdout(pkg, ["rev-parse", "--short", "HEAD"]);
  if (sh) lines.push(`HEAD ${sh}`);
  return lines;
}
