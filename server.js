'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const express = require('express');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'links.json');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Link store (in-memory, mirrored to disk so restarts keep existing links)
// ---------------------------------------------------------------------------

/** @type {Map<string, {id: string, target: string, createdAt: string, hits: number}>} */
const links = new Map();

function loadLinks() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    for (const link of JSON.parse(raw)) links.set(link.id, link);
  } catch {
    // no store yet, or unreadable - start empty
  }
}

let saveTimer = null;
function saveLinks() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify([...links.values()], null, 2));
    } catch {
      // disk is optional (Render free tier has an ephemeral FS)
    }
  }, 250);
}

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

function normalizeTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('URL is required');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }
  if (!url.hostname.includes('.')) throw new Error('That does not look like a valid host');
  return url.toString();
}

function publicBase(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Dashboard API
// ---------------------------------------------------------------------------

function withUrl(req, link) {
  return { ...link, url: `${publicBase(req)}/p/${link.id}/` };
}

app.get('/api/links', (req, res) => {
  const all = [...links.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((l) => withUrl(req, l));
  res.json(all);
});

app.post('/api/links', (req, res) => {
  let target;
  try {
    target = normalizeTarget(req.body && req.body.url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const existing = [...links.values()].find((l) => l.target === target);
  if (existing) return res.json(withUrl(req, existing));

  const link = { id: newId(), target, createdAt: new Date().toISOString(), hits: 0 };
  links.set(link.id, link);
  saveLinks();
  res.status(201).json(withUrl(req, link));
});

app.delete('/api/links/:id', (req, res) => {
  if (!links.delete(req.params.id)) return res.status(404).json({ error: 'Not found' });
  saveLinks();
  res.status(204).end();
});

// Diagnose a link: hit the target once and report exactly what it said.
app.get('/api/links/:id/probe', async (req, res) => {
  const link = links.get(req.params.id);
  if (!link) return res.status(404).json({ error: 'Unknown link id' });

  const started = Date.now();
  try {
    const upstream = await fetch(link.target, {
      method: 'GET',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; url-stream-proxy)',
        accept: '*/*',
        'accept-encoding': 'identity',
        range: 'bytes=0-1023',
      },
      redirect: 'manual',
    });
    const preview = await upstream
      .clone()
      .text()
      .then((t) => t.slice(0, 400))
      .catch(() => '<binary body>');
    res.json({
      ok: upstream.status < 400,
      status: upstream.status,
      statusText: upstream.statusText,
      ms: Date.now() - started,
      contentType: upstream.headers.get('content-type'),
      contentLength: upstream.headers.get('content-length'),
      location: upstream.headers.get('location'),
      acceptRanges: upstream.headers.get('accept-ranges'),
      bodyPreview: preview,
    });
  } catch (err) {
    res.json({ ok: false, status: 0, ms: Date.now() - started, error: err.message });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, links: links.size }));

// ---------------------------------------------------------------------------
// Streaming reverse proxy:  /p/:id/<path on the target site>
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
  'content-encoding', 'content-length', 'content-security-policy',
  'content-security-policy-report-only', 'strict-transport-security',
  'x-frame-options', 'accept-encoding',
]);

// We keep the target host in the proxied path so cross-host assets still work:
//   /p/<id>/<host><path>
function proxyPathFor(id, absUrl) {
  const u = new URL(absUrl);
  return `/p/${id}/${u.host}${u.pathname}${u.search}`;
}

function rewriteHtml(body, pageUrl, id) {
  const mount = `/p/${id}/`;
  const fix = (u) => {
    try {
      const abs = new URL(u, pageUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
      return proxyPathFor(id, abs.toString()) + abs.hash;
    } catch {
      return u;
    }
  };

  let out = body.replace(
    /\b(href|src|action|poster|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (m, attr, _q, dq, sq) => {
      const val = dq !== undefined ? dq : sq;
      if (!val || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(val.trim())) return m;
      return `${attr}="${fix(val)}"`;
    }
  );

  out = out.replace(/\bsrcset\s*=\s*"([^"]*)"/gi, (m, set) => {
    const parts = set.split(',').map((piece) => {
      const bits = piece.trim().split(/\s+/);
      if (!bits[0]) return piece.trim();
      bits[0] = fix(bits[0]);
      return bits.join(' ');
    });
    return `srcset="${parts.join(', ')}"`;
  });

  // Drop <base> tags and meta CSP so our rewritten relative paths win.
  out = out.replace(/<base\b[^>]*>/gi, '');
  out = out.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');

  return out;
}

