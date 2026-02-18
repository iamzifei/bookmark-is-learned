/**
 * Unit tests for pure functions extracted from popup.js.
 *
 * These functions handle version comparison and URL normalization,
 * which are critical for update checking and API endpoint resolution.
 */

import { describe, it, expect } from 'vitest';

// ── Re-defined pure functions from popup.js ─────────────────────────────────

function isNewerVersion(remote, local) {
  var r = remote.split('.').map(Number);
  var l = local.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((r[i] || 0) > (l[i] || 0)) return true;
    if ((r[i] || 0) < (l[i] || 0)) return false;
  }
  return false;
}

function normalizeBaseUrl(value) {
  try {
    var normalizedInput = value;
    // Only add https:// if the input has no protocol at all.
    // Reject inputs that have a non-http(s) protocol (e.g. ftp://, file://).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedInput)) {
      if (!/^https?:\/\//i.test(normalizedInput)) return '';
    } else {
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('isNewerVersion', () => {
  it('detects newer major version', () => {
    expect(isNewerVersion('2.0.0', '1.0.0')).toBe(true);
  });

  it('detects newer minor version', () => {
    expect(isNewerVersion('1.1.0', '1.0.0')).toBe(true);
  });

  it('detects newer patch version', () => {
    expect(isNewerVersion('1.0.1', '1.0.0')).toBe(true);
  });

  it('returns false for same version', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false);
  });

  it('returns false when remote is older', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(false);
    expect(isNewerVersion('0.9.0', '1.0.0')).toBe(false);
  });

  it('handles version strings with fewer segments', () => {
    expect(isNewerVersion('2.0', '1.0.0')).toBe(true);
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
  });

  it('handles higher minor but lower major', () => {
    expect(isNewerVersion('1.5.0', '2.0.0')).toBe(false);
  });
});

describe('normalizeBaseUrl', () => {
  it('adds https:// prefix when missing', () => {
    expect(normalizeBaseUrl('api.example.com')).toBe('https://api.example.com');
  });

  it('preserves existing https://', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com');
  });

  it('preserves existing http://', () => {
    expect(normalizeBaseUrl('http://api.example.com')).toBe('http://api.example.com');
  });

  it('strips trailing slashes from path', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
  });

  it('preserves path segments', () => {
    expect(normalizeBaseUrl('https://proxy.example.com/api/v1')).toBe(
      'https://proxy.example.com/api/v1'
    );
  });

  it('returns empty string for invalid URLs', () => {
    expect(normalizeBaseUrl('')).toBe('');
    expect(normalizeBaseUrl('   ')).toBe('');
  });

  it('returns empty string for non-http protocols', () => {
    expect(normalizeBaseUrl('ftp://example.com')).toBe('');
    expect(normalizeBaseUrl('file:///etc/passwd')).toBe('');
  });

  it('handles URL with just domain and path', () => {
    expect(normalizeBaseUrl('example.com/v1/chat/completions')).toBe(
      'https://example.com/v1/chat/completions'
    );
  });
});
