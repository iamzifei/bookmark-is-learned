// Popup script – manages extension settings and browsing history
// API key is encrypted via AES-GCM before storing in chrome.storage.local.
// Uses safe DOM methods (createElement / textContent) throughout.

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  claude: 'claude-sonnet-4-20250514',
  kimi: 'moonshot-v1-8k',
  zhipu: 'glm-4-flash',
};

// Theme cycle order: auto → light → dark → auto
const THEME_CYCLE = ['auto', 'light', 'dark'];

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  migrateAndLoadSettings();
  setupTabs();
  document.getElementById('provider').addEventListener('change', (e) => updateModelHint(e.target.value));
  document.getElementById('toggleKey').addEventListener('click', toggleKeyVisibility);
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);
  document.getElementById('themeToggle').addEventListener('click', cycleTheme);
  document.getElementById('autoDownloadMd').addEventListener('change', toggleSavePathVisibility);
  document.getElementById('aiEnabled').addEventListener('change', toggleAiFields);
  document.getElementById('pickFolderBtn').addEventListener('click', pickFolder);
  document.getElementById('clearFolderBtn').addEventListener('click', clearFolder);
  document.getElementById('nativeSetupBtn').addEventListener('click', downloadInstallScript);
  document.getElementById('copyDebugBtn').addEventListener('click', copyDebugInfo);
  initFooter();

  // Listen for storage changes so the UI updates when background saves
  // the folder path (after the native picker dialog completes).
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.mdFolderPath) {
      var newPath = changes.mdFolderPath.newValue || '';
      var newName = (changes.mdFolderName && changes.mdFolderName.newValue) || '';
      if (newPath) {
        displaySelectedFolder(newName || newPath.split('/').pop(), newPath);
        showStatus('文件夹已选择', 'success');
      }
    }
  });

  // Load debug info when the debug section is opened
  document.getElementById('debugSection').addEventListener('toggle', function () {
    if (this.open) loadDebugInfo();
  });
});

// ── Theme management ────────────────────────────────────────────────────────

function initTheme() {
  chrome.storage.sync.get({ theme: 'auto' }, function (data) {
    applyTheme(data.theme);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.body.setAttribute('data-theme', theme);
}

function cycleTheme() {
  var currentTheme = document.documentElement.getAttribute('data-theme') || 'auto';
  var idx = THEME_CYCLE.indexOf(currentTheme);
  var nextTheme = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
  applyTheme(nextTheme);
  chrome.storage.sync.set({ theme: nextTheme });
}

// ── API Key encryption (AES-GCM via Web Crypto API) ─────────────────────────

async function getOrCreateEncryptionKey() {
  var stored = await chrome.storage.local.get('encKey');
  if (stored.encKey) {
    return await crypto.subtle.importKey(
      'raw', new Uint8Array(stored.encKey), 'AES-GCM', false, ['encrypt', 'decrypt']
    );
  }
  var key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  var exported = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.local.set({ encKey: Array.from(new Uint8Array(exported)) });
  return key;
}

async function encryptApiKey(plaintext) {
  var key = await getOrCreateEncryptionKey();
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var encoded = new TextEncoder().encode(plaintext);
  var ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, encoded);
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(ciphertext)) };
}

async function decryptApiKey(encrypted) {
  var key = await getOrCreateEncryptionKey();
  var decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(encrypted.iv) },
    key,
    new Uint8Array(encrypted.data)
  );
  return new TextDecoder().decode(decrypted);
}

// ── Migration from plaintext sync storage ────────────────────────────────────

