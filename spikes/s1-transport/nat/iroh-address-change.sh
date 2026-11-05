#!/usr/bin/env bash
# A minimal reproduction for an upstream report (iroh 1.4.1, relays off): the client's address
# changes under one open connection; how long until replies come back, and does that depend on
# how long the client keeps sending? The same network as migrate.sh, written out plainly.
#
#   sudo spikes/s1-transport/nat/iroh-address-change.sh <iroh_address_change binary> <out dir>
#
# Linux only, as root. Writes iroh-address-change.txt (one line per run) and, for one run, the
# client's and server's iroh logs.

set -uo pipefail
BIN="$(readlink -f "$1")"
OUT="$(readlink -f "$2")"
mkdir -p "$OUT"
: >"$OUT/iroh-address-change.txt"

cleanup() {
  ip netns del c 2>/dev/null
  ip netns del s 2>/dev/null
  return 0
}
trap cleanup EXIT

# run <seconds the client sends for> [RUST_LOG]
run() {
  local SECS=$1 LOGS=${2:-}
  cleanup
  ip netns add c
  ip netns add s
  ip link add vc type veth peer name vs
  ip link set vc netns c
  ip link set vs netns s
  ip -n c link set lo up
  ip -n s link set lo up
  # Without promote_secondaries, deleting the client's first address also deletes the second.
  ip netns exec c sysctl -qw net.ipv4.conf.all.promote_secondaries=1 net.ipv4.conf.vc.promote_secondaries=1
  ip -n c addr add 10.0.0.1/24 dev vc
  ip -n s addr add 10.0.0.2/24 dev vs
  ip -n c link set vc up
  ip -n s link set vs up
  ip netns exec c tc qdisc add dev vc root netem delay 10ms
  ip netns exec s tc qdisc add dev vs root netem delay 10ms

  local TMP SLOG=/dev/null CLOG=/dev/null
  TMP="$(mktemp -d)"
  if [ -n "$LOGS" ]; then
    SLOG="$OUT/iroh-address-change-${SECS}s-server.log"
    CLOG="$OUT/iroh-address-change-${SECS}s-client.log"
  fi
  ip netns exec s env RUST_LOG="$LOGS" "$BIN" serve 10.0.0.2:47000 >"$TMP/id" 2>"$SLOG" &
  local SERVER=$!
  for _ in $(seq 100); do [ -s "$TMP/id" ] && break; sleep 0.1; done
  ip netns exec c env RUST_LOG="$LOGS" "$BIN" ping 10.0.0.2:47000 "$(cat "$TMP/id")" "$SECS" >"$TMP/result" 2>"$CLOG" &
  local CLIENT=$!
  # Three seconds in, the client gets a new address and loses the old one.
  sleep 3
  ip -n c addr add 10.0.0.3/24 dev vc
  ip -n c addr del 10.0.0.1/24 dev vc
  wait "$CLIENT"
  kill "$SERVER" 2>/dev/null
  wait "$SERVER" 2>/dev/null
  echo "$(cat "$TMP/result")${LOGS:+ (with RUST_LOG=$LOGS)}" | tee -a "$OUT/iroh-address-change.txt"
  rm -rf "$TMP"
}

# The change comes 3 s in. If replies come back a fixed time after it, the gap ends at the same
# moment whatever the client's sending time; if they come back only once the client stops, the
# gap ends after the sending does.
run 8
run 16
run 30
run 16 "iroh=debug,noq_proto=debug"
