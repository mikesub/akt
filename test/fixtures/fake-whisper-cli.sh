#!/bin/sh
# A fake `whisper-cli` for the test suite: no model file is read, no audio is
# decoded and nothing takes an hour. The helper in test/helpers.js copies this
# script onto PATH under the real binary's name.
#
# Per call it appends `call.N` to $FAKE_WHISPER_DIR — line 1 the working
# directory, then the argv NUL-separated — and copies `output.json` to
# `<prefix>.json`, where <prefix> is the value that followed `-of`, the way
# `-oj` does. FAKE_WHISPER_SLEEP hangs before writing anything (so a killed
# call has produced no JSON), FAKE_WHISPER_SIGNAL kills this script with that
# signal the way the OOM killer would, FAKE_WHISPER_NO_JSON writes no JSON at
# all, FAKE_WHISPER_STDERR goes to stderr and FAKE_WHISPER_EXIT is the exit
# code.
set -u

dir=${FAKE_WHISPER_DIR:?FAKE_WHISPER_DIR is not set}

n=1
while [ -e "$dir/call.$n" ]; do
  n=$((n + 1))
done

record="$dir/call.$n"
pwd -P >"$record"
for arg in "$@"; do
  printf '%s\0' "$arg" >>"$record"
done

prefix=''
take=0
for arg in "$@"; do
  if [ "$take" = 1 ]; then
    prefix=$arg
    take=0
  elif [ "$arg" = '-of' ]; then
    take=1
  fi
done

if [ -n "${FAKE_WHISPER_STDERR-}" ]; then
  printf '%s\n' "$FAKE_WHISPER_STDERR" >&2
fi

# Death by a signal nobody asked for: the kernel OOM killer sends SIGKILL too,
# and it arrives long before the adapter's own timeout would.
if [ -n "${FAKE_WHISPER_SIGNAL-}" ]; then
  kill -"$FAKE_WHISPER_SIGNAL" $$
fi

# Redirected so an orphaned sleep cannot hold the stdout pipe open after the
# adapter kills this script at its timeout.
if [ -n "${FAKE_WHISPER_SLEEP-}" ]; then
  sleep "$FAKE_WHISPER_SLEEP" </dev/null >/dev/null 2>&1
fi

if [ -z "${FAKE_WHISPER_NO_JSON-}" ] && [ -n "$prefix" ] && [ -f "$dir/output.json" ]; then
  cat "$dir/output.json" >"$prefix.json"
fi

exit "${FAKE_WHISPER_EXIT:-0}"
