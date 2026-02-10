// Background service worker
// Handles TLDR generation: fetches full article / quoted-tweet content when
// needed, then calls the user's chosen LLM API.
// Also saves each successful TLDR to history and optionally downloads Markdown.

const MAX_HISTORY = 200;

// Allowed hostnames for background tab fetching (security whitelist)
const ALLOWED_FETCH_HOSTS = ['x.com', 'twitter.com', 'mobile.twitter.com'];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_TLDR') {
    handleTLDRRequest(message.tweetData, message.articleUrl, message.quotedTweetUrl)
      .then(async (result) => {
        // Save to history (non-blocking)
        saveToHistory(message.tweetData, result.tldr, result.isArticle);

        // Download markdown only if user has enabled it
        var prefs = await chrome.storage.sync.get({ autoDownloadMd: true });
        if (prefs.autoDownloadMd) {
          saveMarkdownFile(message.tweetData, result.tldr, result.articleContent, result.quotedFullContent, result.isArticle);
        }

        sendResponse({ success: true, tldr: result.tldr });
      })
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true; // keep sendResponse channel open for async
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

    // Prepend newest entry, cap at MAX_HISTORY
    history.unshift(entry);
    if (history.length > MAX_HISTORY) {
      history = history.slice(0, MAX_HISTORY);
    }

    await chrome.storage.local.set({ history: history });
  } catch (_) {
    // History save failure is non-critical — silently ignore
  }
}

// ── Markdown file download ───────────────────────────────────────────────────

async function saveMarkdownFile(tweetData, tldr, articleContent, quotedFullContent, isArticle) {
  try {
    var author = tweetData.author || 'unknown';
    var tweetUrl = tweetData.tweetUrl || tweetData.url || '';
    var now = new Date();
    var dateStr = now.getFullYear() + '-'
      + String(now.getMonth() + 1).padStart(2, '0') + '-'
      + String(now.getDate()).padStart(2, '0') + ' '
      + String(now.getHours()).padStart(2, '0') + ':'
      + String(now.getMinutes()).padStart(2, '0');

    // ── Build Markdown ────────────────────────────────────────────────────

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
    lines.push('');
    lines.push('---');
    lines.push('');

    // TLDR section (at the top as requested)
    lines.push('## TLDR');
    lines.push('');
    lines.push(tldr);
    lines.push('');
    lines.push('---');
    lines.push('');

    // Original content section
    lines.push('## Original Content');
    lines.push('');

    // Main tweet / article text
    if (isArticle && articleContent) {
      if (articleContent.title) {
        lines.push('### ' + articleContent.title);
        lines.push('');
      }
      lines.push(articleContent.body);
    } else if (tweetData.text) {
      lines.push(tweetData.text);
    } else if (tweetData.cardText) {
      lines.push(tweetData.cardText);
    } else if (tweetData.fallbackText) {
      lines.push(tweetData.fallbackText);
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

    var markdown = lines.join('\n');

    // ── Download as .md file ──────────────────────────────────────────────

    // Sanitize author name for filename (remove line breaks, special chars)
    var safeAuthor = author.replace(/[\n\r]/g, ' ').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40);
    var timeStamp = now.getFullYear()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '-' + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    var filename = 'bookmark-is-learned/' + safeAuthor + '-' + timeStamp + '.md';

    var dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);
    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
  } catch (_) {
    // Markdown download failure is non-critical — silently ignore
  }
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
  });

  // Read encrypted API key from local storage
  var localData = await chrome.storage.local.get('encryptedApiKey');
  if (!localData.encryptedApiKey) {
    throw new Error('请先在插件设置中填写 API Key');
  }
  var apiKey;
  try {
    apiKey = await decryptApiKey(localData.encryptedApiKey);
  } catch (_) {
    throw new Error('API Key 解密失败，请重新保存 API Key');
  }
  if (!apiKey) {
    throw new Error('请先在插件设置中填写 API Key');
  }

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
  const hasQuotedFull = !!(quotedFullContent && quotedFullContent.body);
  const prompt = buildPrompt(tweetData, articleContent, quotedFullContent, settings.language, isArticle, hasQuotedFull);
  const maxTokens = (isArticle || hasQuotedFull) ? 2000 : 1000;

  let tldr;
  switch (settings.provider) {
    case 'openai':
      tldr = await callOpenAI(apiKey, settings.model || 'gpt-4o-mini', prompt, maxTokens);
      break;
    case 'claude':
      tldr = await callClaude(apiKey, settings.model || 'claude-sonnet-4-20250514', prompt, maxTokens);
      break;
    case 'kimi':
      tldr = await callKimi(apiKey, settings.model || 'moonshot-v1-8k', prompt, maxTokens);
      break;
    case 'zhipu':
      tldr = await callZhipu(apiKey, settings.model || 'glm-4-flash', prompt, maxTokens);
      break;
    default:
      throw new Error('不支持的模型: ' + settings.provider);
  }

  // Return full context so the caller can save markdown and history
  return { tldr, articleContent, quotedFullContent, isArticle };
}

