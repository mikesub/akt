#!/bin/sh
# A fake `claude` / `codex` for the test suite: no network, no login, and one
# recorded file per call. The helper in test/helpers.js copies this script onto
# PATH under both names, so one fake covers both CLIs.
#
# Per call it appends `call.N` to $FAKE_LLM_DIR — line 1 the working directory,
# line 2 how many entries that directory holds, line 3 $ANTHROPIC_API_KEY, then
# the argv NUL-separated — and prints `stdout.N` if that file exists, else
# `stdout`. FAKE_LLM_SLEEP hangs before replying (so a killed call has written
# nothing), FAKE_LLM_STDERR goes to stderr and FAKE_LLM_EXIT is the exit code.
set -u

dir=${FAKE_LLM_DIR:?FAKE_LLM_DIR is not set}

n=1
while [ -e "$dir/call.$n" ]; do
  n=$((n + 1))
done

record="$dir/call.$n"
{
  pwd -P
  ls -A | wc -l | tr -d ' '
  printf '%s\n' "${ANTHROPIC_API_KEY-}"
} >"$record"
for arg in "$@"; do
  printf '%s\0' "$arg" >>"$record"
done

# Redirected so an orphaned sleep cannot hold the stdout pipe open after the
# adapter kills this script at its timeout.
if [ -n "${FAKE_LLM_SLEEP-}" ]; then
  sleep "$FAKE_LLM_SLEEP" </dev/null >/dev/null 2>&1
fi

if [ -f "$dir/stdout.$n" ]; then
  cat "$dir/stdout.$n"
elif [ -f "$dir/stdout" ]; then
  cat "$dir/stdout"
fi

if [ -n "${FAKE_LLM_STDERR-}" ]; then
  printf '%s\n' "$FAKE_LLM_STDERR" >&2
fi

exit "${FAKE_LLM_EXIT:-0}"