async function migrateAndLoadSettings() {
  var syncData = await chrome.storage.sync.get({
    provider: 'openai',
    apiKey: '',
    language: 'zh-CN',
    mdMode: 'tldr',
    model: '',
    baseUrl: '',
    autoDownloadMd: true,
    mdFolderPath: '',  // folder path saved by background.js via native picker
    theme: 'auto',
    aiEnabled: true,
  });

  // If a plaintext key exists in sync, migrate it
  if (syncData.apiKey) {
    var encrypted = await encryptApiKey(syncData.apiKey);
    await chrome.storage.local.set({ encryptedApiKey: encrypted });
    await chrome.storage.sync.remove('apiKey');
  }

  // Load the encrypted key for display
  var apiKeyPlain = '';
  var localData = await chrome.storage.local.get('encryptedApiKey');
  if (localData.encryptedApiKey) {
    try {
      apiKeyPlain = await decryptApiKey(localData.encryptedApiKey);
    } catch (_) {
      // Decryption failed — key may be corrupted; user will re-enter
    }
  }

  document.getElementById('provider').value = syncData.provider;
  document.getElementById('apiKey').value = apiKeyPlain;
  document.getElementById('language').value = syncData.language;
  document.getElementById('mdMode').value = syncData.mdMode || 'tldr';
  document.getElementById('model').value = syncData.model;
  document.getElementById('baseUrl').value = syncData.baseUrl || '';
  document.getElementById('autoDownloadMd').checked = syncData.autoDownloadMd;
  document.getElementById('aiEnabled').checked = syncData.aiEnabled !== false;
  updateModelHint(syncData.provider);
  toggleSavePathVisibility();
  toggleAiFields();

  // Load folder display from stored path
  if (syncData.mdFolderPath) {
    var name = syncData.mdFolderPath.split('/').pop();
    displaySelectedFolder(name, syncData.mdFolderPath);
  }

  // Check native host status and update UI accordingly
  checkNativeHost().then(function (available) {
    nativeHostAvailable = available;
    var textEl = document.getElementById('nativeSetupText');
    var btn = document.getElementById('nativeSetupBtn');
    if (available) {
      textEl.textContent = 'Native Helper 已安装。如需重装或更新，可重新下载脚本运行。';
      btn.textContent = '重新下载安装脚本';
      updateSavePathHint(true);
    } else {
      textEl.textContent = '浏览器扩展受沙盒限制，无法直接写入自定义文件夹。安装 Native Helper 后即可选择任意保存路径。';
      btn.textContent = '一键下载安装脚本';
      document.getElementById('pickFolderBtn').disabled = true;
      updateSavePathHint(false);
    }
  });
}

// ── Native host detection ─────────────────────────────────────────────────────

async function checkNativeHost() {
  try {
    var result = await chrome.runtime.sendMessage({ type: 'PING_NATIVE_HOST' });
    return !!(result && result.success);
  } catch (_) {
    return false;
  }
}

// ── Folder picker (native messaging host) ────────────────────────────────────

// Track whether native host is available (checked once on popup open)
var nativeHostAvailable = false;

// Show or hide save path section based on auto-download checkbox
function toggleSavePathVisibility() {
  var checked = document.getElementById('autoDownloadMd').checked;
  document.getElementById('savePathGroup').style.display = checked ? 'block' : 'none';
}

// Toggle AI config fields and save mode visibility based on AI toggle state.
// Persists immediately so the setting takes effect without clicking "保存设置".
function toggleAiFields() {
  var enabled = document.getElementById('aiEnabled').checked;
  var card = document.getElementById('aiConfigCard');
  var mdModeGroup = document.getElementById('mdModeGroup');
  if (enabled) {
    card.classList.remove('ai-disabled');
    if (mdModeGroup) mdModeGroup.style.display = 'block';
  } else {
    card.classList.add('ai-disabled');
    if (mdModeGroup) mdModeGroup.style.display = 'none';
  }
  chrome.storage.sync.set({ aiEnabled: enabled });
}

// Update the hint text below the folder picker based on current state
function updateSavePathHint(available) {
  var hintEl = document.getElementById('savePathHint');
  var hasFolder = document.getElementById('folderPath').classList.contains('active');
  if (hasFolder) {
    return; // hint is set by displaySelectedFolder
  }
  if (available) {
    hintEl.textContent = '未选择文件夹，保存到下载目录 bookmark-is-learned 子文件夹';
  } else {
    hintEl.textContent = '安装 Native Helper 后可选择任意文件夹保存';
  }
}

