module.exports = async function validateSubmission({ github, context }) {
const { fetchPublic } = require('./public-fetch.cjs');
// HTML-encoded code elements cannot be escaped by contributor Markdown.
const code = value => '<code>' + Array.from(String(value).replace(/[\x00-\x1f\x7f]/g, ' '),
  char => /[\p{L}\p{N} ]/u.test(char) ? char : `&#${char.codePointAt(0)};`).join('') + '</code>';
const fs = require('fs');
const { owner, repo } = context.repo;
const issue_number = context.payload.pull_request.number;

const readme = fs.readFileSync('README.md', 'utf8');
const existingEndpoints = new Set(
  [...readme.matchAll(/`(https:\/\/[^`\s]+)`/g)].map(m => m[1].replace(/\/+$/, '').toLowerCase())
);

const { data: files } = await github.rest.pulls.listFiles({
  owner, repo, pull_number: issue_number, per_page: 100,
});

const addedLines = files
  .filter(f => f.filename === 'README.md' && f.patch)
  .flatMap(f => f.patch.split('\n'))
  .filter(l => l.startsWith('+') && !l.startsWith('+++'))
  .map(l => l.slice(1));

// Reassemble multi-line entries from the diff
const HEAD = /^-\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s+`(https?:\/\/[^`\s]+)`\s*$/;
const BADGE = /^\s+\[!\[[^\]]*\]\(https:\/\/glama\.ai\/mcp\/connectors\/([^/)\s]+\/[^/)\s]+)\/badges\/score\.svg\)\]\(([^)\s]+)\)\s*$/;
const MARKS = /^\s+([🔓🔑🔐][\s\S]*?)\s+-\s+(\S.*)$/u;

const entries = [];
for (const line of addedLines) {
  const h = line.match(HEAD);
  if (h) { entries.push({ name: h[1], home: h[2], endpoint: h[3], badge: null, marks: null, desc: null }); continue; }
  const cur = entries[entries.length - 1];
  if (!cur) continue;
  const b = line.match(BADGE);
  if (b) { cur.badge = b[1]; continue; }
  const m = line.match(MARKS);
  if (m) { cur.marks = m[1].trim(); cur.desc = m[2].trim(); }
}

// Only look at entries whose endpoint is not already listed
const fresh = entries.filter(e => !existingEndpoints.has(e.endpoint.replace(/\/+$/, '').toLowerCase()));
const duplicates = entries.filter(e => existingEndpoints.has(e.endpoint.replace(/\/+$/, '').toLowerCase()));

// Bound the whole submission before any untrusted endpoint is contacted.
// Five entries permit at most ten 20-second probes, plus bounded GitHub calls.
if (entries.length > 5) {
  await github.rest.issues.removeLabel({ owner, repo, issue_number, name: 'endpoint-ok' }).catch(() => {});
  await github.rest.issues.addLabels({ owner, repo, issue_number, labels: ['invalid-format'] });
  throw new Error('Submit at most five entries per pull request; no endpoints were probed.');
}

const AUTH = ['🔓', '🔑', '🔐'];

const formatProblems = [];
for (const e of fresh) {
  if (!e.marks || !e.desc) {
    formatProblems.push(`${code(e.name)} – missing the marker/description line (\`  🔐 - What it does.\`)`);
    continue;
  }
  if (!AUTH.some(a => e.marks.includes(a))) {
    formatProblems.push(`${code(e.name)} – needs an auth marker (🔓 none, 🔑 API key, or 🔐 OAuth)`);
  }
  const unknown = [...e.marks].filter(ch =>
    /\p{Extended_Pictographic}/u.test(ch) &&
    !AUTH.some(k => k.includes(ch))
  );
  if (unknown.length) {
    formatProblems.push(`${code(e.name)} – unrecognized marker(s): ${code(unknown.join(' '))}`);
  }
  if (!/\.$/.test(e.desc)) {
    formatProblems.push(`${code(e.name)} – description should end with a period`);
  }
}

