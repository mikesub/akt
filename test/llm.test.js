import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import test from 'node:test';
import { UsageError } from '../src/errors.js';
import { createLlm, LlmAuthError, LlmError, LlmValidationError, llmFromEnv } from '../src/llm.js';
import { fakeLlm, tempDir } from './helpers.js';

const GUID = '6da6dd1e-7c3e-4116-9038-49ad0d0b9ef1';

/** The smallest schema with a type, a required key and a closed shape. */
const OK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};

function recorder() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

/** An adapter wired to a fake CLI, with the log it writes to. */
function adapter(fake, { cli = 'claude', timeoutMs, env = {} } = {}) {
  const { lines, log } = recorder();
  const llm = createLlm({ cli, timeoutMs, env: { ...process.env, ...fake.env, ...env }, log });
  return { llm, lines };
}

function callWith(llm, prompt, schema = OK_SCHEMA) {
  return llm.call({ step: 'parse', guid: GUID, prompt, schema });
}

test('the claude invocation is sandboxed, schema-bearing and passes the env through', async (t) => {
  const fake = fakeLlm(t, { replies: ['{"ok": true}'] });
  const { llm, lines } = adapter(fake, { env: { ANTHROPIC_API_KEY: 'sk-fake-key' } });

  assert.equal(llm.cli, 'claude');
  assert.deepEqual(await callWith(llm, 'Repair these entries'), { ok: true });

  const calls = fake.calls();
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.deepEqual(call.argv.slice(0, -1), [
    '-p',
    '--output-format',
    'json',
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
  ]);
  assert.match(call.prompt, /^Repair these entries\n\n/);
  assert.ok(
    call.prompt.includes(JSON.stringify(OK_SCHEMA, null, 2)),
    'the schema the caller supplied is embedded in the prompt',
  );
  assert.equal(call.apiKey, 'sk-fake-key', 'ANTHROPIC_API_KEY reaches the child unchanged');

  assert.match(basename(call.cwd), /^akt-llm-/);
  assert.equal(realpathSync(dirname(call.cwd)), realpathSync(tmpdir()));
  assert.equal(call.entries, 0, 'the CLI runs in an empty directory, so it sees no AGENTS.md');
  assert.notEqual(call.cwd, realpathSync(process.cwd()));
  assert.equal(existsSync(call.cwd), false, 'the sandbox directory is removed after the call');

  assert.equal(lines.length, 1, 'exactly one log line per call');
  assert.match(
    lines[0],
    new RegExp(`^${GUID}: llm parse claude ok \\(1 attempts?, \\d+(\\.\\d+)?s\\)$`),
  );
});

test('the codex invocation is sandboxed the way codex spells it', async (t) => {
  const fake = fakeLlm(t, { cli: 'codex', replies: ['{"ok": false}'] });
  const { llm } = adapter(fake, { cli: 'codex' });

  assert.equal(llm.cli, 'codex');
  assert.deepEqual(await callWith(llm, 'Repair these entries'), { ok: false });

  const [call] = fake.calls();
  assert.deepEqual(call.argv.slice(0, -1), [
    'exec',
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '-c',
    'features.shell_tool=false',
  ]);
  assert.match(call.prompt, /^Repair these entries\n\n/);
  assert.equal(call.entries, 0);
  assert.equal(existsSync(call.cwd), false);
});

test('the payload survives the CLI envelope, a code fence and surrounding prose', async (t) => {
  const fenced = fakeLlm(t, { replies: ['```json\n{"ok": true}\n```'] });
  assert.deepEqual(await callWith(adapter(fenced).llm, 'Repair'), { ok: true });

  const chatty = fakeLlm(t, {
    cli: 'codex',
    replies: ['Here is the JSON you asked for:\n{"ok": true}\nHope that helps.'],
  });
  const { llm } = adapter(chatty, { cli: 'codex' });
  assert.deepEqual(await callWith(llm, 'Repair'), { ok: true });
});

