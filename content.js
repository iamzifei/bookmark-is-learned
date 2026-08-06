// Content script for X (Twitter)
// Card-stacking TLDR system: each bookmark creates an independent card.
// Supports parallel processing — users can keep scrolling and bookmarking.

(function () {
  'use strict';

  const MAX_VISIBLE_CARDS = 3;
  let cardContainer = null;
  let activeCards = []; // { id, element, timerId }
  let cardSeq = 0;
  let currentTheme = 'auto'; // 'auto' | 'light' | 'dark'
  let currentMode = 'tldr'; // 'tldr' | 'original'
  let aiEnabled = true;
  let learnObs = null;
  let contextDead = false;

  function isExtensionAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function markContextDead(reason) {
    if (contextDead) return;
    contextDead = true;
    try {
      if (learnObs) {
        learnObs.disconnect();
        learnObs = null;
      }
    } catch (_) {}
    try {
      showReloadBanner(reason || '扩展已更新，请刷新本页');
    } catch (_) {}
  }

  function showReloadBanner(text) {
    if (!document.body) return;
    if (document.querySelector('.btl-reload-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'btl-reload-banner';
    banner.textContent = text + '（点此刷新）';
    banner.addEventListener('click', () => location.reload());
    document.body.appendChild(banner);
  }

  // ── Theme & mode management ───────────────────────────────────────────────

  try {
    chrome.storage.sync.get({ theme: 'auto', mdMode: 'tldr', aiEnabled: true }, function (data) {
      if (chrome.runtime.lastError || !isExtensionAlive()) {
        markContextDead('扩展上下文已失效，请刷新本页');
        return;
      }
      currentTheme = data.theme || 'auto';
      currentMode = data.mdMode || 'tldr';
      aiEnabled = data.aiEnabled !== false;
      applyThemeToContainer();
    });
  } catch (_) {
    markContextDead('扩展上下文已失效，请刷新本页');
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (!isExtensionAlive()) {
        markContextDead('扩展已重新加载，请刷新本页');
        return;
      }
      if (area === 'sync' && changes.theme) {
        currentTheme = changes.theme.newValue || 'auto';
        applyThemeToContainer();
      }
      if (area === 'sync' && changes.mdMode) {
        currentMode = changes.mdMode.newValue || 'tldr';
      }
      if (area === 'sync' && changes.aiEnabled) {
        aiEnabled = changes.aiEnabled.newValue !== false;
      }
    });
  } catch (_) {
    markContextDead('扩展上下文已失效，请刷新本页');
  }

  function applyThemeToContainer() {
    if (!cardContainer) return;
    cardContainer.classList.remove('btl-auto', 'btl-light', 'btl-dark');
    cardContainer.classList.add('btl-' + currentTheme);
  }

  // ── Bookmark click detection ──────────────────────────────────────────────

  function eventElement(event) {
    const t = event.target;
    if (!t) return null;
    return t.nodeType === 1 ? t : t.parentElement;
  }

  document.addEventListener('click', (event) => {
    try {
      if (contextDead || !isExtensionAlive()) {
        markContextDead('扩展已重新加载，请刷新本页');
        return;
      }

      const el = eventElement(event);
      if (!el || typeof el.closest !== 'function') return;

      const learnBtn = el.closest('.btl-learn-btn');
      if (learnBtn) {
        event.preventDefault();
        event.stopPropagation();
        const article = learnBtn.closest('article[data-testid="tweet"]');
        if (!article) return;
        const cardId = 'btl-' + (++cardSeq);
        createLoadingCard(cardId);
        processBookmark(article, cardId);
        return;
      }

      const bookmarkBtn = findAncestorByTestId(el, 'bookmark');
      const removeBtn = findAncestorByTestId(el, 'removeBookmark');
      if (!bookmarkBtn && !removeBtn) return;

      const article = (bookmarkBtn || removeBtn).closest('article[data-testid="tweet"]');
      if (!article) return;

      const cardId = 'btl-' + (++cardSeq);
      createLoadingCard(cardId);
      processBookmark(article, cardId);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/Extension context invalidated/i.test(msg)) {
        markContextDead('扩展已重新加载，请刷新本页');
      } else {
        console.warn('[btl] click handler:', msg);
      }
    }
  }, true);

  function injectLearnButtons(root) {
    if (contextDead || !isExtensionAlive()) return;
    const articles = (root || document).querySelectorAll?.('article[data-testid="tweet"]') || [];
    articles.forEach((article) => {
      if (article.querySelector('.btl-learn-btn')) return;
      const group =
        article.querySelector('[role="group"]') ||
        article.querySelector('[data-testid="bookmark"]')?.parentElement?.parentElement ||
        article.querySelector('[data-testid="removeBookmark"]')?.parentElement?.parentElement;
      if (!group) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btl-learn-btn';
      btn.textContent = '学到';
      btn.title = '生成摘要并保存 Markdown（无需重新收藏）';
      group.appendChild(btn);
    });
  }

  function startLearnButtonObserver() {
    if (contextDead) return;
    injectLearnButtons(document);
    if (!document.body) {
      setTimeout(startLearnButtonObserver, 300);
      return;
    }
    learnObs = new MutationObserver((mutations) => {
      if (contextDead || !isExtensionAlive()) {
        markContextDead('扩展已重新加载，请刷新本页');
        return;
      }
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) injectLearnButtons(node);
        }
      }
    });
    learnObs.observe(document.body, { childList: true, subtree: true });

    if (isExtensionAlive()) {
      const badge = document.createElement('div');
      badge.className = 'btl-loaded-badge';
      badge.textContent = '收藏到就是学到 · 已加载';
      document.body.appendChild(badge);
      setTimeout(() => {
        try { badge.remove(); } catch (_) {}
      }, 4000);
    }
  }
  startLearnButtonObserver();

  // ── Main async flow (per card) ────────────────────────────────────────────

  async function processBookmark(article, cardId) {
    try {
      if (contextDead || !isExtensionAlive()) {
        updateCard(cardId, '扩展已重新加载，请刷新本页后再试', true);
        markContextDead('扩展已重新加载，请刷新本页');
        return;
      }
      await expandShowMore(article);
      const tweetData = extractTweetContent(article);
      const articleUrl = detectArticleUrl(article);
      const quotedTweetUrl = detectQuotedTweetUrl(article);

      const hasContent = tweetData.text || tweetData.cardText
        || tweetData.quotedText || tweetData.fallbackText;
      if (!hasContent && !articleUrl && !quotedTweetUrl) {
        updateCard(cardId, '未找到可总结的内容', true);
        return;
      }

      if (!isExtensionAlive()) {
        updateCard(cardId, '扩展已重新加载，请刷新本页后再试', true);
        markContextDead('扩展已重新加载，请刷新本页');
        return;
      }
      chrome.runtime.sendMessage(
        { type: 'GENERATE_TLDR', tweetData, articleUrl, quotedTweetUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || '';
            if (/invalidated/i.test(errMsg)) {
              markContextDead('扩展已重新加载，请刷新本页');
            }
            updateCard(cardId, '扩展连接失败：' + errMsg + '。请刷新页面后重试', true);
            return;
          }
          if (response?.success) {
            if (response.mode === 'raw') {
              updateCard(cardId, '已保存原文到 Markdown', false, tweetData.tweetUrl);
            } else {
              updateCard(cardId, response.tldr, false, tweetData.tweetUrl);
            }
          } else {
            updateCard(cardId, response?.error || '生成摘要失败', true);
          }
        }
      );
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (/Extension context invalidated/i.test(msg)) {
        markContextDead('扩展已重新加载，请刷新本页');
        updateCard(cardId, '扩展已重新加载，请刷新本页后再试', true);
      } else {
        updateCard(cardId, '处理出错: ' + msg, true);
      }
    }
  }

  function findAncestorByTestId(el, testId) {
    while (el && el !== document.body) {
      if (el.getAttribute?.('data-testid') === testId) return el;
      el = el.parentElement;
    }
    return null;
  }

  async function expandShowMore(article) {
    const links = article.querySelectorAll('[data-testid="tweet-text-show-more-link"]');
    if (links.length === 0) return;
    links.forEach((l) => l.click());
    await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (!article.querySelector('[data-testid="tweet-text-show-more-link"]')) {
          obs.disconnect(); resolve();
        }
      });
      obs.observe(article, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 3000);
    });
  }

  function extractTweetContent(article) {
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const text = tweetTextEl ? tweetTextEl.innerText : '';

    const authorEl = article.querySelector('[data-testid="User-Name"]');
    const author = authorEl ? authorEl.innerText.split('\n')[0] : '';

    const quotedTweet = article.querySelector('[data-testid="quoteTweet"]');
    const quotedText = quotedTweet
      ? (quotedTweet.querySelector('[data-testid="tweetText"]')?.innerText || '') : '';
    const quotedAuthorEl = quotedTweet
      ? quotedTweet.querySelector('[data-testid="User-Name"]') : null;
    const quotedAuthor = quotedAuthorEl ? quotedAuthorEl.innerText.split('\n')[0] : '';

    const cardEl = article.querySelector('[data-testid="card.wrapper"]');
    const cardText = cardEl ? cardEl.innerText : '';
    const referencedUrls = collectReferencedUrls(article, quotedTweet);

    let fallbackText = '';
    if (!text && !cardText) {
      const h1s = article.querySelectorAll('h1');
      if (h1s.length >= 2) {
        const bodyContainer = h1s[0].parentElement;
        if (bodyContainer && bodyContainer.innerText.trim().length > 200) {
          const clone = bodyContainer.cloneNode(true);
          clone.querySelectorAll('[role="status"]').forEach((s) => s.remove());
          fallbackText = clone.innerText.trim();
        }
      }
      if (!fallbackText) {
        const clone = article.cloneNode(true);
        clone.querySelectorAll('[role="group"]').forEach((g) => g.remove());
        fallbackText = clone.innerText.trim();
      }
    }

    let tweetUrl = window.location.href;
    const allStatusLinks = article.querySelectorAll('a[href*="/status/"]');
    for (const link of allStatusLinks) {
      if (quotedTweet && quotedTweet.contains(link)) continue;
      if (link.querySelector('time')) {
        const href = link.getAttribute('href') || '';
        tweetUrl = href.startsWith('/') ? 'https://x.com' + href : (href || tweetUrl);
        break;
      }
    }

    const metrics = extractEngagementMetrics(article);

    return {
      text, author, quotedText, quotedAuthor, cardText, fallbackText,
      tweetUrl, url: window.location.href, metrics, referencedUrls,
    };
  }

  function collectReferencedUrls(article, quotedTweet) {
    const links = article.querySelectorAll('a[href]');
    const seen = new Set();
    const urls = [];

    for (const link of links) {
      if (quotedTweet && quotedTweet.contains(link)) continue;

      const hrefRaw = link.getAttribute('href') || link.href || '';
      const href = hrefRaw.startsWith('/') ? ('https://x.com' + hrefRaw) : hrefRaw;
      if (!href) continue;

      let parsed;
      try {
        parsed = new URL(href, window.location.origin);
      } catch (_) {
        continue;
      }

      const host = (parsed.hostname || '').toLowerCase();
      const path = parsed.pathname || '';

      if (host === 'x.com' || host === 'twitter.com' || host === 'www.twitter.com') {
        if (
          /^\/[^/]+\/status\/\d+/.test(path)
          || /^\/i\/(?:article|status|analytics)/.test(path)
          || /\/(?:photo|video)\//.test(path)
          || /^\/[^/]+$/.test(path)
        ) {
          continue;
        }
      }

      const normalized = parsed.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      urls.push(normalized);
    }

    return urls;
  }

  function extractEngagementMetrics(article) {
    var metrics = { replies: '0', retweets: '0', likes: '0', views: '0' };
    var group = article.querySelector('[role="group"]');
    if (!group) return metrics;

    var testIds = { reply: 'replies', retweet: 'retweets', like: 'likes' };
    for (var tid in testIds) {
      var btn = group.querySelector('[data-testid="' + tid + '"]');
      if (btn) {
        var label = btn.getAttribute('aria-label') || '';
        var m = label.match(/([\d,]+)/);
        if (m) metrics[testIds[tid]] = m[1].replace(/,/g, '');
      }
    }

    var viewLink = article.querySelector('a[href*="/analytics"]');
    if (viewLink) {
      var viewLabel = viewLink.getAttribute('aria-label') || '';
      var vm = viewLabel.match(/([\d,]+)/);
      if (vm) metrics.views = vm[1].replace(/,/g, '');
    } else {
      var allLabels = group.querySelectorAll('[aria-label]');
      for (var i = 0; i < allLabels.length; i++) {
        var al = allLabels[i].getAttribute('aria-label') || '';
        if (/views?/i.test(al)) {
          var vvm = al.match(/([\d,]+)/);
          if (vvm) { metrics.views = vvm[1].replace(/,/g, ''); break; }
        }
      }
    }

    return metrics;
  }

  function detectArticleUrl(article) {
    const links = article.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href || link.getAttribute('href') || '';
      if (/\/(articles?)\//i.test(href)) {
        const cleanHref = href.replace(/\/(media|photo|video)\/.*$/, '');
        return cleanHref.startsWith('/') ? 'https://x.com' + cleanHref : cleanHref;
      }
    }
    const articleTestIds = [
      '[data-testid="noteBody"]',
      '[data-testid="richTextContainer"]',
      '[data-testid="articleBody"]',
      '[data-testid="article-content"]',
    ];
    for (const sel of articleTestIds) {
      const el = article.querySelector(sel);
      if (el) {
        const cl = el.closest('a[href]') || el.querySelector('a[href]');
        if (cl) {
          const h = cl.href || cl.getAttribute('href') || '';
          if (h) return h.startsWith('/') ? 'https://x.com' + h : h;
        }
      }
    }
    return null;
  }

  function detectQuotedTweetUrl(article) {
    const qt = article.querySelector('[data-testid="quoteTweet"]');
    if (!qt) return null;
    const links = qt.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href || link.getAttribute('href') || '';
      if (/\/status\/\d+/.test(href)) return href.startsWith('/') ? 'https://x.com' + href : href;
    }
    return null;
  }

  function ensureContainer() {
    if (!cardContainer || !cardContainer.parentNode) {
      cardContainer = document.createElement('div');
      cardContainer.className = 'btl-card-container btl-' + currentTheme;
      document.body.appendChild(cardContainer);
    }
    return cardContainer;
  }

  function createLoadingCard(cardId) {
    const container = ensureContainer();
    while (activeCards.length >= MAX_VISIBLE_CARDS) {
      dismissCard(activeCards[0].id);
    }

    const card = document.createElement('div');
    card.className = 'btl-tldr-card';
    card.dataset.cardId = cardId;

    const header = document.createElement('div');
    header.className = 'btl-card-header';
    const title = document.createElement('span');
    title.className = 'btl-card-title';
    const iconImg = document.createElement('img');
    iconImg.className = 'btl-card-title-icon';
    try {
      if (!isExtensionAlive()) throw new Error('Extension context invalidated.');
      iconImg.src = chrome.runtime.getURL('icons/icon48.png');
    } catch (_) {
      markContextDead('扩展已重新加载，请刷新本页');
      iconImg.alt = '';
    }
    iconImg.alt = '';
    title.appendChild(iconImg);
    title.appendChild(document.createTextNode('收藏到就是学到'));
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btl-card-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => dismissCard(cardId));
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'btl-card-body';
    const wrap = document.createElement('div');
    wrap.className = 'btl-loading';
    const spinner = document.createElement('div');
    spinner.className = 'btl-spinner';
    const loadText = document.createElement('span');
    loadText.textContent = aiEnabled ? '正在生成摘要...' : '正在保存原文...';
    wrap.appendChild(spinner);
    wrap.appendChild(loadText);
    body.appendChild(wrap);

    card.appendChild(header);
    card.appendChild(body);
    container.appendChild(card);

    activeCards.push({ id: cardId, element: card, timerId: null });
  }

  function updateCard(cardId, content, isError, tweetUrl) {
    const info = activeCards.find((c) => c.id === cardId);
    if (!info) return;

    const card = info.element;
    if (isError) card.classList.add('btl-error');

    const body = card.querySelector('.btl-card-body');
    body.textContent = '';

    const contentEl = document.createElement('div');
    contentEl.className = 'btl-tldr-content';
    renderFormattedTLDR(contentEl, content || '');
    body.appendChild(contentEl);

    if (!isError && tweetUrl) {
      const linkWrap = document.createElement('div');
      linkWrap.className = 'btl-original-link';
      const a = document.createElement('a');
      a.href = tweetUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = '查看原帖 \u2197';
      linkWrap.appendChild(a);
      body.appendChild(linkWrap);
    }

    info.timerId = setTimeout(() => dismissCard(cardId), 60000);
  }

  function dismissCard(cardId) {
    const idx = activeCards.findIndex((c) => c.id === cardId);
    if (idx === -1) return;
    const info = activeCards[idx];
    if (info.timerId) clearTimeout(info.timerId);
    info.element.classList.add('btl-fade-out');
    setTimeout(() => {
      if (info.element.parentNode) info.element.remove();
    }, 300);
    activeCards.splice(idx, 1);
  }

  function renderFormattedTLDR(container, text) {
    const lines = text.split('\n');
    let currentList = null;
    let currentListType = '';

    function flushList() {
      if (currentList) { container.appendChild(currentList); }
      currentList = null; currentListType = '';
    }

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { flushList(); continue; }

      const headingMatch = trimmed.match(/^\*\*(.+?)\*\*\s*[-:]?\s*$/);
      if (headingMatch) { flushList(); const h = document.createElement('div'); h.className = 'btl-section-heading'; h.textContent = headingMatch[1]; container.appendChild(h); continue; }

      const scoreMatch = trimmed.match(/^(Credibility|可信度|信頼度)\s*[:：]\s*(\d+)\s*\/\s*10/i);
      if (scoreMatch) {
        flushList();
        const sl = document.createElement('div'); sl.className = 'btl-score-line';
        const score = parseInt(scoreMatch[2], 10);
        const cls = score >= 7 ? 'btl-score-high' : (score >= 4 ? 'btl-score-mid' : 'btl-score-low');
        const badge = document.createElement('span'); badge.className = 'btl-score-badge ' + cls; badge.textContent = scoreMatch[2] + '/10';
        const justification = trimmed.slice(trimmed.indexOf('/10') + 3).replace(/^\s*[-\u2014]\s*/, '');
        sl.appendChild(document.createTextNode(scoreMatch[1] + ': '));
        sl.appendChild(badge);
        if (justification) { const rest = document.createElement('span'); rest.textContent = ' \u2014 ' + justification; sl.appendChild(rest); }
        container.appendChild(sl); continue;
      }

      const bulletMatch = trimmed.match(/^[-\u2022*]\s+(.*)/);
      if (bulletMatch) {
        if (currentListType !== 'ul') { flushList(); currentList = document.createElement('ul'); currentListType = 'ul'; }
        const li = document.createElement('li'); renderInline(li, bulletMatch[1]); currentList.appendChild(li); continue;
      }

      const numMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
      if (numMatch) {
        if (currentListType !== 'ol') { flushList(); currentList = document.createElement('ol'); currentListType = 'ol'; }
        const li = document.createElement('li'); renderInline(li, numMatch[1]); currentList.appendChild(li); continue;
      }

      flushList();
      const p = document.createElement('p'); renderInline(p, trimmed); container.appendChild(p);
    }
    flushList();
  }

  function renderInline(el, text) {
    const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
    const matches = Array.from(text.matchAll(pattern));
    if (matches.length === 0) { el.appendChild(document.createTextNode(text)); return; }
    let cursor = 0;
    for (const m of matches) {
      if (m.index > cursor) el.appendChild(document.createTextNode(text.slice(cursor, m.index)));
      if (m[2]) { const s = document.createElement('strong'); s.textContent = m[2]; el.appendChild(s); }
      else if (m[3]) { const e = document.createElement('em'); e.textContent = m[3]; el.appendChild(e); }
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) el.appendChild(document.createTextNode(text.slice(cursor)));
  }

  chrome.runtime.onMessage.addListener(function (message) {
    if (!isExtensionAlive()) {
      markContextDead('扩展已重新加载，请刷新本页');
      return;
    }
    if (message.type === 'SAVE_MARKDOWN') {
      var blob = new Blob([message.markdown], { type: 'text/markdown' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = message.fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
    }
  });
})();
