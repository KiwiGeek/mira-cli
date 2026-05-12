#!/usr/bin/env bash
# Install or update Mira CLI: clone/pull, npm, Playwright Chromium, ~/.local/bin shims.
# Review before: curl -fsSL URL | bash
set -euo pipefail

REPO_URL="${MIRA_INSTALL_REPO:-https://github.com/KiwiGeek/mira-cli.git}"
BRANCH="${MIRA_INSTALL_BRANCH:-master}"
INSTALL_DIR="${MIRA_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mira-cli}"
BIN_DIR="${MIRA_INSTALL_BIN:-$HOME/.local/bin}"

need_cmd() { command -v "$1" >/dev/null 2>&1; }

echo ""
echo "Mira CLI installer"
echo "  Repo:    $REPO_URL"
echo "  Branch:  $BRANCH"
echo "  Install: $INSTALL_DIR"
echo "  Bin:     $BIN_DIR"
echo ""

if ! need_cmd git; then
  echo "Git is required. Install git and re-run." >&2
  exit 1
fi

if ! need_cmd node || ! node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" 2>/dev/null; then
  echo "Node.js 20+ is required. Install from https://nodejs.org/ and re-run." >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "▸ Updating existing clone..."
  git -C "$INSTALL_DIR" fetch origin --prune
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull origin "$BRANCH"
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "Directory exists but is not a git repo: $INSTALL_DIR" >&2
  exit 1
else
  echo "▸ Cloning..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

echo "▸ npm install..."
(cd "$INSTALL_DIR" && npm install)
echo "▸ npm run build..."
(cd "$INSTALL_DIR" && npm run build)
echo "▸ Playwright Chromium..."
(cd "$INSTALL_DIR" && npx --yes playwright install chromium)

mkdir -p "$BIN_DIR"
for name in mira mira-cli; do
  target="$BIN_DIR/$name"
  echo "▸ Writing $target"
  cat >"$target" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/dist/cli.js" "\$@"
EOF
  chmod +x "$target"
done

case ":${PATH:-}:" in
  *:"$BIN_DIR":*) echo "▸ PATH already contains $BIN_DIR" ;;
  *)
    echo "▸ Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo "    export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo ""
echo "Done. Next:"
echo "  mira login"
echo "  mira"
echo ""
