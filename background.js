// Background service worker
// Handles TLDR generation: fetches full article / quoted-tweet content when
// needed, then calls the user's chosen LLM API.
// Also saves each successful TLDR to history and optionally downloads Markdown.
//
// Markdown saving strategy:
//   1. Primary: Native messaging host (writes to any user-chosen folder)
//   2. Fallback: chrome.downloads.download() to the Downloads folder

const MAX_HISTORY = 200;
const NATIVE_HOST_NAME = 'com.btl.file_writer';

// Allowed hostnames for background tab fetching (security whitelist)
const ALLOWED_FETCH_HOSTS = ['x.com', 'twitter.com', 'mobile.twitter.com'];
const PROVIDER_DEFAULT_ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  kimi: 'https://api.moonshot.cn/v1/chat/completions',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_TLDR') {
    handleTLDRRequest(message.tweetData, message.articleUrl, message.quotedTweetUrl)
      .then(async (result) => {
        // Save to history (non-blocking)
        saveToHistory(message.tweetData, result.tldr, result.isArticle);

        // Download markdown only if user has enabled it
        var prefs = await chrome.storage.sync.get({ autoDownloadMd: true });
        if (prefs.autoDownloadMd) {
          var senderTabId = sender && sender.tab ? sender.tab.id : null;
          saveMarkdownFile(message.tweetData, result.tldr, result.articleContent, result.quotedFullContent, result.isArticle, result.mode, senderTabId);
        }

        sendResponse({ success: true, tldr: result.tldr, mode: result.mode });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Native folder picker — opens a macOS folder dialog via the native host.
  // The popup fires this and does NOT wait for the response (fire-and-forget),
  // so the popup stays interactive while the Finder dialog is open.
  // Background saves the result to sync storage; popup listens via onChanged.
  if (message.type === 'PICK_NATIVE_FOLDER') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'pick_folder' })
      .then(async function (result) {
        if (result && result.success) {
          await chrome.storage.sync.set({
            mdFolderPath: result.path,
            mdFolderName: result.name,
          });
        }
        sendResponse(result);
      })
      .catch(function (err) {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // Ping native host to check if it's installed
  if (message.type === 'PING_NATIVE_HOST') {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action: 'ping' })
      .then(function (result) { sendResponse(result); })
      .catch(function () { sendResponse({ success: false }); });
    return true;
  }
});

// ── History persistence ──────────────────────────────────────────────────────

async function saveToHistory(tweetData, tldr, isArticle) {
  try {
    var result = await chrome.storage.local.get({ history: [] });
    var history = result.history;

    // Build a short preview from the original tweet text (first 120 chars)
    var previewSource = tweetData.text || tweetData.cardText
      || tweetData.quotedText || tweetData.fallbackText || '';
    var tweetPreview = previewSource.slice(0, 120);
    if (previewSource.length > 120) tweetPreview += '...';

    var entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      author: tweetData.author || '',
      tweetUrl: tweetData.tweetUrl || tweetData.url || '',
      tweetPreview: tweetPreview,
      tldr: tldr,
      isArticle: isArticle,
    };

    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
      history = history.slice(0, MAX_HISTORY);
    }

    await chrome.storage.local.set({ history: history });
  } catch (_) {
    // History save failure is non-critical — silently ignore
  }
}

// ── Markdown file saving (native host + chrome.downloads fallback) ───────────

async function saveMarkdownFile(tweetData, tldr, articleContent, quotedFullContent, isArticle, mode, senderTabId) {
  try {
    var markdown = buildMarkdownContent(tweetData, tldr, articleContent, quotedFullContent, isArticle, mode);
    var fileName = buildFileName(tweetData, articleContent, isArticle);

    // 1. Primary: native messaging host (writes to any user-chosen folder)
    var written = await writeViaNativeHost(markdown, fileName);
    if (written) return;

    // 2. Fallback: content-script download via <a download> tag.
    //    More reliable than chrome.downloads for filename handling on Windows,
    //    where chrome.downloads ignores the filename parameter for data/blob URLs.
    if (senderTabId) {
      var csWritten = await writeViaContentScript(senderTabId, markdown, fileName);
      if (csWritten) return;
    }

    // 3. Last resort: chrome.downloads API (filename may be incorrect on Windows)
    await writeViaDownloads(markdown, fileName);
  } catch (err) {
    console.log('[background] saveMarkdownFile error:', err.message);
    // Log save failure for debug info display in popup
    chrome.storage.local.set({
      lastSave: { timestamp: Date.now(), success: false, error: err.message },
    });
  }
}