// Fire-and-forget: send pick request to background, don't block the popup.
// Background opens the native macOS folder picker (osascript), saves the
// result to sync storage. The popup's onChanged listener updates the UI.
function pickFolder() {
  if (!nativeHostAvailable) {
    showStatus('请先安装 Native Helper', 'error');
    return;
  }
  // Fire and forget — do NOT await this
  chrome.runtime.sendMessage({ type: 'PICK_NATIVE_FOLDER' });
  showStatus('文件夹选择对话框已打开...', 'success');
}

function clearFolder() {
  chrome.storage.sync.remove(['mdFolderPath', 'mdFolderName']);
  displayNoFolder();
  updateSavePathHint(nativeHostAvailable);
  showStatus('已清除，将保存到下载目录', 'success');
}

function displaySelectedFolder(name, path) {
  var pathEl = document.getElementById('folderPath');
  if (path) {
    // Show shortened path: replace /Users/xxx with ~
    var displayPath = path.replace(/^\/Users\/[^/]+/, '~');
    pathEl.textContent = displayPath;
    pathEl.title = path;
  } else {
    pathEl.textContent = name;
    pathEl.title = '';
  }
  pathEl.classList.add('active');
  document.getElementById('clearFolderBtn').style.display = 'inline';
  document.getElementById('savePathHint').textContent = '文件将保存到: ' + (path || name);
}

function displayNoFolder() {
  var pathEl = document.getElementById('folderPath');
  pathEl.textContent = '未选择';
  pathEl.title = '';
  pathEl.classList.remove('active');
  document.getElementById('clearFolderBtn').style.display = 'none';
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function setupTabs() {
  var tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-tab');
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('tab-' + target).classList.add('active');
      if (target === 'history') {
        loadHistory();
      }
    });
  });
}

// ── Settings functions ────────────────────────────────────────────────────────

function updateModelHint(provider) {
  document.getElementById('modelHint').textContent =
    '\u9ED8\u8BA4: ' + (DEFAULT_MODELS[provider] || '');
}

function toggleKeyVisibility() {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
}

async function saveSettings() {
  try {
    const apiKeyPlain = document.getElementById('apiKey').value.trim();
    const baseUrlInput = document.getElementById('baseUrl').value.trim();

    var mdMode = document.getElementById('mdMode').value;
    var aiEnabled = document.getElementById('aiEnabled').checked;
    if (!apiKeyPlain && mdMode !== 'original' && aiEnabled) {
      showStatus('\u8BF7\u586B\u5199 API Key', 'error');
      return;
    }

    var baseUrl = '';
    if (baseUrlInput) {
      baseUrl = normalizeBaseUrl(baseUrlInput);
      if (!baseUrl) {
        showStatus('Base URL 格式无效', 'error');
        return;
      }
    }

    // Encrypt API key and store in local storage (device-only)
    if (apiKeyPlain) {
      var encrypted = await encryptApiKey(apiKeyPlain);
      await chrome.storage.local.set({ encryptedApiKey: encrypted });
    }

    // Store non-sensitive settings in sync storage.
    // Note: mdFolderPath is saved separately by the folder picker (background.js).
    await chrome.storage.sync.set({
      provider: document.getElementById('provider').value,
      language: document.getElementById('language').value,
      mdMode: document.getElementById('mdMode').value,
      model: document.getElementById('model').value.trim(),
      baseUrl: baseUrl,
      autoDownloadMd: document.getElementById('autoDownloadMd').checked,
      aiEnabled: document.getElementById('aiEnabled').checked,
    });

    if (baseUrl) {
      var permissionResult = await ensureOriginPermission(toOriginPattern(baseUrl));
      if (!permissionResult.granted) {
        showStatus('设置已保存，请授权 Base URL 域名访问权限', 'success');
        return;
      }
    }

    showStatus('\u8BBE\u7F6E\u5DF2\u4FDD\u5B58', 'success');
  } catch (err) {
    console.error('[popup] saveSettings error:', err);
    showStatus('保存失败，请重试', 'error');
  }
}

