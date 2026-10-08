const assert = require('node:assert/strict');
const test = require('node:test');
const publicFetch = require('../scripts/public-fetch.cjs');
const validate = require(process.env.VALIDATOR_MODULE || '../scripts/validate-submission.cjs');

function fixture(t, lines, response = () => new Response('{"result":{}}')) {
  const probes = [], comments = [], labels = [], removals = [];
  const fetch = async url => { probes.push(url); return response(url); };
  t.mock.method(publicFetch, 'fetchPublic', fetch);
  t.mock.method(globalThis, 'fetch', fetch);
  const github = { rest: {
    pulls: { listFiles: async () => ({ data: [{ filename: 'README.md', patch: lines.map(line => '+' + line).join('\n') }] }) },
    issues: {
      addLabels: async item => labels.push(...item.labels), removeLabel: async item => removals.push(item.name),
      listComments: async () => ({ data: [] }), createComment: async item => comments.push(item.body),
    },
  } };
  return { run: () => validate({ github, context: { repo: { owner: 'test', repo: 'fixture' }, payload: { pull_request: { number: 1 } } } }),
    probes, comments, labels, removals };
}

function entry(number, name = `Fixture ${number}`, marks = '🔓', slug = `com.fixture/service${number}`) {
  return [`- [${name}](https://fixture.example) \`https://fixture-${number}.example/mcp\``,
    `  [![badge](https://glama.ai/mcp/connectors/${slug}/badges/score.svg)](https://glama.ai/mcp/connectors/${slug})`,
    `  ${marks} - Public fixture.`];
}

test('overflow performs no endpoint work and clears a stale success label', async t => {
  const f = fixture(t, Array.from({ length: 6 }, (_, i) => entry(i)).flat());
  await assert.rejects(f.run(), /at most five/);
  assert.equal(f.probes.length, 0);
  assert.ok(f.labels.includes('invalid-format'));
  assert.ok(f.removals.includes('endpoint-ok'));
});

test('five legitimate entries retain handshake, auth and badge checks', async t => {
  const f = fixture(t, Array.from({ length: 5 }, (_, i) => entry(i)).flat());
  await f.run();
  assert.equal(f.probes.length, 10);
  assert.ok(f.labels.includes('endpoint-ok'));
  assert.ok(f.labels.includes('has-connector'));
  assert.equal(f.comments.length, 0);
});

test('untrusted names, markers, endpoint errors and badge slugs cannot inject Markdown or HTML', async t => {
  const f = fixture(t, [
    ...entry(1, '`<img src=x>**name**', '🔑 [spoof](https://evil.example) @team', 'com.fixture/`<img>'),
    '- [`<script>**name**](https://fixture.example) `https://other.example/mcp`',
  ], url => {
    if (url.includes('other')) throw new Error('`[spoof](https://evil.example) <img> @team');
    return new Response('{"result":{}}');
  });
  await f.run();
  const output = f.comments.join('\n');
  for (const unsafe of ['<img', '<script', '**name**', '[spoof]', '@team', '`<img>']) assert.ok(!output.includes(unsafe), unsafe);
  assert.ok(output.includes('&#96;'));
  assert.equal(f.probes.some(url => url.includes('/`<img>')), false);
});