// Write markdown via the native messaging host.
// Reads the user's chosen folder path from sync storage and sends the
// file content to the Python host for writing.
// Returns true on success, false if the host is not installed or write fails.
async function writeViaNativeHost(markdown, fileName) {
  try {
    var syncData = await chrome.storage.sync.get({ mdFolderPath: '' });
    if (!syncData.mdFolderPath) return false;

    var fullPath = syncData.mdFolderPath + '/' + fileName;
    var response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
      action: 'write_file',
      path: fullPath,
      content: markdown,
    });
    if (response && response.success) {
      chrome.storage.local.set({
        lastSave: { timestamp: Date.now(), success: true, path: response.path, method: 'native' },
      });
      return true;
    }
    console.log('[background] Native host write returned error:', response && response.error);
    return false;
  } catch (err) {
    console.log('[background] Native host write failed:', err.message);
    return false;
  }
}

// Download via content script: send markdown to the active tab where it creates
// a Blob and triggers download using an <a download="filename.md"> tag.
// The HTML download attribute reliably sets filenames across all platforms,
// unlike chrome.downloads which ignores the filename param on Windows.
async function writeViaContentScript(tabId, markdown, fileName) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SAVE_MARKDOWN',
      markdown: markdown,
      fileName: fileName,
    });
    chrome.storage.local.set({
      lastSave: { timestamp: Date.now(), success: true, path: 'Downloads/' + fileName, method: 'content-script' },
    });
    return true;
  } catch (err) {
    console.log('[background] Content script download failed:', err.message);
    return false;
  }
}

// Last resort: save via chrome.downloads to the Downloads/bookmark-is-learned/ subfolder.
// Tracks actual download completion before logging success.
//
// Uses Blob URL instead of data URL because Windows Chrome ignores the
// `filename` parameter for data: URL downloads, producing generic names
// like "下载.txt" instead of the specified filename with .md extension.
async function writeViaDownloads(markdown, fileName) {
  var fullPath = 'bookmark-is-learned/' + fileName;

  // Prefer Blob URL — works in service workers since Chrome 116+ and
  // ensures the filename parameter is respected on all platforms.
  // Fall back to data URL for older Chrome versions.
  var downloadUrl;
  var blobUrl = null;
  try {
    var blob = new Blob([markdown], { type: 'text/plain' });
    blobUrl = URL.createObjectURL(blob);
    downloadUrl = blobUrl;
  } catch (_) {
    downloadUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(markdown);
  }

  var downloadId = await chrome.downloads.download({
    url: downloadUrl,
    filename: fullPath,
    saveAs: false,
    conflictAction: 'uniquify',
  });

  // Wait for actual download completion before logging result
  return new Promise(function (resolve) {
    function cleanupBlob() {
      if (blobUrl) {
        // Small delay so Chrome finishes reading the blob before we revoke it
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 5000);
      }
    }
    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        cleanupBlob();
        chrome.storage.local.set({
          lastSave: { timestamp: Date.now(), success: true, path: 'Downloads/' + fullPath, method: 'downloads' },
        });
        resolve();
      } else if (delta.state && delta.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        cleanupBlob();
        chrome.storage.local.set({
          lastSave: { timestamp: Date.now(), success: false, error: 'download interrupted', method: 'downloads' },
        });
        resolve();
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
    // Safety timeout: resolve after 30s even if no state change fires
    setTimeout(function () { chrome.downloads.onChanged.removeListener(onChanged); cleanupBlob(); resolve(); }, 30000);
  });
}

