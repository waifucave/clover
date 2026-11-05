#!/usr/bin/env bash
# A minimal reproduction for an upstream report (iroh 1.4.1, relays off): the client's address
# changes under one open connection; how long until replies come back? The same network as
# migrate.sh, written out plainly, with and without a default route in the client's namespace:
# iroh tells QUIC about a network change only once a default route exists, waiting up to 5 s
# for one (socket.rs, PendingNetworkChangeNotify), and migrate.sh's namespaces have none.
#
#   sudo spikes/s1-transport/nat/iroh-address-change.sh <iroh_address_change binary> <out dir>
#
# Linux only, as root. Writes iroh-address-change.txt (one line per run) and, for the runs with
# RUST_LOG, the client's and server's iroh logs.

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

# run <seconds the client sends for> <route|noroute> [RUST_LOG]
run() {
  local SECS=$1 ROUTE=$2 LOGS=${3:-}
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
  if [ "$ROUTE" = route ]; then ip -n c route add default via 10.0.0.2 dev vc; fi
  ip netns exec c tc qdisc add dev vc root netem delay 10ms
  ip netns exec s tc qdisc add dev vs root netem delay 10ms

  local TMP SLOG=/dev/null CLOG=/dev/null
  TMP="$(mktemp -d)"
  if [ -n "$LOGS" ]; then
    SLOG="$OUT/iroh-address-change-${SECS}s-${ROUTE}-server.log"
    CLOG="$OUT/iroh-address-change-${SECS}s-${ROUTE}-client.log"
  fi
  ip netns exec s env RUST_LOG="$LOGS" "$BIN" serve 10.0.0.2:47000 >"$TMP/id" 2>"$SLOG" &
  local SERVER=$!
  for _ in $(seq 100); do [ -s "$TMP/id" ] && break; sleep 0.1; done
  ip netns exec c env RUST_LOG="$LOGS" "$BIN" ping 10.0.0.2:47000 "$(cat "$TMP/id")" "$SECS" >"$TMP/result" 2>"$CLOG" &
  local CLIENT=$!
  # Three seconds in, the client gets a new address and loses the old one; with a default route,
  # the route is put back at once, as a DHCP client would on a new network.
  sleep 3
  ip -n c addr add 10.0.0.3/24 dev vc
  ip -n c addr del 10.0.0.1/24 dev vc
  if [ "$ROUTE" = route ]; then ip -n c route replace default via 10.0.0.2 dev vc; fi
  wait "$CLIENT"
  kill "$SERVER" 2>/dev/null
  wait "$SERVER" 2>/dev/null
  echo "$ROUTE: $(cat "$TMP/result")${LOGS:+ (with RUST_LOG=$LOGS)}" | tee -a "$OUT/iroh-address-change.txt"
  rm -rf "$TMP"
}

# The change comes 3 s in.
run 16 noroute
run 30 noroute
run 16 noroute "iroh=debug,noq_proto=debug"
run 16 route
run 30 route
run 16 route "iroh=debug,noq_proto=debug"
