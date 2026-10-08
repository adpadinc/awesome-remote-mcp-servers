const assert = require('node:assert/strict');
const test = require('node:test');
const dns = require('node:dns');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { gzipSync } = require('node:zlib');
const { fetchPublic } = require('../scripts/public-fetch.cjs');

function transport(t, replies, answers = [{ address: '93.184.216.34', family: 4 }]) {
  const connections = [], lookups = [];
  t.mock.method(dns, 'lookup', (host, options, callback) => {
    lookups.push(host);
    callback(null, typeof answers === 'function' ? answers(host) : answers);
  });
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => options.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) { req.emit('error', error); return; }
      connections.push({ url: url.href, addresses, options });
      const reply = replies.shift();
      if (!reply) { req.emit('error', new Error('unexpected connection')); return; }
      const res = Readable.from(reply.chunks || [Buffer.from('{"result":{}}')]);
      res.headers = reply.headers || {};
      res.statusCode = reply.status || 200;
      callback(res);
    }));
    return req;
  };
  t.mock.method(https, 'request', request);
  t.mock.method(http, 'request', request);
  return { connections, lookups };
}

async function body(response) {
  const reader = response.body.getReader();
  const chunks = [];
  while (true) { const item = await reader.read(); if (item.done) break; chunks.push(Buffer.from(item.value)); }
  return Buffer.concat(chunks).toString('utf8');
}

test('rejects private, reserved, normalized IP and credential destinations before connecting', async t => {
  const f = transport(t, []);
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://10.0.0.1/', 'https://169.254.169.254/', 'http://192.168.1.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[2001:db8::1]/',
    'http://198.18.0.1/', 'http://100.64.0.1/', 'file:///etc/passwd', 'https://user:secret@example.com/']) {
    await assert.rejects(fetchPublic(url));
  }
  assert.equal(f.connections.length, 0);
  assert.equal(f.lookups.length, 0);
});

test('rejects every DNS answer set containing a non-public address', async t => {
  const f = transport(t, [], [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await assert.rejects(fetchPublic('https://rebind.example/'), /non-public/);
  assert.equal(f.connections.length, 0);
  assert.deepEqual(f.lookups, ['rebind.example']);
});

test('pins validated answers and preserves original TLS hostname, response and decompression', async t => {
  const addresses = [{ address: '2606:4700:4700::1111', family: 6 }];
  const f = transport(t, [{ headers: { 'content-encoding': 'gzip' }, chunks: [gzipSync('{"result":{}}')] }], addresses);
  assert.equal(await body(await fetchPublic('https://service.example/mcp', { method: 'POST', body: '{}' })), '{"result":{}}');
  assert.deepEqual(f.lookups, ['service.example']);
  assert.deepEqual(f.connections[0].addresses, addresses);
  assert.equal(f.connections[0].url, 'https://service.example/mcp');
  assert.equal(f.connections[0].options.agent, false);
});

test('rechecks redirects before connecting and never permits HTTPS downgrade', async t => {
  const f = transport(t, [
    { status: 302, headers: { location: 'http://127.0.0.1/private' } },
    { status: 307, headers: { location: 'https://rebind.example/' } },
    { status: 302, headers: { location: 'http://public.example/' } },
  ], host => [{ address: host === 'rebind.example' ? '169.254.169.254' : '93.184.216.34', family: 4 }]);
  await assert.rejects(fetchPublic('https://service.example/'), /not public/);
  await assert.rejects(fetchPublic('https://service.example/'), /non-public/);
  await assert.rejects(fetchPublic('https://service.example/'), /downgrades/);
  assert.equal(f.connections.length, 3);
});

test('preserves public redirects and enforces their shared three-hop cap', async t => {
  const f = transport(t, [
    { status: 302, headers: { location: '/canonical' } }, {},
    ...Array.from({ length: 4 }, () => ({ status: 307, headers: { location: '/again' } })),
  ]);
  assert.equal(await body(await fetchPublic('https://service.example/', { method: 'POST', body: '{}' })), '{"result":{}}');
  assert.equal(f.connections[1].options.method, 'GET');
  await assert.rejects(fetchPublic('https://service.example/'), /redirect limit/);
  assert.equal(f.connections.length, 6);
});
