const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Script } = require('node:vm');
const test = require('node:test');

// Execute the actual probe, without GitHub credentials or network I/O.
const workflow = readFileSync(join(__dirname, '../scripts/validate-submission.cjs'), 'utf8');
const start = workflow.indexOf('const initBody =');
const end = workflow.indexOf('async function connectorExists', start);
assert.ok(start >= 0 && end > start);
const source = workflow.slice(start, end).replace(/^            /gm, '');

function fixture(response) {
  let signal;
  const script = new Script(`${source}\nprobe;`);
  const probe = script.runInNewContext({
    AbortController, TextDecoder, setTimeout, clearTimeout,
    fetchPublic: async (_url, options) => { signal = options.signal; return response; }
  });
  return { probe, aborted: () => signal.aborted };
}

function streamed(chunks, headers = {}) {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (pulled < chunks.length) controller.enqueue(chunks[pulled++]);
      else controller.close();
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  return { response: new Response(body, { headers }), pulled: () => pulled, cancelled: () => cancelled };
}

test('accepts complete JSON and SSE responses and releases their fetch', async () => {
  for (const [text, headers] of [[JSON.stringify(initializeResult), {}], ['data: ' + JSON.stringify(initializeResult) + '\n\n', { 'content-type': 'text/event-stream' }]]) {
    const f = fixture(new Response(text, { headers }));
    const result = await f.probe('https://fixture.invalid/mcp');
    assert.equal(result.ok, true);
    assert.equal(result.auth, '🔓');
    assert.equal(f.aborted(), true);
  }
});

test('accepts an exact byte boundary including split UTF-8 characters', async () => {
  const prefix = JSON.stringify({ ...initializeResult, result: { ...initializeResult.result, serverInfo: { name: 'é', version: '1.0' } } });
  const bytes = new TextEncoder().encode(prefix + ' '.repeat(20000 - Buffer.byteLength(prefix)));
  const split = bytes.indexOf(0xc3) + 1;
  const stream = streamed([bytes.slice(0, split), bytes.slice(split)]);
  const f = fixture(stream.response);
  assert.equal((await f.probe('https://fixture.invalid/mcp')).ok, true);
  assert.equal(f.aborted(), true);
});

test('rejects oversized chunked bodies before consuming the remaining stream', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const stream = streamed([new Uint8Array(10000), new Uint8Array(10001), new Uint8Array(10000)], headers);
    const f = fixture(stream.response);
    const result = await f.probe('https://fixture.invalid/mcp');
    assert.equal(result.ok, false);
    assert.match(result.why, /exceeds 20000 bytes/);
    assert.equal(stream.pulled(), 2);
    assert.equal(stream.cancelled(), true);
    assert.equal(f.aborted(), true);
  }
});

test('rejects one oversized chunk and counts UTF-8 bytes rather than characters', async () => {
  for (const bytes of [new Uint8Array(2 * 1024 * 1024), new TextEncoder().encode('é'.repeat(10001))]) {
    const stream = streamed([bytes, new Uint8Array(1)]);
    const f = fixture(stream.response);
    assert.equal((await f.probe('https://fixture.invalid/mcp')).ok, false);
    assert.equal(stream.pulled(), 1);
    assert.equal(stream.cancelled(), true);
    assert.equal(f.aborted(), true);
  }
});

test('declared oversized bodies fail before reading and abort the fetch', async () => {
  const stream = streamed([new Uint8Array(1)], { 'content-length': '20001' });
  const f = fixture(stream.response);
  assert.equal((await f.probe('https://fixture.invalid/mcp')).ok, false);
  assert.equal(stream.pulled(), 0);
  assert.equal(f.aborted(), true);
});

test('auth-only responses preserve classification and abort unused bodies', async () => {
  for (const status of [401, 403]) {
    const f = fixture(new Response('not inspected', { status, headers: { 'www-authenticate': 'Bearer' } }));
    const result = await f.probe('https://fixture.invalid/mcp');
    assert.equal(result.ok, true);
    assert.equal(result.auth, '🔐');
    assert.equal(f.aborted(), true);
  }
});

test('malformed and empty responses retain normal probe failure behavior', async () => {
  for (const body of ['not JSON', null]) {
    const f = fixture(new Response(body));
    const result = await f.probe('https://fixture.invalid/mcp');
    assert.equal(result.ok, false);
    assert.match(result.why, /no initialize result/);
    assert.equal(f.aborted(), true);
  }
});

const initializeResult = {
  jsonrpc: '2.0', id: 1,
  result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1.0' } }
};

test('rejects failed HTTP responses and invalid initialize envelopes', async () => {
  const invalid = [
    { status: 500, body: initializeResult }, { status: 200, body: { result: { message: 'hello' } } },
    { status: 200, body: { ...initializeResult, id: 2 } },
    { status: 200, body: { ...initializeResult, jsonrpc: '1.0' } },
    { status: 200, body: { ...initializeResult, error: { code: -32603, message: 'failed' } } },
    ...[{}, [], null, { ...initializeResult.result, capabilities: [] },
      { ...initializeResult.result, protocolVersion: '' }, { ...initializeResult.result, serverInfo: {} }]
      .map(result => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } }))
  ];
  for (const { status, body } of invalid) {
    const f = fixture(new Response(JSON.stringify(body), { status }));
    assert.equal((await f.probe('https://fixture.invalid/mcp')).ok, false, JSON.stringify({ status, body }));
    assert.equal(f.aborted(), true);
  }
});

test('accepts initialize after SSE notifications, comments and unrelated responses', async () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'ready' } });
    const text = [
      ': keepalive', '', 'event: message', 'data: ' + notification, '',
      'data: ' + JSON.stringify({ ...initializeResult, id: 2 }), '',
      'data: {"jsonrpc":"2.0","id":1,', 'data: "result":' + JSON.stringify(initializeResult.result) + '}', '', ''
    ].join(eol);
    const bytes = new TextEncoder().encode(text);
    const stream = streamed(Array.from(bytes, byte => new Uint8Array([byte])), { 'content-type': 'text/event-stream' });
    const f = fixture(stream.response);
    assert.equal((await f.probe('https://fixture.invalid/mcp')).ok, true, JSON.stringify(eol));
    assert.equal(f.aborted(), true);
  }
});

test('finishes a successful SSE handshake without waiting for stream closure', async () => {
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(initializeResult) + '\n\n'));
      else throw new Error('probe read past its initialize result');
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const f = fixture(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal((await f.probe('https://fixture.invalid/mcp')).ok, true);
  assert.equal(pulls, 1);
  assert.equal(cancelled, true);
});

test('JSON result strings containing data markers are not treated as SSE', async () => {
  const body = { ...initializeResult, result: { ...initializeResult.result, instructions: 'Use data: fields.' } };
  assert.equal((await fixture(new Response(JSON.stringify(body))).probe('https://fixture.invalid/mcp')).ok, true);
});
