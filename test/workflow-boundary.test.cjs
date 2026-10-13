const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('privileged submission jobs use immutable actions and trusted base code', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/check-submission.yml'), 'utf8');
  const actions = [...workflow.matchAll(/^\s+uses:\s+(\S+)/gm)].map(match => match[1]);
  assert.ok(actions.length > 0, 'No action references were inspected');
  for (const action of actions) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[a-f\d]{40}$/i, 'Write-capable jobs must not execute mutable action tags');
  }
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\./);
});

test('candidate boundary checks run without privileged tokens or installs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(workflow, /pull_request_target|:\s*write\b|permissions:\s*write-all|secrets\./);
  assert.match(workflow, /run:\s*node --test test\/\*\.test\.cjs/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /npm\s+(?:install|ci)|persist-credentials:\s*true/);
  for (const [, action] of workflow.matchAll(/^\s+-\s+uses:\s+(\S+)/gm)) {
    assert.match(action, /^[\w.-]+\/[\w.-]+@[a-f\d]{40}$/i);
  }
});