// Strip metadata prefix from article body that duplicates the markdown header.
// X Article pages render title, author info, date, and engagement counts
// before the actual content — these are already shown in the markdown header.
function stripArticleMetadataPrefix(body, title, author) {
  var lines = body.split('\n');
  var cleanAuthor = (author || '').split('\n')[0].trim();
  var cleanTitle = (title || '').trim();
  var i = 0;
  var maxScan = Math.min(lines.length, 25);

  while (i < maxScan) {
    var line = lines[i].trim();
    if (!line) { i++; continue; }
    // Skip article title (already shown as ### heading)
    if (cleanTitle && line === cleanTitle) { i++; continue; }
    // Skip author name (already in metadata block)
    if (cleanAuthor && line === cleanAuthor) { i++; continue; }
    // Skip @handle
    if (/^@\w+$/.test(line)) { i++; continue; }
    // Skip dot separators
    if (line === '·') { i++; continue; }
    // Skip date patterns (Chinese: X月X日, English: D Mon YYYY)
    if (/^\d{1,2}月\d{1,2}日$/.test(line)) { i++; continue; }
    if (/^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(line)) { i++; continue; }
    // Skip follow/edit button text
    if (/^(Follow|回关|关注|Edited)$/i.test(line)) { i++; continue; }
    // Skip engagement numbers (e.g. 27, 270, 31万, 302K)
    if (/^[\d,.]+[万亿KkMm]?$/.test(line)) { i++; continue; }
    // Non-metadata line — stop stripping
    break;
  }

  return lines.slice(i).join('\n').trim();
}

