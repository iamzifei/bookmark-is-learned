#!/usr/bin/env python3
"""
Native messaging host for the "收藏到就是学到" Chrome extension.

Handles three actions via Chrome's native messaging protocol:
  - ping:        Health check, returns version info
  - pick_folder: Open a native macOS folder picker dialog (via osascript)
  - write_file:  Write UTF-8 content to a specified file path

Security:
  - Paths containing '..' are rejected to prevent directory traversal
  - All paths are resolved via expanduser() + realpath() before writing
  - Only writes within the user's home directory are allowed

Protocol: Each message is a JSON object prefixed by a 4-byte uint32 LE length.
Chrome starts a new process per sendNativeMessage() call.
"""

import json
import os
import struct
import subprocess
import sys


def read_message():
    """Read one native messaging message from Chrome (stdin)."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack('<I', raw_length)[0]
    # Chrome enforces 1MB limit; reject anything larger as a safety guard
    if length > 1024 * 1024:
        return None
    raw = sys.stdin.buffer.read(length)
    return json.loads(raw.decode('utf-8'))


def send_message(msg):
    """Send one native messaging message to Chrome (stdout)."""
    encoded = json.dumps(msg, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def pick_folder():
    """Open a native macOS folder picker via osascript and return the selected path."""
    try:
        proc = subprocess.run(
            ['osascript', '-e',
             'POSIX path of (choose folder with prompt "选择 Markdown 保存文件夹")'],
            capture_output=True, text=True, timeout=120
        )
        if proc.returncode == 0 and proc.stdout.strip():
            path = proc.stdout.strip().rstrip('/')
            return {'success': True, 'path': path, 'name': os.path.basename(path)}
        # User cancelled the dialog
        return {'success': False, 'error': 'cancelled'}
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'timeout'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def validate_path(file_path):
    """
    Validate and resolve a file path for writing.
    Returns (resolved_path, error_string). error_string is None on success.
    """
    # Reject null bytes (could bypass C-level string checks)
    if '\x00' in file_path:
        return None, 'path contains null byte'

    # Reject directory traversal components (e.g. "../" or "..\")
    # Uses os.sep-aware splitting to avoid false positives on names like "foo..bar"
    parts = file_path.replace('\\', '/').split('/')
    if '..' in parts:
        return None, 'path contains ..'

    # Expand ~ to the user's home directory
    expanded = os.path.expanduser(file_path)
    resolved = os.path.realpath(expanded)

    # Security: only allow writing within the user's home directory
    home = os.path.expanduser('~')
    if not resolved.startswith(home + os.sep) and resolved != home:
        return None, 'path is outside home directory'

    return resolved, None


def write_file(file_path, content):
    """Write UTF-8 content to file_path. Creates directories and avoids overwrites."""
    try:
        resolved, err = validate_path(file_path)
        if err:
            return {'success': False, 'error': err}

        dir_path = os.path.dirname(resolved)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)

        # Avoid overwriting existing files — append counter if needed
        base, ext = os.path.splitext(resolved)
        final = resolved
        counter = 0
        while os.path.exists(final) and counter < 100:
            counter += 1
            final = f'{base} ({counter}){ext}'

        with open(final, 'w', encoding='utf-8') as f:
            f.write(content)
        return {'success': True, 'path': final}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def main():
    msg = read_message()
    if not msg:
        return

    action = msg.get('action', '')

    if action == 'ping':
        send_message({'success': True, 'version': '1.2.0'})
    elif action == 'pick_folder':
        send_message(pick_folder())
    elif action == 'write_file':
        p = msg.get('path', '')
        c = msg.get('content', '')
        if not p:
            send_message({'success': False, 'error': 'missing path'})
        else:
            send_message(write_file(p, c))
    else:
        send_message({'success': False, 'error': f'unknown action: {action}'})


if __name__ == '__main__':
    main()
