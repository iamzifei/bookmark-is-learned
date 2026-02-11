#!/bin/bash
# Install native messaging host for "收藏到就是学到" Chrome extension (macOS).
#
# Usage:
#   ./install-macos.sh <extension-id>
#
# The extension ID is visible at chrome://extensions (enable Developer Mode).

set -e

HOST_NAME="com.btl.file_writer"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/btl_file_writer.py"

if [ -z "$1" ]; then
    echo "用法: ./install-macos.sh <扩展ID>"
    echo ""
    echo "获取扩展 ID:"
    echo "  1. 打开 chrome://extensions"
    echo "  2. 开启「开发者模式」"
    echo "  3. 找到「收藏到就是学到」，复制 ID"
    exit 1
fi

EXT_ID="$1"

# Make the host script executable
chmod +x "$HOST_PATH"

# Install to all detected Chromium-based browser NativeMessagingHosts directories
BROWSER_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
)

count=0
for dir in "${BROWSER_DIRS[@]}"; do
    parent="$(dirname "$dir")"
    if [ -d "$parent" ]; then
        mkdir -p "$dir"
        cat > "$dir/$HOST_NAME.json" << MANIFEST
{
  "name": "$HOST_NAME",
  "description": "File writer for 收藏到就是学到 Chrome extension",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
MANIFEST
        echo "Installed: $dir/$HOST_NAME.json"
        count=$((count + 1))
    fi
done

if [ "$count" -eq 0 ]; then
    echo "No Chromium browser detected. Please install Chrome first."
    exit 1
fi

echo ""
echo "Done! Restart your browser for the changes to take effect."
