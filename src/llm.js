import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const TIMEOUT_MS = 300_000;

/**
 * The one place that spawns an LLM: the local `claude` CLI in print mode,
 * with no tools and no MCP servers, in an empty temp directory so it never
 * sees this repo. `--json-schema` has the CLI enforce the reply's shape, so
 * what comes back is already valid.
 */
export async function askClaude(prompt, schema) {
  const args = [
    '-p',
    '--model',
    'claude-opus-5-5',
    '--effort',
    'high',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    prompt,
  ];
  const dir = mkdtempSync(join(tmpdir(), 'akt-llm-'));
  let stdout;
  try {
    const call = promisify(execFile)('claude', args, {
      cwd: dir,
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    call.child.stdin.end();
    ({ stdout } = await call);
  } catch (err) {
    if (err.killed) throw new Error(`claude timed out after ${TIMEOUT_MS / 1000}s`);
    throw new Error(`claude failed: ${(err.stderr || err.stdout || err.message).trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const reply = JSON.parse(stdout);
  if (reply.is_error || reply.structured_output == null) {
    throw new Error(`claude gave no structured reply: ${reply.result}`);
  }
  return reply.structured_output;
}
