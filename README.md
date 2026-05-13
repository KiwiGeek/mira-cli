# Mira CLI

**Mira** is a terminal REPL that talks to [ChatGPT](https://chatgpt.com) through your **browser session** (Chromium + persistent profile). There is **no OpenAI API key**—you log in like a normal user. The assistant is branded **Mira** in the default instructions.

Repository: [https://github.com/KiwiGeek/mira-cli](https://github.com/KiwiGeek/mira-cli)

## Quick install (recommended)

**Windows (PowerShell)** — clones into `%LOCALAPPDATA%\mira-cli`, installs deps + Chromium, adds `%LOCALAPPDATA%\mira-cli\bin` to your **user** PATH (commands: `mira`, `mira-cli`):

```powershell
irm https://raw.githubusercontent.com/KiwiGeek/mira-cli/master/scripts/install.ps1 | iex
```

The `…/master/scripts/…` URLs pull the installer script from the **`master`** branch on GitHub. The installer **clones branch `release`** by default (`MIRA_INSTALL_BRANCH`).

| Environment variable   | Meaning |
|------------------------|---------|
| `MIRA_INSTALL_REPO`    | Git URL (default: this repo) |
| `MIRA_INSTALL_BRANCH`  | Branch (default: `release`) |
| `MIRA_INSTALL_DIR`     | Install root (default: `%LOCALAPPDATA%\mira-cli`) |

On Windows without **winget**, install [Node.js 20+](https://nodejs.org/) and [Git](https://git-scm.com/) yourself, then run the script again.

**macOS / Linux** — review then run:

```bash
curl -fsSL https://raw.githubusercontent.com/KiwiGeek/mira-cli/master/scripts/install.sh | bash
```

Uses `$HOME/.local/share/mira-cli` and writes `mira` + `mira-cli` under `$HOME/.local/bin` (add that dir to `PATH` if the script says so).

**Windows Terminal:** A profile like `pwsh -NoExit -Command mira` often **does not load** `$PROFILE`, so `PATH` (or `PLAYWRIGHT_BROWSERS_PATH`) can differ from your normal PowerShell tab. Either use `pwsh -NoExit -Command "& $PROFILE; mira"` or install Chromium from the Mira folder: `cd $env:LOCALAPPDATA\mira-cli` then `npx playwright install chromium`.

## Requirements

- **Node.js** 20+
- npm

## Setup (manual / from source)

```bash
git clone https://github.com/KiwiGeek/mira-cli.git
cd mira-cli
npm install
npx playwright install chromium
npm run build
```

This project’s `.gitignore` excludes `dist/` and `node_modules/`, so you **must** run `npm run build` after clone.

## First-time login

Save your logged-in ChatGPT session into the Playwright profile:

```bash
mira login
# or: mira-cli login
# from repo: npm run login
```

Complete sign-in in the browser window, then press Enter in the terminal when ready.

## Daily use

```bash
mira
# or: mira-cli
```

From a dev clone you can still use `npm run mira`.

By default the browser window is **hidden** from the taskbar and Alt+Tab on Windows (headed Chromium, not headless). Use **`--show-window`** or **`--no-hide`** for a normal visible window.

### Useful flags

| Flag | Purpose |
|------|---------|
| `--show-window` / `--no-hide` | Keep the browser fully visible |
| `--chat-url URL` | Open an existing `https://chatgpt.com/c/…` thread (skips initial priming) |
| `--on-exit delete` | Delete the thread on `/quit` instead of archiving |
| `--on-exit none` | Skip archive/delete on `/quit` |
| `--no-stream` | Print each reply only after it finishes (no live streaming) |
| `--no-prime` | Skip the automatic preamble message |

Full details: run `npm run mira -- --help` (or see `src/cli.ts`).

### REPL commands

Examples: `/help`, `/new`, `/name My chat title`, `/show`, `/quit`. On **`/quit`**, Mira **archives** the conversation by default and prints a `npm run mira -- --chat-url "…"` command you can use to resume.

## Custom instructions

Optional file (path is shown on first run / `--help`): `%USERPROFILE%\.mira\instructions.txt` on Windows, or `$HOME/.mira/instructions.txt` elsewhere. If present, it replaces the built-in Mira preamble.

## Development notes

- ChatGPT’s DOM changes; fragile bits live in `src/selectors.ts` and related modules.
- Streaming is implemented by **polling** the last assistant bubble in the page—there is no direct token stream from the model.

## Legal

- **Not** affiliated with OpenAI. You use ChatGPT under their terms.
- Licensed under the [MIT License](./LICENSE.md)—see that file for details.