function normalizeBaseUrl(value) {
  try {
    var normalizedInput = value;
    if (!/^https?:\/\//i.test(normalizedInput)) {
      normalizedInput = 'https://' + normalizedInput;
    }
    var url = new URL(normalizedInput);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '';
    }
    var path = url.pathname.replace(/\/+$/, '');
    return url.origin + path;
  } catch (_) {
    return '';
  }
}

function toOriginPattern(baseUrl) {
  var parsed = new URL(baseUrl);
  return parsed.origin + '/*';
}

function ensureOriginPermission(originPattern) {
  return new Promise(function (resolve) {
    if (!chrome.permissions || !chrome.permissions.contains || !chrome.permissions.request) {
      resolve({ granted: false });
      return;
    }
    chrome.permissions.contains({ origins: [originPattern] }, function (hasPermission) {
      if (chrome.runtime.lastError) { resolve({ granted: false }); return; }
      if (hasPermission) { resolve({ granted: true }); return; }
      chrome.permissions.request({ origins: [originPattern] }, function (granted) {
        if (chrome.runtime.lastError) { resolve({ granted: false }); return; }
        resolve({ granted: !!granted });
      });
    });
  });
}

// Track active status timer so rapid calls don't clear each other prematurely
var statusTimer = null;

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = 'status ' + type;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.textContent = '';
    el.className = 'status';
    statusTimer = null;
  }, 2000);
}

// ── Debug info ────────────────────────────────────────────────────────────────

async function loadDebugInfo() {
  var infoEl = document.getElementById('debugInfo');

  try {
    // Gather all debug data in parallel
    var [syncData, localData, nativeResult] = await Promise.all([
      chrome.storage.sync.get({
        provider: 'openai',
        model: '',
        language: 'zh-CN',
        baseUrl: '',
        autoDownloadMd: true,
        mdFolderPath: '',
        aiEnabled: true,
      }),
      chrome.storage.local.get({ lastSave: null }),
      chrome.runtime.sendMessage({ type: 'PING_NATIVE_HOST' }).catch(function () { return null; }),
    ]);

    var nativeStatus = (nativeResult && nativeResult.success)
      ? 'v' + (nativeResult.version || '?')
      : 'not installed';

    var lines = [];
    lines.push('Extension ID: ' + chrome.runtime.id);
    lines.push('Manifest: v' + chrome.runtime.getManifest().version);
    lines.push('Native Host: ' + nativeStatus);
    lines.push('Provider: ' + syncData.provider);
    lines.push('Model: ' + (syncData.model || DEFAULT_MODELS[syncData.provider] || 'default'));
    lines.push('Language: ' + syncData.language);
    if (syncData.baseUrl) {
      lines.push('Base URL: ' + syncData.baseUrl);
    }
    lines.push('Auto Download: ' + (syncData.autoDownloadMd ? 'on' : 'off'));
    lines.push('AI Enabled: ' + (syncData.aiEnabled !== false ? 'on' : 'off'));
    lines.push('Save Path: ' + (syncData.mdFolderPath || '(downloads folder)'));

    if (localData.lastSave) {
      var ls = localData.lastSave;
      var timeStr = new Date(ls.timestamp).toLocaleString();
      var statusStr = ls.success ? 'success' : ('failed: ' + (ls.error || 'unknown'));
      lines.push('Last Save: ' + timeStr + ' — ' + statusStr);
      if (ls.path) {
        lines.push('Last Path: ' + ls.path);
      }
    } else {
      lines.push('Last Save: (none)');
    }

    infoEl.textContent = lines.join('\n');
  } catch (err) {
    infoEl.textContent = 'Error loading debug info: ' + err.message;
  }
}