function rewriteCss(body, pageUrl, id) {
  return body.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, quote, u) => {
    if (/^(data:|blob:|#)/i.test(u.trim())) return m;
    try {
      const abs = new URL(u, pageUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return m;
      return `url(${quote}${proxyPathFor(id, abs.toString())}${quote})`;
    } catch {
      return m;
    }
  });
}

app.all(/^\/p\/([a-f0-9]{6,32})(\/.*)?$/, async (req, res) => {
  const id = req.params[0];
  const rest = req.params[1] || '/';
  const link = links.get(id);
  if (!link) {
    return res
      .status(404)
      .type('text/plain')
      .send(
        `url-stream-proxy: no link with id "${id}".\n` +
          'It may have been deleted, or the server restarted (links live in memory).\n' +
          'Create it again on the dashboard.'
      );
  }

  const base = new URL(link.target);

  // rest looks like "/<host>/<path>" for rewritten links, or "/" / "/path" on first hit.
  let targetUrl;
  const m = rest.match(/^\/([^/]+\.[^/]+)(\/.*)?$/);
  if (m && /^[a-z0-9.-]+(:\d+)?$/i.test(m[1])) {
    targetUrl = new URL(`${base.protocol}//${m[1]}${m[2] || '/'}`);
  } else {
    targetUrl = new URL(rest === '/' ? base.pathname + base.search : rest, base.origin);
  }
  const qs = req.originalUrl.indexOf('?');
  if (qs !== -1) targetUrl.search = req.originalUrl.slice(qs);

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = targetUrl.host;
  headers['accept-encoding'] = 'identity';
  if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0 (compatible; url-stream-proxy)';
  delete headers.referer;
  delete headers.origin;

  const hasBody = !['GET', 'HEAD'].includes(req.method);

  let upstream;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    link.lastStatus = 0;
    link.lastError = err.message;
    link.lastAt = new Date().toISOString();
    saveLinks();
    console.error(`[proxy] ${req.method} ${targetUrl} -> request failed: ${err.message}`);
    return res
      .status(502)
      .type('text/plain')
      .send(`url-stream-proxy could not reach the target.\n\nTarget: ${targetUrl}\nError: ${err.message}`);
  }

  link.hits += 1;
  link.lastStatus = upstream.status;
  link.lastContentType = upstream.headers.get('content-type') || '';
  link.lastAt = new Date().toISOString();
  saveLinks();
  console.log(`[proxy] ${req.method} ${targetUrl} -> ${upstream.status} ${link.lastContentType}`);

  // Make it obvious whether a failure came from us or from the target site.
  res.setHeader('x-proxy-target', targetUrl.toString());
  res.setHeader('x-proxy-upstream-status', String(upstream.status));

  // Follow redirects through the proxy instead of bouncing the browser away.
  const location = upstream.headers.get('location');
  if (location && upstream.status >= 300 && upstream.status < 400) {
    try {
      const abs = new URL(location, targetUrl);
      res.setHeader('location', proxyPathFor(id, abs.toString()));
    } catch {
      res.setHeader('location', location);
    }
    return res.status(upstream.status).end();
  }

  for (const [k, v] of upstream.headers) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'location') continue;
    if (key === 'set-cookie') continue; // handled below
    res.setHeader(k, v);
  }
  const cookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  if (cookies.length) {
    res.setHeader(
      'set-cookie',
      cookies.map((c) => c.replace(/;\s*domain=[^;]*/gi, '').replace(/;\s*secure/gi, ''))
    );
  }

  res.status(upstream.status);

  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  const rewritable = type.includes('text/html') || type.includes('text/css');

  if (!upstream.body) return res.end();

  if (rewritable) {
    const text = await upstream.text();
    const out = type.includes('text/html')
      ? rewriteHtml(text, targetUrl.toString(), id)
      : rewriteCss(text, targetUrl.toString(), id);
    res.removeHeader('content-length');
    return res.end(out);
  }

  // Everything else streams straight through, chunk by chunk.
  Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
});

// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

loadLinks();
app.listen(PORT, () => console.log(`url-stream-proxy listening on :${PORT}`));
