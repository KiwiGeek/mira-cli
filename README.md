# Mira CLI

**Mira** is a terminal REPL that talks to [ChatGPT](https://chatgpt.com) through your **browser session** (Chromium + persistent profile). There is **no OpenAI API key**—you log in like a normal user. The assistant is branded **Mira** in the default instructions.

Repository: [https://github.com/KiwiGeek/mira-cli](https://github.com/KiwiGeek/mira-cli)

## Requirements

- **Node.js** 20+
- npm

## Setup

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
npm run login
```

Complete sign-in in the browser window, then press Enter in the terminal when ready.

## Daily use

```bash
npm run mira
```

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

Optional file (path is shown on first run / `--help`): `%USERPROFILE%\.chatgpt-repl\instructions.txt` on Windows, or `$HOME/.chatgpt-repl/instructions.txt` elsewhere. If present, it replaces the built-in Mira preamble.

## Development notes

- ChatGPT’s DOM changes; fragile bits live in `src/selectors.ts` and related modules.
- Streaming is implemented by **polling** the last assistant bubble in the page—there is no direct token stream from the model.

## Legal

- **Not** affiliated with OpenAI. You use ChatGPT under their terms.
- Licensed under the [MIT License](./LICENSE.md)—see that file for details.
