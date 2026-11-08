#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RCLONE="${RCLONE:-$HOME/.local/bin/rclone}"
REMOTE="${MEGA_REMOTE:-mega:Pluralsight}"
DEST="${MEGA_DEST:-$ROOT/videos/mega}"
TOKEN_FILE="$HOME/.config/jellyfin/setup-token.txt"

if ! command -v "$RCLONE" >/dev/null 2>&1; then
  echo "rclone mangler. Installer det eller sett RCLONE=/sti/til/rclone."
  exit 1
fi

if ! "$RCLONE" listremotes | grep -q '^mega:'; then
  echo "MEGA-remoten er ikke konfigurert ennå. Kjør:"
  echo "  $RCLONE config"
  echo "Velg ny remote, navn 'mega', type 'mega', og logg inn."
  exit 1
fi

mkdir -p "$DEST"
echo "Synkroniserer $REMOTE -> $DEST"
"$RCLONE" sync "$REMOTE" "$DEST" --progress --create-empty-src-dirs --transfers 4

echo "Bygger Jellyfin-biblioteket på nytt..."
node "$ROOT/scripts/build-jellyfin-library.js"

if [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
  curl -s -X POST http://localhost:8096/Library/Refresh \
    -H "Authorization: MediaBrowser Token=\"$TOKEN\"" >/dev/null || true
  echo "Jellyfin-skanning startet."
fi

echo "MEGA-synk fullført."
