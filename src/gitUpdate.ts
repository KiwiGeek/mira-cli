import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { packageRoot } from "./paths.js";
import { ui } from "./replUi.js";

const LS_REMOTE_TIMEOUT_MS = 25_000;
const FETCH_TIMEOUT_MS = 60_000;

function git(
  gitRoot: string,
  args: string[],
  timeoutMs: number,
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd: gitRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return {
    code: r.status,
    stdout: String(r.stdout ?? "").trim(),
    stderr: String(r.stderr ?? "").trim(),
  };
}

function gitToplevel(fromDir: string): string | null {
  const r = git(fromDir, ["rev-parse", "--show-toplevel"], 8_000);
  if (r.code !== 0 || !r.stdout) return null;
  const line = r.stdout.split("\n")[0]?.trim();
  return line || null;
}

function gitHead(gitRoot: string): string | null {
  const r = git(gitRoot, ["rev-parse", "HEAD"], 8_000);
  if (r.code !== 0 || !r.stdout) return null;
  const h = r.stdout.trim().split(/\s+/)[0]?.toLowerCase();
  return h && /^[0-9a-f]{7,40}$/.test(h) ? h : null;
}

function lsRemoteBranchTip(gitRoot: string, branch: string): string | null {
  const r = git(gitRoot, ["ls-remote", "--heads", "origin", branch], LS_REMOTE_TIMEOUT_MS);
  if (r.code !== 0) return null;
  const line = r.stdout.split("\n")[0]?.trim();
  if (!line) return null;
  const hash = line.split("\t")[0]?.trim().toLowerCase();
  return hash && /^[0-9a-f]{40}$/.test(hash) ? hash : null;
}

function resolveReleaseOrMaster(gitRoot: string): { branch: "release" | "master"; tip: string } | null {
  const rel = lsRemoteBranchTip(gitRoot, "release");
  if (rel) return { branch: "release", tip: rel };
  const mas = lsRemoteBranchTip(gitRoot, "master");
  if (mas) return { branch: "master", tip: mas };
  return null;
}

function hasOrigin(gitRoot: string): boolean {
  const r = git(gitRoot, ["remote", "get-url", "origin"], 8_000);
  return r.code === 0 && !!r.stdout;
}

function fetchOriginBranch(gitRoot: string, branch: string): boolean {
  const r = git(gitRoot, ["fetch", "-q", "origin", branch], FETCH_TIMEOUT_MS);
  return r.code === 0;
}

function revFetchHead(gitRoot: string): string | null {
  const r = git(gitRoot, ["rev-parse", "FETCH_HEAD"], 8_000);
  if (r.code !== 0 || !r.stdout) return null;
  const h = r.stdout.trim().split(/\s+/)[0]?.toLowerCase();
  return h && /^[0-9a-f]{40}$/.test(h) ? h : null;
}

/** True iff `HEAD` is a strict ancestor of `descendant` (linear behind). */
function isStrictAncestor(gitRoot: string, ancestor: string, descendant: string): boolean {
  const r = git(gitRoot, ["merge-base", "--is-ancestor", ancestor, descendant], 8_000);
  return r.code === 0;
}

/** Re-exec this CLI with the same Node binary and arguments (preserves interactive stdio). */
function relaunchRunningCli(): never {
  const node = process.execPath;
  const script = process.argv[1] ?? path.join(packageRoot(), "dist", "cli.js");
  try {
    const r = spawnSync(node, [script, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
      windowsHide: true,
    });
    process.exit(typeof r.status === "number" ? r.status : 1);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ui.warn(`Could not restart automatically (${msg}). Run mira again.`);
    process.exit(1);
  }
}

/**
 * If this install lives in a git clone with `origin`, compare to `origin/release` when that branch
 * exists, else `origin/master`. When the remote is strictly ahead, offer a fast-forward pull and rebuild.
 */
export async function maybePromptGitUpdate(): Promise<void> {
  if (process.env.MIRA_SKIP_UPDATE_CHECK === "1") return;
  if (!input.isTTY || !output.isTTY) return;

  const pkg = packageRoot();
  const gitRoot = gitToplevel(pkg);
  if (!gitRoot || !hasOrigin(gitRoot)) return;

  const upstream = resolveReleaseOrMaster(gitRoot);
  if (!upstream) return;

  const local = gitHead(gitRoot);
  if (!local) return;

  if (upstream.tip === local) return;

  if (!fetchOriginBranch(gitRoot, upstream.branch)) return;

  const fetchTip = revFetchHead(gitRoot);
  if (!fetchTip || fetchTip === local) return;

  if (!isStrictAncestor(gitRoot, local, fetchTip)) return;

  ui.line();
  console.log(
    `  ${ui.yellow("!")}  ${ui.dim(
      `This repo is behind origin/${upstream.branch} (${fetchTip.slice(0, 7)} vs ${local.slice(0, 7)}). Pull the latest?`,
    )}`,
  );
  const rl = readline.createInterface({ input, output });
  let ans = "";
  try {
    ans = (await rl.question(`  ${ui.dim("[y/N] ")}`)).trim().toLowerCase();
  } finally {
    rl.close();
  }
  console.log();
  if (ans !== "y" && ans !== "yes") return;

  const merge = spawnSync("git", ["merge", "--ff-only", "FETCH_HEAD"], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 120_000,
    windowsHide: true,
  });
  if (merge.status !== 0) {
    ui.warn(`Fast-forward merge failed. Pull manually from origin/${upstream.branch} or fix your working tree.`);
    return;
  }

  ui.ok(`Fast-forwarded to origin/${upstream.branch}.`);

  const build = spawnSync("npm", ["run", "build"], {
    cwd: gitRoot,
    stdio: "inherit",
    shell: true,
    timeout: 300_000,
    windowsHide: true,
    env: process.env,
  });
  if (build.status !== 0) {
    ui.warn("npm run build failed — run it in the repo, then start mira again.");
    process.exit(1);
  }

  ui.tip("Restarting with updated CLI…");
  relaunchRunningCli();
}
