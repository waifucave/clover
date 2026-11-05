#!/usr/bin/env bash
# S1, network changes: does a live connection survive the client's address changing (a Wi-Fi to
# mobile switch) or a blackout (sleep, a dead Wi-Fi), and how long are replies missing?
#
#   sudo spikes/s1-transport/nat/migrate.sh <clover-link-sidecar> <results.jsonl>
#
# Linux only, as root. Client namespace s1m1 and server namespace s1m2 on one veth pair with
# 10 ms of delay each way, and no NAT. The client sends a 64-byte echo every 50 ms without
# waiting (the sidecar's `ping`); the script breaks the path at a known time. Neither side
# reconnects the old connection: the result says whether it lived through the change, and the
# longest gap between replies. In the "+redial" scenarios the client also dials a fresh
# connection at the change or the wake and times its first echo (spec §8.3's "re-dial at once").
# With no NAT that is the re-dial's floor; behind NATs it also needs fresh STUN answers and the
# handshake (report, network changes).

set -uo pipefail
BIN="$(readlink -f "$1")"
OUT="$(readlink -f "$2")"
TRANSPORTS=(${TRANSPORTS:-quinn iroh})
: >"$OUT"

ns() { ip netns exec "$@"; }
cleanup() {
  ip netns del s1m1 2>/dev/null
  ip netns del s1m2 2>/dev/null
  return 0
}
trap cleanup EXIT

setup() {
  cleanup
  ip netns add s1m1
  ip netns add s1m2
  ns s1m1 ip link set lo up
  ns s1m2 ip link set lo up
  ip link add m1 type veth peer name m2
  ip link set m1 netns s1m1
  ip link set m2 netns s1m2
  # Without promote_secondaries, deleting the primary address also deletes .3 in new_address().
  ns s1m1 sysctl -qw net.ipv4.conf.all.promote_secondaries=1 net.ipv4.conf.m1.promote_secondaries=1
  ns s1m1 ip addr add 198.19.0.1/24 dev m1
  ns s1m2 ip addr add 198.19.0.2/24 dev m2
  ns s1m1 ip link set m1 up
  ns s1m2 ip link set m2 up
  link_ok
}

link_ok() {
  ns s1m1 tc qdisc replace dev m1 root netem delay 10ms
  ns s1m2 tc qdisc replace dev m2 root netem delay 10ms
}

blackout() {
  ns s1m1 tc qdisc replace dev m1 root netem delay 10ms loss 100%
  ns s1m2 tc qdisc replace dev m2 root netem delay 10ms loss 100%
}

new_address() {
  ns s1m1 ip addr add 198.19.0.3/24 dev m1
  ns s1m1 ip addr del 198.19.0.1/24 dev m1
  ns s1m1 ip -brief addr show dev m1 >&2
}

# The OS's network-change event, as clover-core would get it: the client calls network_changed().
signal_change() {
  touch "$TRIGGER"
}

# The re-dial clover-core would start on that event: a second, fresh connection.
redial_now() {
  touch "$REDIAL"
}

# scenario <name> <transport> <duration s> <grace s> <steps...>, each step "<at s>:<function>"
scenario() {
  local NAME=$1 TR=$2 DUR=$3 GRACE=$4
  shift 4
  setup
  local TMP
  TMP="$(mktemp -d)"
  ip netns exec s1m2 "$BIN" serve --transport "$TR" --bind 198.19.0.2:47000 --info-file "$TMP/info.json" >"$TMP/server.log" 2>&1 &
  local SERVER=$!
  for _ in $(seq 100); do [ -s "$TMP/info.json" ] && break; sleep 0.1; done
  TRIGGER="$TMP/network-changed"
  REDIAL="$TMP/redial"
  ip netns exec s1m1 "$BIN" ping --info-file "$TMP/info.json" --connect 198.19.0.2:47000 --duration-s "$DUR" --grace-s "$GRACE" \
    --rebind-trigger "$TRIGGER" --redial-trigger "$REDIAL" --label "$NAME" >"$TMP/client.log" 2>&1 &
  local CLIENT=$!
  local t=0
  for step in "$@"; do
    local at="${step%%:*}" fn="${step##*:}"
    sleep "$((at - t))"
    t="$at"
    "$fn"
  done
  wait "$CLIENT"
  kill "$SERVER" 2>/dev/null
  wait "$SERVER" 2>/dev/null
  local line
  line="$(grep '^S1RESULT ' "$TMP/client.log" | sed 's/^S1RESULT //')"
  [ -z "$line" ] && line="$(jq -cn --arg e "$(tail -c 400 "$TMP/client.log")" --arg t "$TR" --arg n "$NAME" '{check:"ping",ok:false,transport:$t,label:$n,error:$e}')"
  echo "$line" >>"$OUT"
  echo "$line" | jq -r '"\(.transport) \(.label): recovered=\(.recovered) received \(.received)/\(.sent), last reply at \(.lastReplyAtS) s, longest gap \(.maxGapMs) ms at \(.maxGapAtS) s \(if .redial then "; re-dial at \(.redial.atS) s: \(if .redial.ok then "first reply in \(.redial.firstReplyMs) ms" else "failed: \(.redial.error)" end)" else "" end) \(if .error then "error: \(.error)" else "" end)"'
  rm -rf "$TMP"
}

for TR in "${TRANSPORTS[@]}"; do
  # A new address with nobody telling the stack (long grace: does it heal by itself?), then with
  # the network-change call clover-core would make.
  scenario address-change "$TR" 8 25 3:new_address
  scenario address-change+signal "$TR" 8 5 3:new_address 3:signal_change
  # Wi-Fi to mobile: two seconds with no network, then a new address.
  scenario switch-2s-outage+signal "$TR" 10 8 3:blackout 5:new_address 5:link_ok 5:signal_change
  scenario blackout-5s "$TR" 12 10 3:blackout 8:link_ok
  scenario blackout-20s "$TR" 28 20 3:blackout 23:link_ok
  # Sleep and wake: the wake event is a network-change call too.
  scenario blackout-20s+signal "$TR" 28 12 3:blackout 23:link_ok 23:signal_change
  scenario blackout-40s "$TR" 48 12 3:blackout 43:link_ok
  # The same events with a fresh connection dialled at once (at the change, or at the wake).
  scenario address-change+redial "$TR" 8 10 3:new_address 3:redial_now
  scenario switch-2s-outage+redial "$TR" 10 8 3:blackout 5:new_address 5:link_ok 5:redial_now
  scenario blackout-20s+redial "$TR" 28 12 3:blackout 23:link_ok 23:redial_now
  scenario blackout-40s+redial "$TR" 48 12 3:blackout 43:link_ok 43:redial_now
done
echo "results in $OUT"