test('an invalid reply is retried with the validation error appended', async (t) => {
  const fake = fakeLlm(t, { replies: ['{"ok": "yes"}', '{"ok": true}'] });
  const { llm, lines } = adapter(fake);

  assert.deepEqual(await callWith(llm, 'Repair these entries'), { ok: true });

  const calls = fake.calls();
  assert.equal(calls.length, 2, 'a rejected reply is asked again');
  assert.match(calls[0].prompt, /^Repair these entries\n\n/);
  assert.ok(!calls[0].prompt.includes('rejected'), 'the first attempt carries no complaint');
  assert.match(calls[1].prompt, /^Repair these entries\n\n/);
  assert.match(calls[1].prompt, /Your previous reply was rejected:/);
  assert.ok(calls[1].prompt.includes('/ok'), 'the retry names the field that failed');

  assert.equal(lines.length, 1, 'a retried call is still one call in the log');
  assert.match(lines[0], /llm parse claude ok \(2 attempts?, \d+(\.\d+)?s\)$/);
  assert.deepEqual(llm.stats(), {
    cli: 'claude',
    steps: { parse: { calls: 1, ok: 1, failed: 0, skipped: 0 } },
  });
  assert.equal(llm.summary(), 'llm claude: parse fired 1 times (ok 1, failed 0, skipped 0)');
});

test('three invalid replies raise LlmValidationError with the raw stdout retained', async (t) => {
  const fake = fakeLlm(t, { replies: ['{"ok": 1}', '{"ok": 2}', '{"ok": "marker-three"}'] });
  const { llm, lines } = adapter(fake);

  await assert.rejects(
    () => callWith(llm, 'Repair'),
    (err) => {
      assert.ok(err instanceof LlmValidationError, 'a bad payload is a validation failure');
      assert.ok(err instanceof LlmError, 'every adapter failure is an LlmError');
      assert.equal(err.attempts, 3);
      assert.ok(Array.isArray(err.errors) && err.errors.length > 0);
      assert.match(err.raw, /marker-three/, 'the last raw stdout is kept for debugging');
      assert.ok(err.message.trimEnd().endsWith(err.raw.trimEnd()));
      return true;
    },
  );

  assert.equal(fake.calls().length, 3, 'three attempts in total, then it gives up');
  assert.match(lines[0], /llm parse claude invalid \(3 attempts?, /);
  assert.deepEqual(llm.stats().steps.parse, { calls: 1, ok: 0, failed: 1, skipped: 0 });
});

test('a CLI missing from PATH is an auth failure, not a model error', async (t) => {
  const empty = tempDir(t);
  const { lines, log } = recorder();
  const llm = createLlm({ cli: 'claude', env: { ...process.env, PATH: empty }, log });

  await assert.rejects(
    () => callWith(llm, 'Repair'),
    (err) => {
      assert.ok(err instanceof LlmAuthError, 'a missing binary is not a per-episode problem');
      assert.ok(err instanceof LlmError);
      return true;
    },
  );
  assert.match(lines[0], /llm parse claude auth/);
});

test('a not-logged-in CLI aborts the rest of the run without spawning again', async (t) => {
  const fake = fakeLlm(t, {
    replies: ['{"ok": true}'],
    exit: 1,
    stderr: 'Not logged in. Please run /login.',
  });
  const { llm, lines } = adapter(fake);

  await assert.rejects(() => callWith(llm, 'Repair'), LlmAuthError);
  assert.equal(fake.calls().length, 1, 'an auth failure is never retried');
  assert.match(lines[0], /llm parse claude auth/);

  await assert.rejects(
    () => callWith(llm, 'Repair again'),
    (err) => {
      assert.ok(err instanceof LlmAuthError);
      assert.match(err.message, /disabled for the rest of this run/);
      assert.match(err.message, /not logged in/i, 'the original failure is named');
      return true;
    },
  );
  assert.equal(fake.calls().length, 1, 'the latched adapter spawns nothing at all');
  assert.match(lines[1], /llm parse claude skipped/);
  assert.match(llm.summary(), /skipped 1\)/);
});

