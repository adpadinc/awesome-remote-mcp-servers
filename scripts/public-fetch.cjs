// A credential-free HTTP(S) transport for untrusted directory submissions.
// Resolve once at connection time; every returned address must be public.
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');

function publicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const value = parts.reduce((n, part) => (n << 16n) | BigInt(parseInt(part, 16)), 0n);
  const prefix = (base, bits) => (value >> BigInt(128 - bits)) === (base >> BigInt(128 - bits));
  // Restrict to global unicast; exclude special-use, documentation, and 6to4.
  return prefix(0x20000000000000000000000000000000n, 3) &&
    !prefix(0x20010000000000000000000000000000n, 23) &&
    !prefix(0x20010db8000000000000000000000000n, 32) &&
    !prefix(0x20020000000000000000000000000000n, 16) &&
    !prefix(0x3fff0000000000000000000000000000n, 20);
}

function checkedUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('endpoint must be a public HTTP(S) URL without credentials');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) && !publicAddress(hostname)) throw new Error('endpoint address is not public');
  return url;
}

function pinnedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
      return callback(new Error('endpoint DNS contains a non-public address'));
    }
    // Supply these exact answers to the socket; there is no second DNS lookup.
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(url, options) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: options.method || 'GET', headers: { ...options.headers, 'Accept-Encoding': 'identity' },
      signal: options.signal, lookup: pinnedLookup, agent: false,
    }, res => resolve(res));
    req.on('error', reject);
    req.end(options.body);
  });
}

async function fetchPublic(value, options = {}) {
  let url = checkedUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const res = await requestOnce(url, options);
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      const location = res.headers.location;
      res.destroy();
      if (!location || redirects === 3) throw new Error('endpoint redirect limit or missing location');
      const next = checkedUrl(new URL(location, url).href);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('endpoint redirect downgrades HTTPS');
      if (res.statusCode === 303 || ([301, 302].includes(res.statusCode) && options.method === 'POST')) {
        options = { ...options, method: 'GET', body: undefined };
      }
      url = next;
      continue;
    }
    let stream = res;
    const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
    if (encoding && encoding !== 'identity') {
      if (!['gzip', 'deflate', 'br'].includes(encoding)) { res.destroy(); throw new Error('unsupported content encoding'); }
      stream = encoding === 'br' ? zlib.createBrotliDecompress() : zlib.createUnzip();
      res.on('error', error => stream.destroy(error));
      stream.on('close', () => res.destroy());
      res.pipe(stream);
    }
    return { status: res.statusCode, headers: new Headers(res.headers), body: Readable.toWeb(stream) };
  }
  throw new Error('endpoint redirect limit');
}

module.exports = { fetchPublic };
