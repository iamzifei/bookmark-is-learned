/**
 * Unit tests for pure functions extracted from background.js.
 *
 * Since background.js is a Chrome extension service worker that relies on
 * browser APIs (chrome.*, fetch, crypto), we re-define the pure functions
 * here for isolated testing. This covers URL escaping, filename building,
 * URL whitelisting, and markdown content generation.
 */

import { describe, it, expect } from 'vitest';

// ── Re-defined pure functions from background.js ────────────────────────────

const ALLOWED_FETCH_HOSTS = ['x.com', 'twitter.com', 'mobile.twitter.com'];

function escapeMarkdownLinkUrl(url) {
  return url.replace(/[()]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function escapeMarkdownLinkText(text) {
  return text.replace(/[[\]]/g, '\\$&');
}

function isAllowedFetchUrl(url) {
  try {
    var parsed = new URL(url);
    return ALLOWED_FETCH_HOSTS.includes(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function buildFileName(tweetData, articleContent, isArticle) {
  var handle = 'unknown';
  var tweetUrl = tweetData.tweetUrl || tweetData.url || '';
  try {
    var pathname = new URL(tweetUrl).pathname;
    var firstSegment = pathname.split('/')[1];
    if (firstSegment) handle = firstSegment;
  } catch (_) { /* use default */ }

  var title = '';
  if (isArticle && articleContent && articleContent.title) {
    title = articleContent.title;
  } else {
    title = tweetData.text || tweetData.cardText || tweetData.fallbackText || '';
  }

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

function stripArticleMetadataPrefix(body, title, author) {
  var lines = body.split('\n');
  var cleanAuthor = (author || '').split('\n')[0].trim();
  var cleanTitle = (title || '').trim();
  var i = 0;
  var maxScan = Math.min(lines.length, 25);

  while (i < maxScan) {
    var line = lines[i].trim();
    if (!line) { i++; continue; }
    if (cleanTitle && line === cleanTitle) { i++; continue; }
    if (cleanAuthor && line === cleanAuthor) { i++; continue; }
    if (/^@\w+$/.test(line)) { i++; continue; }
    if (line === '·') { i++; continue; }
    if (/^\d{1,2}月\d{1,2}日$/.test(line)) { i++; continue; }
    if (/^\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(line)) { i++; continue; }
    if (/^(Follow|回关|关注|Edited)$/i.test(line)) { i++; continue; }
    if (/^[\d,.]+[万亿KkMm]?$/.test(line)) { i++; continue; }
    break;
  }

  return lines.slice(i).join('\n').trim();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('escapeMarkdownLinkUrl', () => {
  it('returns normal URLs unchanged', () => {
    expect(escapeMarkdownLinkUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  it('escapes parentheses that would break markdown link syntax', () => {
    expect(escapeMarkdownLinkUrl('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_%28bar%29'
    );
  });

  it('escapes multiple parentheses', () => {
    expect(escapeMarkdownLinkUrl('https://example.com/(a)/(b)')).toBe(
      'https://example.com/%28a%29/%28b%29'
    );
  });

  it('handles URL with no special characters', () => {
    expect(escapeMarkdownLinkUrl('https://x.com/user/status/123')).toBe(
      'https://x.com/user/status/123'
    );
  });
});

describe('escapeMarkdownLinkText', () => {
  it('returns normal text unchanged', () => {
    expect(escapeMarkdownLinkText('https://example.com')).toBe('https://example.com');
  });

  it('escapes square brackets that would break markdown link label', () => {
    expect(escapeMarkdownLinkText('https://example.com/[test]')).toBe(
      'https://example.com/\\[test\\]'
    );
  });

  it('escapes nested brackets', () => {
    expect(escapeMarkdownLinkText('[link](url)')).toBe('\\[link\\](url)');
  });
});

describe('isAllowedFetchUrl', () => {
  it('allows x.com URLs', () => {
    expect(isAllowedFetchUrl('https://x.com/user/status/123')).toBe(true);
  });

  it('allows twitter.com URLs', () => {
    expect(isAllowedFetchUrl('https://twitter.com/user/status/123')).toBe(true);
  });

  it('allows mobile.twitter.com URLs', () => {
    expect(isAllowedFetchUrl('https://mobile.twitter.com/user/status/123')).toBe(true);
  });

  it('rejects other domains', () => {
    expect(isAllowedFetchUrl('https://evil.com/page')).toBe(false);
  });

  it('rejects subdomains of x.com', () => {
    expect(isAllowedFetchUrl('https://sub.x.com/page')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isAllowedFetchUrl('not-a-url')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAllowedFetchUrl('')).toBe(false);
  });
});

describe('buildFileName', () => {
  it('extracts handle from tweet URL', () => {
    var result = buildFileName(
      { tweetUrl: 'https://x.com/elonmusk/status/123', text: 'Hello world' },
      null, false
    );
    expect(result).toMatch(/^elonmusk-Hello world-/);
    expect(result).toMatch(/\.md$/);
  });

  it('sanitizes unsafe filename characters', () => {
    var result = buildFileName(
      { tweetUrl: 'https://x.com/user/status/123', text: 'file/name:with*bad|chars' },
      null, false
    );
    expect(result).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('strips control characters and null bytes', () => {
    var result = buildFileName(
      { tweetUrl: 'https://x.com/user/status/123', text: 'hello\x00world\x1ftest' },
      null, false
    );
    expect(result).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('uses article title when isArticle is true', () => {
    var result = buildFileName(
      { tweetUrl: 'https://x.com/user/status/123', text: 'tweet text' },
      { title: 'My Great Article' },
      true
    );
    expect(result).toMatch(/^user-My Great Article-/);
  });

  it('uses "untitled" when no text content', () => {
    var result = buildFileName(
      { tweetUrl: 'https://x.com/user/status/123' },
      null, false
    );
    expect(result).toMatch(/^user-untitled-/);
  });

  it('strips leading dots to prevent hidden files', () => {
    var result = buildFileName(
      { tweetUrl: 'https://x.com/user/status/123', text: '...hidden' },
      null, false
    );
    expect(result).toMatch(/^user-hidden-/);
  });

  it('truncates long titles at word boundary', () => {
    var longTitle = 'This is a very long title that should be truncated because it exceeds the fifty character limit we set';
    var result = buildFileName(
      { tweetUrl: 'https://x.com/user/status/123', text: longTitle },
      null, false
    );
    // Title portion should be <= 50 chars (before timestamp)
    var titlePart = result.split('-').slice(1, -1).join('-');
    expect(titlePart.length).toBeLessThanOrEqual(50);
  });

  it('uses "unknown" when URL has no handle', () => {
    var result = buildFileName(
      { tweetUrl: '', text: 'hello' },
      null, false
    );
    expect(result).toMatch(/^unknown-hello-/);
  });

  it('caps handle at 30 characters', () => {
    var longHandle = 'a'.repeat(50);
    var result = buildFileName(
      { tweetUrl: 'https://x.com/' + longHandle + '/status/123', text: 'test' },
      null, false
    );
    var handlePart = result.split('-')[0];
    expect(handlePart.length).toBeLessThanOrEqual(30);
  });
});

describe('stripArticleMetadataPrefix', () => {
  it('strips title and author from beginning', () => {
    var body = 'My Article\nJohn Doe\n@johndoe\n·\nFollow\n\nThe actual content starts here.';
    var result = stripArticleMetadataPrefix(body, 'My Article', 'John Doe');
    expect(result).toBe('The actual content starts here.');
  });

  it('strips Chinese date format', () => {
    var body = '3月15日\nActual content';
    var result = stripArticleMetadataPrefix(body, '', '');
    expect(result).toBe('Actual content');
  });

  it('strips English date format', () => {
    var body = '15 Jan 2025\nActual content';
    var result = stripArticleMetadataPrefix(body, '', '');
    expect(result).toBe('Actual content');
  });

  it('strips engagement numbers', () => {
    var body = '27\n270\n31万\n302K\nActual content';
    var result = stripArticleMetadataPrefix(body, '', '');
    expect(result).toBe('Actual content');
  });

  it('preserves content that is not metadata', () => {
    var body = 'This is not metadata, it is real content.';
    var result = stripArticleMetadataPrefix(body, '', '');
    expect(result).toBe('This is not metadata, it is real content.');
  });

  it('handles empty body', () => {
    expect(stripArticleMetadataPrefix('', '', '')).toBe('');
  });

  it('stops stripping at first non-metadata line', () => {
    var body = '@handle\n·\nReal content starts here\n27\nMore content';
    var result = stripArticleMetadataPrefix(body, '', '');
    expect(result).toBe('Real content starts here\n27\nMore content');
  });
});
