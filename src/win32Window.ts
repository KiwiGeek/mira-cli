import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";

export function windowDebugEnabled(): boolean {
  return process.env.CHATGPT_REPL_DEBUG_WINDOW === "1";
}

/** C#: HWND hide + exclude from taskbar / Alt+Tab via WS_EX_TOOLWINDOW (see SetVisible). */
const CS = `
namespace ChatGptReplNative {
  using System;
  using System.Collections.Generic;
  using System.Runtime.InteropServices;
  using System.Text;

  [ComImport]
  [Guid("56FDF344-FD6D-11d0-958A-006097C9A090")]
  public class CoTaskbarList { }

  [ComImport]
  [Guid("56FDF342-FD6D-11d0-958A-006097C9A090")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface ITaskbarList {
    [PreserveSig]
    int HrInit();
    [PreserveSig]
    int AddTab(IntPtr hwnd);
    [PreserveSig]
    int DeleteTab(IntPtr hwnd);
    [PreserveSig]
    int ActivateTab(IntPtr hwnd);
    [PreserveSig]
    int SetActiveAlt(IntPtr hwnd);
  }

  public static class ChromiumWindow {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT {
      public int Left, Top, Right, Bottom;
    }

    private const int GWL_EXSTYLE = -20;
    private const uint WS_EX_TOOLWINDOW = 0x00000080;
    private const uint WS_EX_APPWINDOW = 0x00040000;

    private const int SW_HIDE = 0;
    private const int SW_SHOW = 5;
    private const uint GA_ROOT = 2;
    private static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    private const uint SWP_HIDEWINDOW = 0x0080;
    private const uint SWP_SHOWWINDOW = 0x0040;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_FRAMECHANGED = 0x0020;

    private static IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex) {
      return IntPtr.Size == 8
        ? GetWindowLongPtr64(hWnd, nIndex)
        : new IntPtr(GetWindowLong32(hWnd, nIndex));
    }

    private static void SetWindowLongPtrVal(IntPtr hWnd, int nIndex, uint dwNewLong) {
      if (IntPtr.Size == 8) {
        SetWindowLongPtr64(hWnd, nIndex, new IntPtr(unchecked((long)dwNewLong)));
      } else {
        SetWindowLong32(hWnd, nIndex, unchecked((int)dwNewLong));
      }
    }

    private static uint GetExStyle(IntPtr hWnd) {
      return unchecked((uint)GetWindowLongPtr(hWnd, GWL_EXSTYLE).ToInt64());
    }

    /** WS_EX_TOOLWINDOW keeps the HWND out of the taskbar and Alt+Tab; drop WS_EX_APPWINDOW while hidden. */
    private static void ApplyExStyleHideFromSwitcher(IntPtr hWnd) {
      uint ex = GetExStyle(hWnd);
      ex |= WS_EX_TOOLWINDOW;
      ex &= ~WS_EX_APPWINDOW;
      SetWindowLongPtrVal(hWnd, GWL_EXSTYLE, ex);
    }

    private static void ApplyExStyleNormalApp(IntPtr hWnd) {
      uint ex = GetExStyle(hWnd);
      ex &= ~WS_EX_TOOLWINDOW;
      ex |= WS_EX_APPWINDOW;
      SetWindowLongPtrVal(hWnd, GWL_EXSTYLE, ex);
    }

    private static void RefreshFrame(IntPtr hWnd) {
      SetWindowPos(
        hWnd,
        IntPtr.Zero,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
    }

    private static void TryTaskbarDeleteTab(IntPtr hwnd) {
      try {
        ITaskbarList tbl = (ITaskbarList)new CoTaskbarList();
        tbl.HrInit();
        tbl.DeleteTab(hwnd);
      } catch {
        /* non-fatal — COM not always available or tab not registered */
      }
    }

    private static void TryTaskbarAddTab(IntPtr hwnd) {
      try {
        ITaskbarList tbl = (ITaskbarList)new CoTaskbarList();
        tbl.HrInit();
        tbl.AddTab(hwnd);
      } catch {
      }
    }

    private static bool WindowMatches(
      IntPtr hWnd,
      HashSet<int> set,
      int minArea,
      bool requireChrome,
      bool requireTitle,
      out int area) {
      area = 0;
      if (hWnd == IntPtr.Zero || GetParent(hWnd) != IntPtr.Zero) return false;
      uint pidU;
      GetWindowThreadProcessId(hWnd, out pidU);
      if (!set.Contains((int)pidU)) return false;

      var clsSb = new StringBuilder(256);
      if (GetClassName(hWnd, clsSb, clsSb.Capacity) == 0) return false;
      if (requireChrome && !clsSb.ToString().StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return false;

      var titleSb = new StringBuilder(512);
      GetWindowText(hWnd, titleSb, titleSb.Capacity);
      string title = titleSb.ToString();
      if (requireTitle) {
        if (string.IsNullOrEmpty(title)) return false;
        bool ok =
          title.IndexOf("ChatGPT", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("Chromium", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) >= 0
          || title.IndexOf("Google", StringComparison.OrdinalIgnoreCase) >= 0;
        if (!ok) return false;
      }

      RECT r;
      if (!GetWindowRect(hWnd, out r)) return false;
      area = Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
      return area >= minArea;
    }

    private static void CollectRootsScan(
      HashSet<IntPtr> roots,
      HashSet<int> set,
      int minArea,
      bool requireChrome,
      bool requireTitle) {
      EnumWindows((hWnd, lParam) => {
        int areaIgnored;
        if (WindowMatches(hWnd, set, minArea, requireChrome, requireTitle, out areaIgnored)) {
          roots.Add(ResolveRoot(hWnd));
        }
        return true;
      }, IntPtr.Zero);
    }

    private static List<IntPtr> CollectTargetRoots(HashSet<int> set) {
      var roots = new HashSet<IntPtr>();

      CollectRootsScan(roots, set, 400, true, false);
      if (roots.Count == 0) CollectRootsScan(roots, set, 200, false, true);
      if (roots.Count == 0) CollectRootsScan(roots, set, 200, false, false);

      return new List<IntPtr>(roots);
    }

    /**
     * When restoring after hide, only raise the real browser frame. Showing every Chrome_WidgetWin
     * root (including large helper HWNDs with no title) produces empty black windows.
     */
    private static bool IsPreferredShellRestoreRoot(IntPtr hWnd) {
      var clsSb = new StringBuilder(256);
      if (GetClassName(hWnd, clsSb, clsSb.Capacity) == 0) return false;
      string cls = clsSb.ToString();
      if (cls.IndexOf("Chrome_WidgetWin_1", StringComparison.Ordinal) >= 0) return true;
      if (!cls.StartsWith("Chrome_WidgetWin", StringComparison.Ordinal)) return false;
      var titleSb = new StringBuilder(512);
      GetWindowText(hWnd, titleSb, titleSb.Capacity);
      string title = titleSb.ToString().Trim();
      if (title.Length == 0) return false;
      return
        title.IndexOf("ChatGPT", StringComparison.OrdinalIgnoreCase) >= 0
        || title.IndexOf("Chromium", StringComparison.OrdinalIgnoreCase) >= 0
        || title.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) >= 0
        || title.IndexOf("Google", StringComparison.OrdinalIgnoreCase) >= 0
        || title.IndexOf("Mira", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static List<IntPtr> FilterRootsForShow(List<IntPtr> roots) {
      var preferred = new List<IntPtr>();
      foreach (IntPtr h in roots) {
        if (IsPreferredShellRestoreRoot(h)) preferred.Add(h);
      }
      return preferred.Count > 0 ? preferred : roots;
    }

    private static void ApplyShellHide(IntPtr hWnd) {
      ApplyExStyleHideFromSwitcher(hWnd);
      RefreshFrame(hWnd);
      TryTaskbarDeleteTab(hWnd);
      ShowWindow(hWnd, SW_HIDE);
      SetWindowPos(
        hWnd,
        HWND_BOTTOM,
        0,
        0,
        0,
        0,
        SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    private static void ApplyShellShow(IntPtr hWnd) {
      ShowWindow(hWnd, SW_SHOW);
      ApplyExStyleNormalApp(hWnd);
      RefreshFrame(hWnd);
      TryTaskbarAddTab(hWnd);
      SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0, SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER);
    }

    private static IntPtr ResolveRoot(IntPtr raw) {
      IntPtr root = GetAncestor(raw, GA_ROOT);
      return root != IntPtr.Zero ? root : raw;
    }

    public static string DumpTopLevelWindows(int[] processIds) {
      var set = new HashSet<int>(processIds);
      var sb = new StringBuilder();
      sb.AppendLine("[mira/win32] top-level windows in browser PID tree:");
      EnumWindows((hWnd, lParam) => {
        if (GetParent(hWnd) != IntPtr.Zero) return true;
        uint pidU;
        GetWindowThreadProcessId(hWnd, out pidU);
        int pid = (int)pidU;
        if (!set.Contains(pid)) return true;

        var clsSb = new StringBuilder(256);
        GetClassName(hWnd, clsSb, clsSb.Capacity);
        var titleSb = new StringBuilder(512);
        GetWindowText(hWnd, titleSb, titleSb.Capacity);
        RECT r;
        if (!GetWindowRect(hWnd, out r)) return true;
        int area = Math.Max(0, r.Right - r.Left) * Math.Max(0, r.Bottom - r.Top);
        bool vis = IsWindowVisible(hWnd);
        IntPtr root = ResolveRoot(hWnd);
        uint exs = GetExStyle(hWnd);
        string _logTitle = titleSb.ToString().Replace("\\r", " ").Replace("\\n", " ");
        if (_logTitle.Length > 96) {
          _logTitle = _logTitle.Substring(0, 96) + "...";
        }
        sb.AppendLine(
          "  hwnd=0x" + hWnd.ToInt64().ToString("X") +
          " root=0x" + root.ToInt64().ToString("X") +
          " pid=" + pid +
          " area=" + area +
          " visible=" + vis +
          " exstyle=0x" + exs.ToString("X") +
          " class=" + clsSb +
          " title=" + _logTitle);
        return true;
      }, IntPtr.Zero);
      return sb.ToString();
    }

    public static string SetVisible(int[] processIds, bool visible) {
      var set = new HashSet<int>(processIds);
      List<IntPtr> roots = CollectTargetRoots(set);
      if (roots.Count == 0) {
        throw new InvalidOperationException(
          "No Chromium window matched the browser process tree. Is the window still loading?");
      }
      if (visible) {
        roots = FilterRootsForShow(roots);
      }
      var sb = new StringBuilder();
      foreach (IntPtr hWnd in roots) {
        if (visible) {
          ApplyShellShow(hWnd);
        } else {
          ApplyShellHide(hWnd);
        }
        sb.Append("0x").Append(hWnd.ToInt64().ToString("X")).Append(';');
      }
      return "roots=" + sb.ToString() + " count=" + roots.Count + " visible=" + visible;
    }
  }
}
`;