test('an is_error envelope naming the credentials is an auth failure', async (t) => {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'Invalid API key · Please run /login',
  });
  const fake = fakeLlm(t, { replies: [envelope], wrap: false });
  const { llm } = adapter(fake);

  await assert.rejects(() => callWith(llm, 'Repair'), LlmAuthError);
  assert.equal(fake.calls().length, 1);
});

test('a non-zero exit that is not an auth problem is a plain LlmError', async (t) => {
  const fake = fakeLlm(t, { exit: 2, stderr: 'the model is overloaded' });
  const { llm, lines } = adapter(fake);

  await assert.rejects(
    () => callWith(llm, 'Repair'),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.ok(!(err instanceof LlmAuthError), 'a model error must not abort the run');
      assert.ok(!(err instanceof LlmValidationError));
      assert.equal(err.cli, 'claude');
      assert.equal(err.exitCode, 2);
      assert.match(err.stderr, /the model is overloaded/);
      return true;
    },
  );
  assert.equal(fake.calls().length, 1);
  assert.match(lines[0], /llm parse claude error/);

  // The failure belongs to that episode, not the run: the next call still runs.
  await assert.rejects(() => callWith(llm, 'Repair'), LlmError);
  assert.equal(fake.calls().length, 2);
});

test('a hung CLI is killed at the timeout instead of stalling the run', async (t) => {
  const fake = fakeLlm(t, { replies: ['{"ok": true}'], sleep: 5 });
  const { llm, lines } = adapter(fake, { timeoutMs: 1000 });

  const started = Date.now();
  await assert.rejects(
    () => callWith(llm, 'Repair'),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.match(err.message, /timed out after \d+s/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 4000, 'the call is killed, not waited out');
  assert.equal(fake.calls().length, 1, 'a timeout is not retried');
  assert.match(lines[0], /llm parse claude timeout/);
});

test('llmFromEnv defaults to claude and refuses anything it does not know', () => {
  const { log } = recorder();
  assert.equal(llmFromEnv({}, log).cli, 'claude');
  assert.equal(llmFromEnv({ LLM_CLI: 'claude' }, log).cli, 'claude');
  assert.equal(llmFromEnv({ LLM_CLI: 'codex' }, log).cli, 'codex');
  assert.equal(llmFromEnv({ LLM_TIMEOUT: '30' }, log).cli, 'claude');

  for (const env of [{ LLM_CLI: 'gpt' }, { LLM_CLI: 'claude-code' }]) {
    assert.throws(
      () => llmFromEnv(env, log),
      UsageError,
      `expected UsageError for ${JSON.stringify(env)}`,
    );
  }
  for (const LLM_TIMEOUT of ['0', '-5', '1.5', 'soon']) {
    assert.throws(
      () => llmFromEnv({ LLM_TIMEOUT }, log),
      UsageError,
      `expected UsageError for LLM_TIMEOUT=${LLM_TIMEOUT}`,
    );
  }
});

test('LLM_TIMEOUT is read as whole seconds and bounds the call', async (t) => {
  const fake = fakeLlm(t, { replies: ['{"ok": true}'], sleep: 5 });
  const { lines, log } = recorder();
  const llm = llmFromEnv({ ...process.env, ...fake.env, LLM_TIMEOUT: '1' }, log);

  await assert.rejects(() => callWith(llm, 'Repair'), /timed out after 1s/);
  assert.match(lines[0], /llm parse claude timeout/);
});

test('an adapter that made no call says so', () => {
  const { log } = recorder();
  const llm = createLlm({ cli: 'claude', log });
  assert.deepEqual(llm.stats(), { cli: 'claude', steps: {} });
  assert.equal(llm.summary(), 'llm claude: no calls');
});
