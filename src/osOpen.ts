import { spawnSync } from "node:child_process";

/** Open a file with the OS default handler (same idea as double-click / `xdg-open`). */
export function openPathWithSystemDefault(filePath: string): boolean {
  if (process.platform === "win32") {
    const r = spawnSync("cmd.exe", ["/c", "start", "", filePath], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    return r.status === 0;
  }
  if (process.platform === "darwin") {
    return spawnSync("open", [filePath], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("xdg-open", [filePath], { stdio: "ignore" }).status === 0;
}