export function getBrowserRootPid(page: Page, profileDir?: string): number | undefined {
  const browser = page.context().browser() as unknown as { process?: () => { pid?: number } };
  const pid = browser?.process?.()?.pid;
  if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) return pid;
  /* launchPersistentContext() returns a context with browser() === null — no ChildProcess PID. */
  if (isWin32() && profileDir && profileDir.length > 0) {
    const found = findChromiumBrowserPidByProfile(profileDir);
    if (windowDebugEnabled() && found !== undefined) {
      console.error(
        `[mira/win32] resolved browser PID ${found} from profile (Playwright persistent context exposes no browser.process()).`,
      );
    }
    return found;
  }
  return undefined;
}

/**
 * Find the Chromium/Edge *browser* process (no `--type=` in command line) for this user-data-dir.
 */
export function findChromiumBrowserPidByProfile(profileDir: string): number | undefined {
  const full = path.resolve(profileDir);
  const safe = full.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
$dir = [System.IO.Path]::GetFullPath('${safe}')
$candidates = @(Get-CimInstance Win32_Process | Where-Object {
  $n = $_.Name
  if ($n -ne 'chrome.exe' -and $n -ne 'msedge.exe') { return $false }
  $cl = $_.CommandLine
  if (-not $cl) { return $false }
  if ($cl -match '--type=') { return $false }
  if ($cl -notmatch 'user-data-dir') { return $false }
  $d2 = $dir -replace '\\\\','/'
  return ($cl -like "*$dir*" -or $cl -like "*$d2*")
})
if ($candidates.Count -eq 0) { exit 2 }
$id = @($candidates | Sort-Object ProcessId | Select-Object -First 1 -ExpandProperty ProcessId)
[System.Console]::Out.Write([string]$id)
exit 0
`;
  const tmp = path.join(os.tmpdir(), `mira-findpid-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, "utf8");
  try {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmp],
      { encoding: "utf-8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    );
    if (typeof r.stderr === "string" && r.stderr.length > 0) {
      process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    }
    if (r.status !== 0) return undefined;
    const out = (r.stdout ?? "").trim();
    const pid = parseInt(out, 10);
    if (!Number.isFinite(pid) || pid <= 0) return undefined;
    return pid;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function buildScript(rootPid: number, visible: boolean, verboseDebug: boolean): string {
  const v = visible ? "$true" : "$false";
  const verb = verboseDebug ? "$true" : "$false";
  return `
$ErrorActionPreference = 'Stop'
$RootId = ${Math.trunc(rootPid)}
$Visible = ${v}
$VerboseDebug = ${verb}

function Get-DescendantProcessIds([int]$Root) {
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  [void]$seen.Add($Root)
  $queue.Enqueue($Root)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$cur" -ErrorAction SilentlyContinue
    if ($null -eq $kids) { continue }
    foreach ($k in @($kids)) {
      $id = [int]$k.ProcessId
      if ($seen.Add($id)) { $queue.Enqueue($id) }
    }
  }
  $arr = New-Object int[] $seen.Count
  $seen.CopyTo($arr, 0)
  return ,$arr
}

$pids = Get-DescendantProcessIds -Root $RootId
if ($null -eq $pids -or $pids.Length -eq 0) { $pids = @( $RootId ) }

if ($VerboseDebug) {
  [Console]::Error.WriteLine("[mira/win32] root PID=$RootId tree size=$($pids.Length) pids=$($pids -join ',')")
}

if (-not ('ChatGptReplNative.ChromiumWindow' -as [type])) {
  Add-Type -TypeDefinition @'
${CS}
'@
}

if ($VerboseDebug) {
  [Console]::Error.WriteLine([ChatGptReplNative.ChromiumWindow]::DumpTopLevelWindows([int[]]@($pids)))
}

$info = [ChatGptReplNative.ChromiumWindow]::SetVisible([int[]]@($pids), $Visible)
if ($VerboseDebug) { [Console]::Error.WriteLine("[mira/win32] " + $info) }
`;
}

export function buildDiagnosticScript(rootPid: number): string {
  return `
$ErrorActionPreference = 'Stop'
$RootId = ${Math.trunc(rootPid)}
function Get-DescendantProcessIds([int]$Root) {
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  [void]$seen.Add($Root)
  $queue.Enqueue($Root)
  while ($queue.Count -gt 0) {
    $cur = $queue.Dequeue()
    $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$cur" -ErrorAction SilentlyContinue
    if ($null -eq $kids) { continue }
    foreach ($k in @($kids)) {
      $id = [int]$k.ProcessId
      if ($seen.Add($id)) { $queue.Enqueue($id) }
    }
  }
  $arr = New-Object int[] $seen.Count
  $seen.CopyTo($arr, 0)
  return ,$arr
}
$pids = Get-DescendantProcessIds -Root $RootId
if (-not ('ChatGptReplNative.ChromiumWindow' -as [type])) {
  Add-Type -TypeDefinition @'
${CS}
'@
}
[Console]::Error.WriteLine([ChatGptReplNative.ChromiumWindow]::DumpTopLevelWindows([int[]]@($pids)))
`;
}

function runPowershellScript(script: string): void {
  const tmp = path.join(os.tmpdir(), `mira-win32-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, "utf8");
  try {
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmp],
      { encoding: "utf-8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );
    if (r.error) throw r.error;
    if (typeof r.stderr === "string" && r.stderr.length > 0) {
      process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    }
    if (r.status !== 0) {
      const combined = [r.stderr, r.stdout].filter((s): s is string => typeof s === "string").join("\n").trim();
      throw new Error(combined || `PowerShell exited with code ${r.status}`);
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Print all top-level HWNDs whose PID is in the browser tree (stderr). */
export function diagnoseBrowserWindows(page: Page, profileDir?: string): void {
  if (!isWin32()) {
    console.error("[mira/win32] diagnose: not Windows.");
    return;
  }
  const root = getBrowserRootPid(page, profileDir);
  if (root === undefined) {
    console.error(
      "[mira/win32] diagnose: no browser PID (Playwright gave no process, and profile scan found no chrome.exe/msedge.exe for this user-data-dir).",
    );
    return;
  }
  try {
    runPowershellScript(buildDiagnosticScript(root));
  } catch (e) {
    console.error("[mira/win32] diagnose failed:", e);
  }
}

export async function hideBrowserWindowWin32(
  page: Page,
  profileDir: string | undefined,
  attempts = 28,
  delayMs = 250,
): Promise<boolean> {
  const root = getBrowserRootPid(page, profileDir);
  if (root === undefined) {
    if (windowDebugEnabled()) {
      console.error(
        "[mira/win32] hide: missing browser PID (no browser.process() and profile scan failed). Is the profile path correct?",
      );
    }
    return false;
  }
  const debug = windowDebugEnabled();

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const verbose = debug && (i === 0 || i === attempts - 1);
      runPowershellScript(buildScript(root, false, verbose));
      if (debug) console.error(`[mira/win32] hide: PowerShell OK on attempt ${i + 1}/${attempts}`);
      return true;
    } catch (err) {
      lastErr = err;
      if (debug) console.error(`[mira/win32] hide attempt ${i + 1}/${attempts} failed:`, err);
      await sleep(delayMs);
    }
  }
  if (debug) {
    console.error("[mira/win32] all hide attempts failed. Window dump:");
    try {
      runPowershellScript(buildDiagnosticScript(root));
    } catch (e) {
      console.error("[mira/win32] dump failed:", e);
    }
    console.error("[mira/win32] last error:", lastErr);
  }
  return false;
}

export async function showBrowserWindowWin32(
  page: Page,
  profileDir: string | undefined,
  attempts = 8,
  delayMs = 200,
): Promise<boolean> {
  const root = getBrowserRootPid(page, profileDir);
  if (root === undefined) return false;
  const debug = windowDebugEnabled();
  for (let i = 0; i < attempts; i++) {
    try {
      runPowershellScript(buildScript(root, true, debug && i === 0));
      return true;
    } catch (err) {
      if (debug) console.error(`[mira/win32] show attempt ${i + 1} failed:`, err);
      await sleep(delayMs);
    }
  }
  return false;
}

export function isWin32(): boolean {
  return process.platform === "win32";
}