// Probe each endpoint with a real MCP initialize handshake.
// No credentials are sent; only the response shape is inspected.
const initBody = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'awesome-remote-mcp-servers-ci', version: '1.0.0' },
  },
});

function isInitializeResponse(text) {
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  return object(value) && value.jsonrpc === '2.0' && value.id === 1 &&
    !Object.hasOwn(value, 'error') && object(value.result) &&
    nonempty(value.result.protocolVersion) && object(value.result.capabilities) &&
    object(value.result.serverInfo) && nonempty(value.result.serverInfo.name) &&
    nonempty(value.result.serverInfo.version);
}

async function probe(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let reader;
  try {
    const res = await fetchPublic(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        'User-Agent': 'awesome-remote-mcp-servers-ci/1.0',
      },
      body: initBody,
      redirect: 'follow',
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      const wa = res.headers.get('www-authenticate') || '';
      return { ok: true, auth: /resource_metadata|Bearer/i.test(wa) ? '🔐' : '🔑', status: res.status };
    }
    const failed = () => ({ ok: false, status: res.status, why: `no initialize result (HTTP ${res.status})` });
    if (res.status < 200 || res.status >= 300) return failed();
    // Bound bytes as they arrive, including chunked/decompressed responses.
    const maxBytes = 20000;
    const contentLength = res.headers.get('content-length');
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
      throw new Error('initialize response exceeds 20000 bytes');
    }
    const decoder = new TextDecoder();
    const isSse = /^text\/event-stream(?:\s*;|$)/i.test(res.headers.get('content-type') || '');
    const chunks = [];
    let byteLength = 0, line = '', data = [], skipLf = false;
    // Dispatch one SSE event at a time. A notification is not the response, and
    // a matching response need not wait for the server to close its stream.
    const consumeSse = text => {
      for (const char of text) {
        if (skipLf) { skipLf = false; if (char === '\n') continue; }
        if (char !== '\r' && char !== '\n') { line += char; continue; }
        skipLf = char === '\r';
        if (line === '') {
          const initialized = data.length > 0 && isInitializeResponse(data.join('\n'));
          data = [];
          if (initialized) return true;
        } else if (line === 'data' || line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
        line = '';
      }
      return false;
    };
    if (res.body) {
      reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maxBytes) throw new Error('initialize response exceeds 20000 bytes');
        const text = decoder.decode(value, { stream: true });
        if (isSse) {
          if (consumeSse(text)) return { ok: true, auth: '🔓', status: res.status };
        } else chunks.push(text);
      }
    }
    const tail = decoder.decode();
    const initialized = isSse ? consumeSse(tail) : isInitializeResponse(chunks.join('') + tail);
    return initialized ? { ok: true, auth: '🔓', status: res.status } : failed();
  } catch (err) {
    return { ok: false, why: String(err.message || err).slice(0, 120) };
  } finally {
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    clearTimeout(timeout);
  }
}

async function connectorExists(slug) {
  let res;
  try {
    if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(slug)) return false;
    res = await fetchPublic(`https://glama.ai/mcp/connectors/${slug}`, {
      method: 'GET',
      headers: { 'User-Agent': 'awesome-remote-mcp-servers-ci/1.0' },
      signal: AbortSignal.timeout(20000),
    });
    return res.status === 200;
  } catch { return false; }
  finally { if (res?.body) await res.body.cancel().catch(() => {}); }
}

const unreachable = [];
const authMismatch = [];
const badBadges = [];

for (const e of fresh) {
  const r = await probe(e.endpoint);
  if (!r.ok) {
    unreachable.push(`${code(e.endpoint)} – ${code(r.why)}`);
  } else if (e.marks && !e.marks.includes(r.auth)) {
    authMismatch.push(`${code(e.endpoint)} – responded with ${r.auth}, entry says ${code(e.marks)}`);
  }
  if (e.badge && !(await connectorExists(e.badge))) {
    badBadges.push(`${code(e.badge)} – no such connector on Glama`);
  }
}

