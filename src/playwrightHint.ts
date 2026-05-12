import { platform } from "node:os";

/**
 * Explains how to install Chromium for *this* checkout's Playwright version.
 * Running `npx playwright install` from another directory often uses another Playwright build and won't help.
 */
export function chromiumInstallHint(installRoot: string): string {
  const lines: string[] = [
    "Chromium is not installed for this app's bundled Playwright.",
    "Install from the same folder as Mira (so npx picks up local node_modules/playwright):",
    "",
  ];
  if (platform() === "win32") {
    lines.push(`  cd /d "${installRoot.replace(/"/g, '\\"')}"`);
  } else {
    lines.push(`  cd ${JSON.stringify(installRoot)}`);
  }
  lines.push("  npx playwright install chromium", "");
  lines.push(
    "Tip: Windows Terminal profiles using only `pwsh -Command mira` may skip your $PROFILE, so PATH or PLAYWRIGHT_BROWSERS_PATH can differ from an interactive shell. Try:",
    '  pwsh -NoExit -Command "& $PROFILE; mira"',
    "or open a normal pwsh tab after installing Chromium with the commands above.",
  );
  return lines.join("\n");
}