// Escape special characters in URLs to prevent markdown link injection.
// Parentheses inside a URL would break the [text](url) syntax, and
// square brackets in the display text would break the link label.
function escapeMarkdownLinkUrl(url) {
  return url.replace(/[()]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function escapeMarkdownLinkText(text) {
  return text.replace(/[[\]]/g, '\\$&');
}

// Build the markdown content string from tweet data and TLDR result
function buildMarkdownContent(tweetData, tldr, articleContent, quotedFullContent, isArticle, mode) {
  var author = tweetData.author || 'unknown';
  var tweetUrl = tweetData.tweetUrl || tweetData.url || '';
  var now = new Date();
  var dateStr = now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0') + ' '
    + String(now.getHours()).padStart(2, '0') + ':'
    + String(now.getMinutes()).padStart(2, '0');

  var lines = [];

  // Title
  var title = isArticle && articleContent && articleContent.title
    ? articleContent.title
    : author;
  lines.push('# ' + title);
  lines.push('');

  // Metadata block
  lines.push('> **Author**: ' + author);
  lines.push('> **Source**: ' + tweetUrl);
  lines.push('> **Date**: ' + dateStr);

  // Engagement metrics (if available)
  var metrics = tweetData.metrics;
  if (metrics) {
    lines.push('> **Replies**: ' + (metrics.replies || '0')
      + ' · **Retweets**: ' + (metrics.retweets || '0')
      + ' · **Likes**: ' + (metrics.likes || '0')
      + ' · **Views**: ' + (metrics.views || '0'));
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  // TLDR section (skip in raw mode when AI is disabled)
  if (mode !== 'raw') {
    lines.push('## TLDR');
    lines.push('');
    lines.push(tldr);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Original content section (included in original and raw modes)
  if (mode === 'original' || mode === 'raw') {
    lines.push('## Original Content');
    lines.push('');

    if (isArticle && articleContent) {
      var cleanBody = stripArticleMetadataPrefix(articleContent.body, articleContent.title, author);
      if (articleContent.title) {
        lines.push('### ' + articleContent.title);
        lines.push('');
      }
      lines.push(cleanBody);
    } else if (tweetData.text) {
      lines.push(tweetData.text);
    } else if (tweetData.cardText) {
      lines.push(tweetData.cardText);
    } else if (tweetData.fallbackText) {
      // fallbackText from X Articles may also contain metadata prefix
      lines.push(stripArticleMetadataPrefix(tweetData.fallbackText, '', author));
    }
    lines.push('');

    // Quoted content (if present)
    var quotedBody = quotedFullContent && quotedFullContent.body
      ? quotedFullContent.body
      : (tweetData.quotedText || '');
    if (quotedBody) {
      var quotedBy = tweetData.quotedAuthor || 'unknown';
      lines.push('### Quoted Content (by ' + quotedBy + ')');
      lines.push('');
      lines.push(quotedBody);
      lines.push('');
    }

    // Card text (if separate from main text)
    if (!isArticle && tweetData.text && tweetData.cardText) {
      lines.push('### Attached Card');
      lines.push('');
      lines.push(tweetData.cardText);
      lines.push('');
    }

    if (tweetData.referencedUrls && tweetData.referencedUrls.length > 0) {
      lines.push('### Referenced Links');
      lines.push('');
      for (var i = 0; i < tweetData.referencedUrls.length; i++) {
        var linkUrl = tweetData.referencedUrls[i];
        lines.push('- [' + escapeMarkdownLinkText(linkUrl) + '](' + escapeMarkdownLinkUrl(linkUrl) + ')');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// Build a sanitized filename like "handle-title-20260211-143022.md"
// Format: x-account handle, title (article title or tweet excerpt), timestamp
function buildFileName(tweetData, articleContent, isArticle) {
  // Extract X handle from tweet URL (e.g., "https://x.com/elonmusk/status/123")
  var handle = 'unknown';
  var tweetUrl = tweetData.tweetUrl || tweetData.url || '';
  try {
    var pathname = new URL(tweetUrl).pathname;
    var firstSegment = pathname.split('/')[1];
    if (firstSegment) handle = firstSegment;
  } catch (_) { /* use default */ }

  // Derive a short title from article title or tweet text
  var title = '';
  if (isArticle && articleContent && articleContent.title) {
    title = articleContent.title;
  } else {
    title = tweetData.text || tweetData.cardText || tweetData.fallbackText || '';
  }

  // Sanitize handle and title for use in filenames:
  // - Remove control characters (U+0000–U+001F, U+007F) and null bytes
  // - Replace filesystem-unsafe characters
  // - Strip leading dots to prevent hidden files
  var safeHandle = handle
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim().slice(0, 30);
  var safeTitle = title
    .replace(/[\n\r]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 50);
  // Remove trailing incomplete words if title was truncated
  if (title.length > 50) {
    var lastSpace = safeTitle.lastIndexOf(' ');
    if (lastSpace > 20) safeTitle = safeTitle.slice(0, lastSpace);
  }
  if (!safeTitle) safeTitle = 'untitled';

  var now = new Date();
  var timeStamp = now.getFullYear()
    + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0')
    + '-' + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0')
    + String(now.getSeconds()).padStart(2, '0');
  return safeHandle + '-' + safeTitle + '-' + timeStamp + '.md';
}

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

async function decryptApiKey(encrypted) {
  var key = await getOrCreateEncryptionKey();
  var decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(encrypted.iv) },
    key,
    new Uint8Array(encrypted.data)
  );
  return new TextDecoder().decode(decrypted);
}

// ── URL whitelist for background tab fetching ────────────────────────────────

function isAllowedFetchUrl(url) {
  try {
    var parsed = new URL(url);
    return ALLOWED_FETCH_HOSTS.includes(parsed.hostname);
  } catch (_) {
    return false;
  }
}

// ── Main handler ────────────────────────────────────────────────────────────────

async function handleTLDRRequest(tweetData, articleUrl, quotedTweetUrl) {
  const settings = await chrome.storage.sync.get({
    provider: 'openai',
    language: 'zh-CN',
    model: '',
    baseUrl: '',
    mdMode: 'tldr',
    aiEnabled: true,
  });

  // Fetch full article content if an article URL was detected
  let articleContent = null;
  if (articleUrl) {
    articleContent = await fetchPageContent(articleUrl);
  }

  // Fetch full quoted tweet / thread content if:
  //   - a quoted-tweet URL was detected, AND
  //   - the inline preview text is short (< 500 chars) — meaning likely truncated
  let quotedFullContent = null;
  if (quotedTweetUrl) {
    const inlineLen = (tweetData.quotedText || '').length;
    if (inlineLen < 500) {
      quotedFullContent = await fetchPageContent(quotedTweetUrl);
    }
  }

  const isArticle = !!(articleContent && articleContent.body);

  // If AI is disabled, skip LLM call — return raw content for markdown-only saving
  if (!settings.aiEnabled) {
    return { tldr: '', articleContent, quotedFullContent, isArticle, mode: 'raw' };
  }

  // Generate TLDR via LLM — both modes show it in the popup card,
  // and original mode also includes it in the saved markdown.
  // Read encrypted API key from local storage (skipped for local-claude provider)
  var apiKey;
  if (settings.provider !== 'local-claude') {
    var localData = await chrome.storage.local.get('encryptedApiKey');
    if (!localData.encryptedApiKey) {
      throw new Error('请先在插件设置中填写 API Key');
    }
    try {
      apiKey = await decryptApiKey(localData.encryptedApiKey);
    } catch (_) {
      throw new Error('API Key 解密失败，请重新保存 API Key');
    }
    if (!apiKey) {
      throw new Error('请先在插件设置中填写 API Key');
    }
  }

  const hasQuotedFull = !!(quotedFullContent && quotedFullContent.body);
  const prompt = buildPrompt(tweetData, articleContent, quotedFullContent, settings.language, isArticle, hasQuotedFull);
  const maxTokens = (isArticle || hasQuotedFull) ? 2000 : 1000;
  const endpoint = await resolveApiEndpoint(settings.provider, settings.baseUrl);

  let tldr;
  switch (settings.provider) {
    case 'openai':
      tldr = await callOpenAICompatible(apiKey, endpoint, settings.model || 'gpt-4o-mini', prompt, maxTokens, 'OpenAI');
      break;
    case 'claude':
      tldr = await callClaude(apiKey, endpoint, settings.model || 'claude-sonnet-4-20250514', prompt, maxTokens);
      break;
    case 'kimi':
      tldr = await callOpenAICompatible(apiKey, endpoint, settings.model || 'moonshot-v1-8k', prompt, maxTokens, 'Kimi');
      break;
    case 'zhipu':
      tldr = await callOpenAICompatible(apiKey, endpoint, settings.model || 'glm-4-flash', prompt, maxTokens, '智谱');
      break;
    case 'local-claude':
      tldr = await callLocalClaude(prompt);
      break;
    default:
      throw new Error('不支持的模型: ' + settings.provider);
  }

  return { tldr, articleContent, quotedFullContent, isArticle, mode: settings.mdMode };
}

async function resolveApiEndpoint(provider, baseUrl) {
  if (!baseUrl) return PROVIDER_DEFAULT_ENDPOINTS[provider];

  var parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (_) {
    throw new Error('Base URL 格式无效，请在设置中重新填写');
  }

  await ensureBaseUrlPermission(parsed.origin);

  var path = parsed.pathname.replace(/\/+$/, '');
  // If the path already ends with the full API route, use it as-is
  if (/\/v\d+\/(chat\/completions|messages)$/i.test(path)) {
    return parsed.origin + path;
  }

  var suffix = provider === 'claude' ? '/messages' : '/chat/completions';
  // If the path ends with a version segment (e.g. /v1, /v4), append the suffix
  if (/\/v\d+$/i.test(path)) {
    return parsed.origin + path + suffix;
  }
  if (!path || path === '/') {
    return parsed.origin + '/v1' + suffix;
  }
  return parsed.origin + path + suffix;
}

function ensureBaseUrlPermission(origin) {
  return new Promise(function (resolve, reject) {
    if (!chrome.permissions || !chrome.permissions.contains || !chrome.permissions.request) {
      resolve();
      return;
    }

    var originPattern = origin + '/*';
    chrome.permissions.contains({ origins: [originPattern] }, function (hasPermission) {
      if (chrome.runtime.lastError) {
        reject(new Error('Base URL 权限检查失败，请重新保存设置'));
        return;
      }

      if (hasPermission) {
        resolve();
        return;
      }

      reject(new Error('Base URL 缺少域名权限，请在插件设置中重新保存并授权'));
    });
  });
}

// ── Page content fetching (articles & quoted tweets) ────────────────────────────

async function fetchPageContent(pageUrl) {
  if (!isAllowedFetchUrl(pageUrl)) return null;

  // Extract the numeric ID from the URL (article ID or status ID) for
  // verification inside the background tab.  X is a SPA with aggressive
  // caching — the tab may briefly render stale content from a previous
  // page before navigating to the requested URL.  We use the ID to confirm
  // that the tab actually loaded the right page.
  var idMatch = pageUrl.match(/\/(\d{10,})(?:\/|$)/);
  var expectedId = idMatch ? idMatch[1] : '';
  var isArticleUrl = /\/(articles?)\//i.test(pageUrl);

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId, 15000);
    await sleep(4000);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
      args: [expectedId, isArticleUrl],
    });

    await chrome.tabs.remove(tabId);
    tabId = null;

    return (results && results[0] && results[0].result) || null;
  } catch (_) {
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch (__) { /* ignore */ } }
    return null;
  }
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    // Clean up if the tab is closed/crashed before load completes
    const onRemoved = (id) => {
      if (id === tabId) {
        cleanup();
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extractPageContent(expectedId, isArticleUrl) {
  return new Promise((resolve) => {
    var attempts = 0;
    var maxAttempts = 16;

    var timer = setInterval(function () {
      attempts++;

      // Guard: verify the tab actually loaded the expected page.
      // X is a SPA with aggressive caching — the tab may briefly show
      // stale content from a previous page before the router navigates
      // to the requested URL.  If the URL doesn't contain the expected
      // numeric ID, skip this poll cycle and wait for navigation.
      if (expectedId && window.location.href.indexOf(expectedId) === -1) {
        if (attempts < maxAttempts) return; // keep waiting
        // Gave up — return null instead of grabbing wrong content
        clearInterval(timer);
        resolve(null);
        return;
      }

      // 1. Article-specific selectors (highest confidence — exact testid match)
      var articleSelectors = [
        '[data-testid="noteBody"]',
        '[data-testid="richTextContainer"]',
        '[data-testid="articleBody"]',
        '[data-testid="article-content"]',
      ];
      for (var i = 0; i < articleSelectors.length; i++) {
        var el = document.querySelector(articleSelectors[i]);
        if (el && el.innerText.trim().length > 100) {
          clearInterval(timer);
          var h1 = document.querySelector('h1');
          resolve({
            title: h1 ? h1.innerText : document.title,
            body: el.innerText.trim().slice(0, 15000),
          });
          return;
        }
      }

      // 2. Thread detection — only for tweet/status URLs, NOT article URLs.
      //    On article URLs, X may render cached/recommended tweets before the
      //    article content loads.  Grabbing those tweets would return wrong content.
      if (!isArticleUrl) {
        var articles = document.querySelectorAll('article[data-testid="tweet"]');
        if (articles.length >= 1) {
          var textParts = [];
          var firstAuthor = null;
          for (var j = 0; j < articles.length && textParts.length < 10; j++) {
            var authorEl = articles[j].querySelector('[data-testid="User-Name"]');
            var authorName = authorEl ? authorEl.innerText.split('\n')[0] : '';
            if (j === 0) {
              firstAuthor = authorName;
            } else if (authorName !== firstAuthor) {
              break;
            }
            var tweetEl = articles[j].querySelector('[data-testid="tweetText"]');
            if (tweetEl && tweetEl.innerText.trim()) {
              textParts.push(tweetEl.innerText);
            }
          }
          var combined = textParts.join('\n\n');
          if (combined.length > 50) {
            clearInterval(timer);
            resolve({ title: '', body: combined.slice(0, 15000) });
            return;
          }
        }
      }

      // 3. X Article focus mode: article body rendered as plain elements with
      //    h1/h2 section headings, no special data-testid markers.
      var mainEl = document.querySelector('main');
      if (mainEl) {
        var h1List = mainEl.querySelectorAll('h1');
        if (h1List.length >= 2) {
          var bodyContainer = h1List[0].parentElement;
          if (bodyContainer && bodyContainer.innerText.trim().length > 200) {
            clearInterval(timer);
            var statusEls = bodyContainer.querySelectorAll('[role="status"]');
            for (var s = 0; s < statusEls.length; s++) statusEls[s].remove();
            var titleText = '';
            var parentEl = bodyContainer.parentElement;
            if (parentEl) {
              var child = parentEl.firstElementChild;
              while (child && child !== bodyContainer) {
                var t = child.innerText.trim();
                if (t && t.length > 5 && t.length < 200
                    && t.indexOf('@') === -1 && t.indexOf('\n') === -1) {
                  titleText = t;
                  break;
                }
                child = child.nextElementSibling;
              }
            }
            if (!titleText) titleText = document.title;
            resolve({
              title: titleText,
              body: bodyContainer.innerText.trim().slice(0, 15000),
            });
            return;
          }
        }
      }

      // 4. Final fallback after all polls exhausted
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        var contentArea = document.querySelector('[data-testid="primaryColumn"]') || mainEl;
        if (contentArea && contentArea.innerText.length > 200) {
          var heading = document.querySelector('h1');
          resolve({
            title: heading ? heading.innerText : document.title,
            body: contentArea.innerText.slice(0, 15000),
          });
        } else {
          resolve(null);
        }
      }
    }, 500);
  });
}

// ── Prompt building ─────────────────────────────────────────────────────────────

function buildPrompt(tweetData, articleContent, quotedFullContent, language, isArticle, hasQuotedFull) {
  var langMap = {
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
  };
  var langName = langMap[language] || language;

  var userContent = '';

  if (isArticle) {
    userContent = 'Article: "' + articleContent.title + '"\n'
      + 'By ' + tweetData.author + '\n\n'
      + articleContent.body;
  } else if (tweetData.text) {
    userContent = 'Tweet by ' + tweetData.author + ':\n' + tweetData.text;
  } else if (tweetData.cardText) {
    userContent = 'Post by ' + tweetData.author + ':\n' + tweetData.cardText;
  } else if (tweetData.fallbackText) {
    userContent = 'Content by ' + tweetData.author + ':\n' + tweetData.fallbackText;
  }

  if (tweetData.referencedUrls && tweetData.referencedUrls.length > 0) {
    userContent += '\n\nReferenced links:\n' + tweetData.referencedUrls.map(function (u) {
      return '- ' + u;
    }).join('\n');
  }

  if (hasQuotedFull) {
    var quotedBy = tweetData.quotedAuthor || 'another user';
    userContent += '\n\n--- Quoted / referenced post (by ' + quotedBy + ') ---\n' + quotedFullContent.body;
  } else if (tweetData.quotedText) {
    var qAuthor = tweetData.quotedAuthor || 'another user';
    userContent += '\n\nQuoted tweet (by ' + qAuthor + '):\n' + tweetData.quotedText;
  }

  if (!isArticle && tweetData.text && tweetData.cardText) {
    userContent += '\n\nAttached card:\n' + tweetData.cardText;
  }

  var factCheckBlock = '\n\n'
    + '--- FACT CHECK (MANDATORY) ---\n'
    + 'At the very end, add a fact-check section with this exact format:\n\n'
    + '**Fact Check**\n'
    + '- Identify the key factual claims in the content.\n'
    + '- For each claim, briefly note whether it is **verifiable**, **partially verifiable**, **opinion**, or **unverifiable**.\n'
    + '- End with an overall credibility line:\n'
    + '  Credibility: X/10 — one-sentence justification.\n'
    + '  (10 = fully verified facts with sources, 5 = mixed facts and opinions, 1 = misleading or fabricated)\n';

  var systemPrompt;

  if (isArticle) {
    systemPrompt = 'You are an expert content analyst. The user bookmarked an X Article (long-form post). '
      + 'Provide a thorough, high-value summary in ' + langName + '.\n\n'
      + 'Format:\n'
      + '**TLDR** — one sentence capturing the core thesis.\n\n'
      + '**Key Value Points**\n'
      + '- Extract 5-8 of the most valuable insights, actionable advice, data points, or frameworks from the article.\n'
      + '- Each point should be self-contained and useful even without reading the original.\n'
      + '- Use **bold** for key terms, names, numbers, and takeaways.\n\n'
      + '**Process / Steps** (only if the article is a tutorial, how-to, or guide)\n'
      + '- List the step-by-step process or methodology described in the article.\n'
      + '- Number each step and include specifics (tools, parameters, commands, etc.).\n'
      + '- Skip this section entirely if the content is not instructional.\n\n'
      + '**Why It Matters** — 1-2 sentences on the broader significance or who should care.\n'
      + factCheckBlock;
  } else if (hasQuotedFull) {
    systemPrompt = 'You are an expert content analyst. The user bookmarked a tweet that quotes/references a longer post. '
      + 'Provide a thorough summary of BOTH the tweet and the full quoted content in ' + langName + '.\n\n'
      + 'Format:\n'
      + '**TLDR** — one sentence on the overall message.\n\n'
      + '**Quoted Content Summary**\n'
      + '- Extract 5-8 key insights, value points, or actionable takeaways from the quoted long post.\n'
      + '- Use **bold** for important terms and data.\n\n'
      + '**Process / Steps** (only if the quoted post is a tutorial, how-to, or guide)\n'
      + '- List the step-by-step process described.\n'
      + '- Skip this section if the content is not instructional.\n\n'
      + '**Commenter\'s Take** — what did the bookmarked user add? Agreement, disagreement, extra context?\n'
      + factCheckBlock;
  } else {
    systemPrompt = 'You are an expert content analyst. The user bookmarked a tweet. '
      + 'Provide a valuable summary in ' + langName + '.\n\n'
      + 'Format:\n'
      + '**TLDR** — one sentence summary.\n\n'
      + '**Key Points**\n'
      + '- Extract 2-5 insights, claims, or actionable takeaways.\n'
      + '- For substantial content (threads, long tweets), extract more points with specific details.\n'
      + '- Use **bold** for key terms.\n\n'
      + '**Process / Steps** (only if the tweet describes a tutorial, method, or workflow)\n'
      + '- List numbered steps with specifics. Skip if not applicable.\n'
      + factCheckBlock;
  }

  return { system: systemPrompt, user: userContent };
}

// ── LLM API calls ───────────────────────────────────────────────────────────────

// Shared caller for OpenAI-compatible APIs (OpenAI, Kimi, Zhipu all use the
// same request/response format: messages array, choices[0].message.content).
async function callOpenAICompatible(apiKey, endpoint, model, prompt, maxTokens, providerLabel) {
  var res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    var err = await res.json().catch(function () { return {}; });
    throw new Error((err.error && err.error.message) || providerLabel + ' API error: ' + res.status);
  }
  var data = await res.json();
  if (!data.choices || !data.choices[0] || !data.choices[0].message) {
    throw new Error(providerLabel + ' API returned unexpected response format');
  }
  return data.choices[0].message.content;
}

// Claude uses a different request/response format (Anthropic Messages API):
// system prompt is a top-level field, response is in content[0].text.
async function callClaude(apiKey, endpoint, model, prompt, maxTokens) {
  var res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }),
  });
  if (!res.ok) {
    var err = await res.json().catch(function () { return {}; });
    throw new Error((err.error && err.error.message) || 'Claude API error: ' + res.status);
  }
  var data = await res.json();
  if (!data.content || !data.content[0]) {
    throw new Error('Claude API returned unexpected response format');
  }
  return data.content[0].text;
}

async function callLocalClaude(prompt) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendNativeMessage('com.btl.file_writer', {
      action: 'call_claude',
      system: prompt.system,
      user: prompt.user,
    }, function (response) {
      if (chrome.runtime.lastError) {
        reject(new Error('本地 Claude 未安装，请先在「高级设置」中下载并运行安装脚本：' + chrome.runtime.lastError.message));
        return;
      }
      if (!response || !response.success) {
        reject(new Error(response && response.error ? response.error : '本地 Claude 调用失败'));
        return;
      }
      resolve(response.text);
    });
  });
}
