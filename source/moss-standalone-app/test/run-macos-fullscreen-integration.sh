#!/bin/bash
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "MAC_FULLSCREEN_INTEGRATION_SKIP"
  exit 0
fi

test_dir="$(mktemp -d /tmp/moss-fullscreen-integration.XXXXXX)"
pet_pid=""
host_pid=""

cleanup() {
  if [ -n "$host_pid" ]; then kill "$host_pid" 2>/dev/null || true; fi
  if [ -n "$pet_pid" ]; then kill "$pet_pid" 2>/dev/null || true; fi
  /usr/bin/trash "$test_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

./node_modules/.bin/electron test/macos-fullscreen-pet.cjs "$test_dir/pet.ready" >"$test_dir/pet.log" 2>&1 &
pet_pid=$!
for _ in {1..50}; do
  [ -f "$test_dir/pet.ready" ] && break
  sleep 0.1
done
[ -f "$test_dir/pet.ready" ]

./node_modules/.bin/electron test/macos-fullscreen-host.cjs "$test_dir/host.ready" >"$test_dir/host.log" 2>&1 &
host_pid=$!
for _ in {1..100}; do
  [ -f "$test_dir/host.ready" ] && break
  sleep 0.1
done
[ -f "$test_dir/host.ready" ]

sleep 1
screencapture -x "$test_dir/screen.png"
./node_modules/.bin/electron test/macos-fullscreen-pixel-check.cjs "$test_dir/screen.png"