async function copyDebugInfo() {
  var infoEl = document.getElementById('debugInfo');
  var btn = document.getElementById('copyDebugBtn');
  try {
    await navigator.clipboard.writeText(infoEl.textContent);
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = '复制调试信息';
      btn.classList.remove('copied');
    }, 1500);
  } catch (_) {
    // Fallback: select text for manual copy
    var range = document.createRange();
    range.selectNodeContents(infoEl);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ── Footer: version display + update check ───────────────────────────────────

var UPDATE_CHECK_REPO = 'iamzifei/bookmark-is-learned';

function initFooter() {
  var manifest = chrome.runtime.getManifest();
  document.getElementById('versionLabel').textContent = 'v' + manifest.version;
  checkForUpdate(manifest.version);
}

// Compare the local extension version against the latest GitHub release.
// Uses a 24-hour cache in chrome.storage.local to avoid hitting the API
// every time the popup opens.
async function checkForUpdate(currentVersion) {
  try {
    var cacheData = await chrome.storage.local.get('updateCheck');
    var cache = cacheData.updateCheck;
    var now = Date.now();

    // Use cached result if checked within the last 24 hours
    if (cache && cache.checkedAt && (now - cache.checkedAt) < 24 * 60 * 60 * 1000) {
      if (cache.latestVersion && isNewerVersion(cache.latestVersion, currentVersion)) {
        showUpdateBadge(cache.latestVersion);
      }
      return;
    }

    var res = await fetch(
      'https://api.github.com/repos/' + UPDATE_CHECK_REPO + '/releases/latest',
      { headers: { Accept: 'application/vnd.github.v3+json' } }
    );
    if (!res.ok) return;

    var data = await res.json();
    var latestTag = (data.tag_name || '').replace(/^v/, '');
    if (!latestTag) return;

    // Cache the result for 24 hours
    await chrome.storage.local.set({
      updateCheck: { latestVersion: latestTag, checkedAt: now },
    });

    if (isNewerVersion(latestTag, currentVersion)) {
      showUpdateBadge(latestTag);
    }
  } catch (_) {
    // Network error or API failure — silently ignore
  }
}

// Simple semver comparison: returns true if remote > local
function isNewerVersion(remote, local) {
  var r = remote.split('.').map(Number);
  var l = local.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

function showUpdateBadge(version) {
  var badge = document.getElementById('updateBadge');
  badge.textContent = 'v' + version + ' 可用';
  badge.style.display = 'inline-block';
}

// ── Install script generator ──────────────────────────────────────────────────

// Generate a self-contained install script with the extension ID baked in,
// download it, then show the user a one-liner to run in Terminal.
function downloadInstallScript() {
  var extId = chrome.runtime.id;

  // The Python native messaging host script, embedded inline.
  // Handles ping, pick_folder (macOS osascript), and write_file actions.
  var pythonScript = [
    '#!/usr/bin/env python3',
    '"""Native messaging host for btl extension."""',
    'import json, os, struct, subprocess, sys',
    '',
    'def read_msg():',
    '    raw = sys.stdin.buffer.read(4)',
    '    if len(raw) < 4: return None',
    '    return json.loads(sys.stdin.buffer.read(struct.unpack("<I", raw)[0]))',
    '',
    'def send_msg(m):',
    '    d = json.dumps(m, ensure_ascii=False).encode("utf-8")',
    '    sys.stdout.buffer.write(struct.pack("<I", len(d)) + d)',
    '    sys.stdout.buffer.flush()',
    '',
    'def pick_folder():',
    '    try:',
    '        r = subprocess.run(["osascript", "-e",',
    '            \'POSIX path of (choose folder with prompt "选择 Markdown 保存文件夹")\'],',
    '            capture_output=True, text=True, timeout=120)',
    '        if r.returncode == 0 and r.stdout.strip():',
    '            p = r.stdout.strip().rstrip("/")',
    '            return {"success": True, "path": p, "name": os.path.basename(p)}',
    '        return {"success": False, "error": "cancelled"}',
    '    except Exception as e:',
    '        return {"success": False, "error": str(e)}',
    '',
    'def validate_path(fp):',
    '    if "\\x00" in fp: return None, "path contains null byte"',
    '    parts = fp.replace("\\\\", "/").split("/")',
    '    if ".." in parts: return None, "path contains .."',
    '    expanded = os.path.expanduser(fp)',
    '    resolved = os.path.realpath(expanded)',
    '    home = os.path.expanduser("~")',
    '    if not resolved.startswith(home + os.sep) and resolved != home:',
    '        return None, "path outside home"',
    '    return resolved, None',
    '',
    'def write_file(fp, content):',
    '    try:',
    '        resolved, err = validate_path(fp)',
    '        if err: return {"success": False, "error": err}',
    '        d = os.path.dirname(resolved)',
    '        if d: os.makedirs(d, exist_ok=True)',
    '        base, ext = os.path.splitext(resolved)',
    '        final, c = resolved, 0',
    '        while os.path.exists(final) and c < 100:',
    '            c += 1; final = f"{base} ({c}){ext}"',
    '        with open(final, "w", encoding="utf-8") as f: f.write(content)',
    '        return {"success": True, "path": final}',
    '    except Exception as e:',
    '        return {"success": False, "error": str(e)}',
    '',
    'def main():',
    '    m = read_msg()',
    '    if not m: return',
    '    a = m.get("action", "")',
    '    if a == "ping": send_msg({"success": True, "version": "1.2.0"})',
    '    elif a == "pick_folder": send_msg(pick_folder())',
    '    elif a == "write_file":',
    '        p, c = m.get("path", ""), m.get("content", "")',
    '        send_msg(write_file(p, c) if p else {"success": False, "error": "no path"})',
    '    else: send_msg({"success": False, "error": f"unknown: {a}"})',
    '',
    'if __name__ == "__main__": main()',
  ].join('\n');

  // Self-contained bash install script
  var script = '#!/bin/bash\n'
    + '# One-click installer for btl Native Helper\n'
    + '# Extension ID: ' + extId + '\n'
    + 'set -e\n'
    + '\n'
    + 'INSTALL_DIR="$HOME/.btl-native-host"\n'
    + 'HOST_NAME="com.btl.file_writer"\n'
    + 'EXT_ID="' + extId + '"\n'
    + '\n'
    + 'echo "Installing Native Helper..."\n'
    + 'mkdir -p "$INSTALL_DIR"\n'
    + '\n'
    + "cat > \"$INSTALL_DIR/btl_file_writer.py\" << 'PYTHON_EOF'\n"
    + pythonScript + '\n'
    + 'PYTHON_EOF\n'
    + '\n'
    + 'chmod +x "$INSTALL_DIR/btl_file_writer.py"\n'
    + '\n'
    + 'BROWSER_DIRS=(\n'
    + '  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"\n'
    + '  "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"\n'
    + '  "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"\n'
    + '  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"\n'
    + '  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"\n'
    + '  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"\n'
    + ')\n'
    + '\n'
    + 'count=0\n'
    + 'for dir in "${BROWSER_DIRS[@]}"; do\n'
    + '  parent="$(dirname "$dir")"\n'
    + '  if [ -d "$parent" ]; then\n'
    + '    mkdir -p "$dir"\n'
    + '    cat > "$dir/$HOST_NAME.json" << MANIFEST_EOF\n'
    + '{\n'
    + '  "name": "$HOST_NAME",\n'
    + '  "description": "File writer for BTL extension",\n'
    + '  "path": "$INSTALL_DIR/btl_file_writer.py",\n'
    + '  "type": "stdio",\n'
    + '  "allowed_origins": ["chrome-extension://$EXT_ID/"]\n'
    + '}\n'
    + 'MANIFEST_EOF\n'
    + '    echo "  Installed: $dir"\n'
    + '    count=$((count + 1))\n'
    + '  fi\n'
    + 'done\n'
    + '\n'
    + 'if [ "$count" -eq 0 ]; then\n'
    + '  echo "No browser detected."; exit 1\n'
    + 'fi\n'
    + '\n'
    + 'echo ""\n'
    + 'echo "Done! Please restart your browser."\n';

  var dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(script);
  chrome.downloads.download({
    url: dataUrl,
    filename: 'install-btl-native.sh',
    saveAs: false,
    conflictAction: 'overwrite',
  });

  // Show the run instruction
  document.getElementById('nativeSetupStep2').style.display = 'block';
}

// ── History functions ─────────────────────────────────────────────────────────

async function loadHistory() {
  var result = await chrome.storage.local.get({ history: [] });
  var history = result.history;

  var listEl = document.getElementById('historyList');
  var emptyEl = document.getElementById('historyEmpty');
  var clearBtn = document.getElementById('clearHistoryBtn');

  listEl.textContent = '';

  if (history.length === 0) {
    emptyEl.style.display = 'block';
    clearBtn.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  clearBtn.style.display = 'block';

  // Build all history items in a DocumentFragment for a single DOM reflow
  var fragment = document.createDocumentFragment();

  history.forEach(function (entry) {
    var item = document.createElement('div');
    item.className = 'history-item';

    var header = document.createElement('div');
    header.className = 'history-item-header';

    var authorSpan = document.createElement('span');
    authorSpan.className = 'history-author';
    authorSpan.textContent = entry.author || 'Unknown';

    var timeSpan = document.createElement('span');
    timeSpan.className = 'history-time';
    timeSpan.textContent = formatRelativeTime(entry.timestamp);

    header.appendChild(authorSpan);
    header.appendChild(timeSpan);

    var preview = document.createElement('div');
    preview.className = 'history-preview';
    preview.textContent = entry.tweetPreview || '';

    item.appendChild(header);
    item.appendChild(preview);

    var actions = document.createElement('div');
    actions.className = 'history-actions';

    if (entry.tweetUrl) {
      var link = document.createElement('a');
      link.href = entry.tweetUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'history-link';
      link.textContent = '查看原帖 \u2197';
      actions.appendChild(link);
    }

    // Only show TLDR expand/collapse when there is TLDR content
    if (entry.tldr) {
      var tldrWrap = document.createElement('div');
      tldrWrap.className = 'history-tldr collapsed';

      var tldrContent = document.createElement('div');
      tldrContent.className = 'history-tldr-text';
      tldrContent.textContent = entry.tldr;
      tldrWrap.appendChild(tldrContent);

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'history-toggle';
      toggleBtn.textContent = '展开摘要';
      toggleBtn.addEventListener('click', function () {
        var isCollapsed = tldrWrap.classList.contains('collapsed');
        if (isCollapsed) {
          tldrWrap.classList.remove('collapsed');
          toggleBtn.textContent = '收起摘要';
        } else {
          tldrWrap.classList.add('collapsed');
          toggleBtn.textContent = '展开摘要';
        }
      });

      item.appendChild(tldrWrap);
      actions.appendChild(toggleBtn);
    }

    item.appendChild(actions);
    fragment.appendChild(item);
  });

  listEl.appendChild(fragment);
}

// Two-click confirmation: first click shows "确定清空？", second click actually clears.
// confirm() is blocked in Chrome extension popups, so we use inline confirmation instead.
var clearHistoryPending = false;
var clearHistoryTimer = null;

function clearHistory() {
  var btn = document.getElementById('clearHistoryBtn');

  if (!clearHistoryPending) {
    // First click — ask for confirmation
    clearHistoryPending = true;
    btn.textContent = '确定清空？再次点击确认';
    btn.classList.add('confirming');
    // Reset after 3 seconds if user doesn't confirm
    clearHistoryTimer = setTimeout(function () {
      clearHistoryPending = false;
      btn.textContent = '清空历史记录';
      btn.classList.remove('confirming');
    }, 3000);
    return;
  }

  // Second click — actually clear
  clearTimeout(clearHistoryTimer);
  clearHistoryPending = false;
  btn.textContent = '清空历史记录';
  btn.classList.remove('confirming');
  chrome.storage.local.set({ history: [] }).then(function () {
    loadHistory();
  });
}

// ── Relative time formatting ─────────────────────────────────────────────────

function formatRelativeTime(timestamp) {
  var now = Date.now();
  var diff = now - timestamp;
  var seconds = Math.floor(diff / 1000);
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (hours < 24) return hours + ' 小时前';
  if (days < 30) return days + ' 天前';

  var d = new Date(timestamp);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
