// Popup script – manages extension settings and browsing history
// API key is encrypted via AES-GCM before storing in chrome.storage.local.
// Uses safe DOM methods (createElement / textContent) throughout.

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  claude: 'claude-sonnet-4-20250514',
  kimi: 'moonshot-v1-8k',
};

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  migrateAndLoadSettings();
  setupTabs();
  document.getElementById('provider').addEventListener('change', (e) => updateModelHint(e.target.value));
  document.getElementById('toggleKey').addEventListener('click', toggleKeyVisibility);
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('clearHistoryBtn').addEventListener('click', clearHistory);
});

// ── API Key encryption (AES-GCM via Web Crypto API) ─────────────────────────

async function getOrCreateEncryptionKey() {
  var stored = await chrome.storage.local.get('encKey');
  if (stored.encKey) {
    return await crypto.subtle.importKey(
      'raw', new Uint8Array(stored.encKey), 'AES-GCM', false, ['encrypt', 'decrypt']
    );
  }
  // First run — generate a new 256-bit key, store raw bytes locally (never synced)
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
// On first load after the security update, move any existing plaintext API key
// from chrome.storage.sync → encrypted in chrome.storage.local, then delete it
// from sync so it's no longer synced to Google.

async function migrateAndLoadSettings() {
  var syncData = await chrome.storage.sync.get({
    provider: 'openai',
    apiKey: '',
    language: 'zh-CN',
    model: '',
    baseUrl: '',
    autoDownloadMd: true,
  });

  // If a plaintext key exists in sync, migrate it
  if (syncData.apiKey) {
    var encrypted = await encryptApiKey(syncData.apiKey);
    await chrome.storage.local.set({ encryptedApiKey: encrypted });
    // Remove plaintext key from sync storage
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
  document.getElementById('model').value = syncData.model;
  document.getElementById('baseUrl').value = syncData.baseUrl || '';
  document.getElementById('autoDownloadMd').checked = syncData.autoDownloadMd;
  updateModelHint(syncData.provider);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function setupTabs() {
  var tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-tab');

      // Deactivate all tabs and panels
      tabBtns.forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });

      // Activate selected
      btn.classList.add('active');
      document.getElementById('tab-' + target).classList.add('active');

      // Load history when switching to history tab
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

    if (!apiKeyPlain) {
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
    var encrypted = await encryptApiKey(apiKeyPlain);
    await chrome.storage.local.set({ encryptedApiKey: encrypted });

    // Store non-sensitive settings in sync storage
    await chrome.storage.sync.set({
      provider: document.getElementById('provider').value,
      language: document.getElementById('language').value,
      model: document.getElementById('model').value.trim(),
      baseUrl: baseUrl,
      autoDownloadMd: document.getElementById('autoDownloadMd').checked,
    });

    // Save should succeed even when permission is not granted yet.
    // Permission is requested afterwards so values never get lost.
    if (baseUrl) {
      var permissionResult = await ensureOriginPermission(toOriginPattern(baseUrl));
      if (!permissionResult.granted) {
        showStatus('设置已保存，请授权 Base URL 域名访问权限', 'success');
        return;
      }
    }

    showStatus('\u8BBE\u7F6E\u5DF2\u4FDD\u5B58', 'success');
  } catch (_) {
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
    return url.origin + (path === '/' ? '' : path);
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
      if (chrome.runtime.lastError) {
        resolve({ granted: false });
        return;
      }

      if (hasPermission) {
        resolve({ granted: true });
        return;
      }

      chrome.permissions.request({ origins: [originPattern] }, function (granted) {
        if (chrome.runtime.lastError) {
          resolve({ granted: false });
          return;
        }
        resolve({ granted: !!granted });
      });
    });
  });
}

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = 'status ' + type;
  setTimeout(() => {
    el.textContent = '';
    el.className = 'status';
  }, 2000);
}

// ── History functions ─────────────────────────────────────────────────────────

async function loadHistory() {
  var result = await chrome.storage.local.get({ history: [] });
  var history = result.history;

  var listEl = document.getElementById('historyList');
  var emptyEl = document.getElementById('historyEmpty');
  var clearBtn = document.getElementById('clearHistoryBtn');

  // Clear previous entries
  listEl.textContent = '';

  if (history.length === 0) {
    emptyEl.style.display = 'block';
    clearBtn.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  clearBtn.style.display = 'block';

  history.forEach(function (entry) {
    var item = document.createElement('div');
    item.className = 'history-item';

    // Header row: author + time
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

    // Preview text (always visible)
    var preview = document.createElement('div');
    preview.className = 'history-preview';
    preview.textContent = entry.tweetPreview || '';

    // TLDR content (collapsed by default)
    var tldrWrap = document.createElement('div');
    tldrWrap.className = 'history-tldr collapsed';

    var tldrContent = document.createElement('div');
    tldrContent.className = 'history-tldr-text';
    tldrContent.textContent = entry.tldr || '';
    tldrWrap.appendChild(tldrContent);

    // Toggle button
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

    // Original tweet link
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

    actions.appendChild(toggleBtn);

    item.appendChild(header);
    item.appendChild(preview);
    item.appendChild(tldrWrap);
    item.appendChild(actions);
    listEl.appendChild(item);
  });
}

async function clearHistory() {
  if (!confirm('确定要清空所有历史记录吗？')) return;

  await chrome.storage.local.set({ history: [] });
  loadHistory();
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

  // Fall back to date string for older entries
  var d = new Date(timestamp);
  return (d.getMonth() + 1) + '/' + d.getDate();
}