const hasConnector = fresh.length > 0 && fresh.every(e => e.badge);
const endpointOk = unreachable.length === 0;
const formatOk = formatProblems.length === 0 && badBadges.length === 0;

const add = [], remove = [];
(endpointOk ? add : remove).push('endpoint-ok');
(endpointOk ? remove : add).push('endpoint-unreachable');
(hasConnector ? add : remove).push('has-connector');
(hasConnector ? remove : add).push('missing-connector');
(formatOk ? remove : add).push('invalid-format');
(duplicates.length ? add : remove).push('duplicate');

if (add.length) {
  await github.rest.issues.addLabels({ owner, repo, issue_number, labels: add });
}
for (const name of remove) {
  try { await github.rest.issues.removeLabel({ owner, repo, issue_number, name }); } catch {}
}

const { data: comments } = await github.rest.issues.listComments({
  owner, repo, issue_number, per_page: 100,
});
const say = async (marker, body) => {
  if (comments.some(c => c.body.includes(marker))) return;
  await github.rest.issues.createComment({ owner, repo, issue_number, body: `${marker}\n${body}` });
};

if (unreachable.length) {
  await say('<!-- endpoint-check -->', `We could not complete an MCP \`initialize\` handshake against:

${unreachable.map(u => `- ${u}`).join('\n')}

Only servers that answer a handshake are listed. If the endpoint needs an account, it should still return \`401\` with a \`WWW-Authenticate\` header — a timeout or \`404\` means the URL is wrong.`);
}

if (authMismatch.length) {
  await say('<!-- auth-check -->', `The auth marker does not match what the endpoint returned:

${authMismatch.map(u => `- ${u}`).join('\n')}

Please correct the marker: 🔓 none, 🔑 API key, 🔐 OAuth.`);
}

if (formatProblems.length) {
  await say('<!-- format-check -->', `Please fix the entry format:

${formatProblems.map(u => `- ${u}`).join('\n')}

Expected shape:

\`\`\`markdown
- [Name](https://homepage.example) \\\`https://mcp.example.com/mcp\\\`
  [![Name MCP connector](https://glama.ai/mcp/connectors/com.example/name/badges/score.svg)](https://glama.ai/mcp/connectors/com.example/name)
  🔐 - One sentence describing what the tools do.
\`\`\`

See [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).`);
}

if (badBadges.length) {
  await say('<!-- badge-check -->', `These connector badges do not resolve:

${badBadges.map(u => `- ${u}`).join('\n')}

The slug is the reverse-DNS identifier from your connector's URL on [glama.ai/mcp/connectors](https://glama.ai/mcp/connectors), e.g. \`io.tseha/tseha\`.`);
}

if (!hasConnector && fresh.length > 0) {
  await say('<!-- connector-check -->', `Your entry is missing its [Glama connector](https://glama.ai/mcp/connectors) badge. Every entry needs one — it shows tool definition quality and endpoint health, so readers can tell a maintained server from an abandoned one.

List your server at [glama.ai/mcp/connectors](https://glama.ai/mcp/connectors) if it is not there yet, then add the badge as the second line of your entry:

\`\`\`markdown
[![NAME MCP connector](https://glama.ai/mcp/connectors/NAMESPACE/NAME/badges/score.svg)](https://glama.ai/mcp/connectors/NAMESPACE/NAME)
\`\`\`

PRs without a badge are not merged. Questions welcome here or on [Discord](https://glama.ai/mcp/discord).`);
}

if (duplicates.length) {
  await say('<!-- duplicate-check -->', `These endpoints are already listed:

${duplicates.map(e => `- ${code(e.endpoint)}`).join('\n')}

Please remove the duplicate entries.`);
}

};
