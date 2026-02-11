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

  // ── Theme & mode management ───────────────────────────────────────────────

  // Load initial theme and mode preferences from storage
  chrome.storage.sync.get({ theme: 'auto', mdMode: 'tldr' }, function (data) {
    currentTheme = data.theme || 'auto';
    currentMode = data.mdMode || 'tldr';
    applyThemeToContainer();
  });

  // Listen for setting changes from the popup
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'sync' && changes.theme) {
      currentTheme = changes.theme.newValue || 'auto';
      applyThemeToContainer();
    }
    if (area === 'sync' && changes.mdMode) {
      currentMode = changes.mdMode.newValue || 'tldr';
    }
  });

  // Apply theme class to the card container element
  function applyThemeToContainer() {
    if (!cardContainer) return;
    cardContainer.classList.remove('btl-auto', 'btl-light', 'btl-dark');
    cardContainer.classList.add('btl-' + currentTheme);
  }

  // ── Bookmark click detection ──────────────────────────────────────────────

  document.addEventListener('click', (event) => {
    const bookmarkBtn = findAncestorByTestId(event.target, 'bookmark');
    if (!bookmarkBtn) return;

    // Only fire when adding a bookmark, not when removing one.
    // X uses "removeBookmark" for the un-bookmark button.
    const removeBtn = findAncestorByTestId(event.target, 'removeBookmark');
    if (removeBtn) return;

    const article = bookmarkBtn.closest('article[data-testid="tweet"]');
    if (!article) return;

    const cardId = 'btl-' + (++cardSeq);
    createLoadingCard(cardId);
    processBookmark(article, cardId);
  }, true);

  // ── Main async flow (per card) ────────────────────────────────────────────

  async function processBookmark(article, cardId) {
    try {
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

      chrome.runtime.sendMessage(
        { type: 'GENERATE_TLDR', tweetData, articleUrl, quotedTweetUrl },
        (response) => {
          if (chrome.runtime.lastError) {
            updateCard(cardId, '扩展连接失败，请刷新页面', true);
            return;
          }
          if (response?.success) {
            updateCard(cardId, response.tldr, false, tweetData.tweetUrl);
          } else {
            updateCard(cardId, response?.error || '生成摘要失败', true);
          }
        }
      );
    } catch (err) {
      updateCard(cardId, '处理出错: ' + err.message, true);
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────

  function findAncestorByTestId(el, testId) {
    while (el && el !== document.body) {
      if (el.getAttribute?.('data-testid') === testId) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ── Show-more expansion ───────────────────────────────────────────────────

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

  // ── Content extraction ────────────────────────────────────────────────────

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

    let fallbackText = '';
    if (!text && !cardText) {
      const clone = article.cloneNode(true);
      const bar = clone.querySelector('[role="group"]');
      if (bar) bar.remove();
      fallbackText = clone.innerText.trim();
    }

    // Extract the tweet's own permalink (timestamp link, not inside quoted tweet)
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

    // Extract engagement metrics (replies, retweets, likes, views)
    const metrics = extractEngagementMetrics(article);

    return {
      text, author, quotedText, quotedAuthor, cardText, fallbackText,
      tweetUrl, url: window.location.href, metrics,
    };
  }

  // ── Engagement metrics extraction ──────────────────────────────────────────

  function extractEngagementMetrics(article) {
    var metrics = { replies: '0', retweets: '0', likes: '0', views: '0' };
    var group = article.querySelector('[role="group"]');
    if (!group) return metrics;

    // Each action button exposes its count in the aria-label attribute,
    // e.g. "123 replies. Reply", "5 reposts. Repost", "10 likes. Like".
    // If the count is zero X omits the number (just "Reply", "Like", etc.).
    var testIds = { reply: 'replies', retweet: 'retweets', like: 'likes' };
    for (var tid in testIds) {
      var btn = group.querySelector('[data-testid="' + tid + '"]');
      if (btn) {
        var label = btn.getAttribute('aria-label') || '';
        var m = label.match(/([\d,]+)/);
        if (m) metrics[testIds[tid]] = m[1].replace(/,/g, '');
      }
    }

    // Views count: X puts it in an analytics link or a standalone element
    // outside the main action buttons. Try analytics link first, then
    // look for any aria-label mentioning "view" near the action bar.
    var viewLink = article.querySelector('a[href*="/analytics"]');
    if (viewLink) {
      var viewLabel = viewLink.getAttribute('aria-label') || '';
      var vm = viewLabel.match(/([\d,]+)/);
      if (vm) metrics.views = vm[1].replace(/,/g, '');
    } else {
      // Fallback: some X layouts show views as a separate span in the group
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

  // ── URL detection ─────────────────────────────────────────────────────────

  function detectArticleUrl(article) {
    const links = article.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href || link.getAttribute('href') || '';
      if (/\/(articles?)\//i.test(href)) {
        return href.startsWith('/') ? 'https://x.com' + href : href;
      }
    }
    const ac = article.querySelector('[data-testid*="article" i], [data-testid*="Article"]');
    if (ac) {
      const cl = ac.closest('a[href]') || ac.querySelector('a[href]');
      if (cl) { const h = cl.href || cl.getAttribute('href') || ''; if (h) return h.startsWith('/') ? 'https://x.com' + h : h; }
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

  // ── Card container & stacking ─────────────────────────────────────────────

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
    // Auto-dismiss oldest if at capacity
    while (activeCards.length >= MAX_VISIBLE_CARDS) {
      dismissCard(activeCards[0].id);
    }

    const card = document.createElement('div');
    card.className = 'btl-tldr-card';
    card.dataset.cardId = cardId;

    // Header
    const header = document.createElement('div');
    header.className = 'btl-card-header';
    const title = document.createElement('span');
    title.className = 'btl-card-title';
    // Use extension icon instead of emoji
    const iconImg = document.createElement('img');
    iconImg.className = 'btl-card-title-icon';
    iconImg.src = chrome.runtime.getURL('icons/icon48.png');
    iconImg.alt = '';
    title.appendChild(iconImg);
    title.appendChild(document.createTextNode('收藏到就是学到'));
    const closeBtn = document.createElement('button');
    closeBtn.className = 'btl-card-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.addEventListener('click', () => dismissCard(cardId));
    header.appendChild(title);
    header.appendChild(closeBtn);

    // Body — loading state
    const body = document.createElement('div');
    body.className = 'btl-card-body';
    const wrap = document.createElement('div');
    wrap.className = 'btl-loading';
    const spinner = document.createElement('div');
    spinner.className = 'btl-spinner';
    const loadText = document.createElement('span');
    loadText.textContent = currentMode === 'original' ? '正在保存原文...' : '正在生成摘要...';
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

    // Replace body contents
    const body = card.querySelector('.btl-card-body');
    body.textContent = '';

    const contentEl = document.createElement('div');
    contentEl.className = 'btl-tldr-content';
    renderFormattedTLDR(contentEl, content || '');
    body.appendChild(contentEl);

    // Original tweet link (if available and not an error)
    if (!isError && tweetUrl) {
      const linkWrap = document.createElement('div');
      linkWrap.className = 'btl-original-link';
      const a = document.createElement('a');
      a.href = tweetUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '查看原帖 \u2197';
      linkWrap.appendChild(a);
      body.appendChild(linkWrap);
    }

    // Auto-dismiss after 60 s
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

  // ── Formatted TLDR rendering ──────────────────────────────────────────────

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
})();