// ── Page content fetching (articles & quoted tweets) ────────────────────────────
// Opens the URL in a background tab, waits for the SPA to render,
// injects extraction script, then closes the tab.

async function fetchPageContent(pageUrl) {
  // Only open tabs for trusted domains (x.com / twitter.com)
  if (!isAllowedFetchUrl(pageUrl)) return null;

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: pageUrl, active: false });
    tabId = tab.id;

    await waitForTabLoad(tabId, 15000);
    await sleep(4000); // extra wait for SPA hydration

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageContent,
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
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, timeoutMs);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Injected into the background tab. Waits for content to render, then
 * extracts the page's main text. Works for both X Articles and tweet threads.
 * Must be fully self-contained (serialised into the target page).
 */
function extractPageContent() {
  return new Promise((resolve) => {
    var attempts = 0;
    var maxAttempts = 16; // 16 x 500 ms = 8 s

    var timer = setInterval(function () {
      attempts++;

      // ── Strategy 1: Article-specific containers ──────────────────────────
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

      // ── Strategy 2: Tweet text blocks (thread or single tweet) ───────────
      var blocks = document.querySelectorAll('[data-testid="tweetText"]');
      if (blocks.length >= 1) {
        // Take up to first 10 blocks — covers the main tweet plus thread
        var textParts = [];
        var limit = Math.min(blocks.length, 10);
        for (var j = 0; j < limit; j++) {
          textParts.push(blocks[j].innerText);
        }
        var combined = textParts.join('\n\n');
        if (combined.length > 50) {
          clearInterval(timer);
          resolve({ title: '', body: combined.slice(0, 15000) });
          return;
        }
      }

      // ── Strategy 3: Fallback to <main> ───────────────────────────────────
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        var main = document.querySelector('main');
        if (main && main.innerText.length > 200) {
          var heading = document.querySelector('h1');
          resolve({
            title: heading ? heading.innerText : document.title,
            body: main.innerText.slice(0, 15000),
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

  // ── Assemble user content ─────────────────────────────────────────────────

  var userContent = '';

  if (isArticle) {
    // Full article mode
    userContent = 'Article: "' + articleContent.title + '"\n'
      + 'By ' + tweetData.author + '\n\n'
      + articleContent.body;
  } else if (tweetData.text) {
    // Regular tweet
    userContent = 'Tweet by ' + tweetData.author + ':\n' + tweetData.text;
  } else if (tweetData.cardText) {
    // Card-only tweet (e.g. article card without extra text)
    userContent = 'Post by ' + tweetData.author + ':\n' + tweetData.cardText;
  } else if (tweetData.fallbackText) {
    // Last resort: raw visible text from the tweet element
    userContent = 'Content by ' + tweetData.author + ':\n' + tweetData.fallbackText;
  }

  // Append quoted content — prefer full fetched version, fall back to inline preview
  if (hasQuotedFull) {
    var quotedBy = tweetData.quotedAuthor || 'another user';
    userContent += '\n\n--- Quoted / referenced post (by ' + quotedBy + ') ---\n' + quotedFullContent.body;
  } else if (tweetData.quotedText) {
    var qAuthor = tweetData.quotedAuthor || 'another user';
    userContent += '\n\nQuoted tweet (by ' + qAuthor + '):\n' + tweetData.quotedText;
  }

  // Append card text if not already used as main content
  if (!isArticle && tweetData.text && tweetData.cardText) {
    userContent += '\n\nAttached card:\n' + tweetData.cardText;
  }

  // ── System prompt ─────────────────────────────────────────────────────────

  // Shared fact-check instruction appended to every prompt
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

async function callOpenAI(apiKey, model, prompt, maxTokens) {
  var res = await fetch('https://api.openai.com/v1/chat/completions', {
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
    throw new Error((err.error && err.error.message) || 'OpenAI API error: ' + res.status);
  }
  var data = await res.json();
  return data.choices[0].message.content;
}

async function callClaude(apiKey, model, prompt, maxTokens) {
  var res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
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
  return data.content[0].text;
}

async function callKimi(apiKey, model, prompt, maxTokens) {
  var res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
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
    throw new Error((err.error && err.error.message) || 'Kimi API error: ' + res.status);
  }
  var data = await res.json();
  return data.choices[0].message.content;
}

async function callZhipu(apiKey, model, prompt, maxTokens) {
  var res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
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
    throw new Error((err.error && err.error.message) || '智谱 API error: ' + res.status);
  }
  var data = await res.json();
  return data.choices[0].message.content;
}
