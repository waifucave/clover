#!/usr/bin/env bash
# S1 question 4: delay and throughput on one link, under tc netem delay, loss and a rate limit.
#
#   sudo spikes/s1-transport/nat/netem.sh <clover-link-sidecar> <bun> <results.jsonl>
#
# Linux only, as root. Two namespaces joined by one veth pair, netem on both egresses, so each
# direction gets the delay, loss and rate below. Every implementation runs the same bench
# (spikes/s1-transport/README.md): small RPCs, one stream per RPC, a bulk transfer, 1 MB
# "screenshots", and RPC delay while a bulk transfer runs at lower priority on the same link.

set -uo pipefail
BIN="$(readlink -f "$1")"
BUN="$2"
OUT="$(readlink -f "$3")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SPIKE="$ROOT/spikes/s1-transport/bun"
: >"$OUT"

# name:one-way delay ms:loss %:rate:bulk MB:load MB
PROFILES=(${PROFILES:-lan:1:0:1000mbit:64:32 wan:20:0.1:100mbit:32:16 lossy:40:1:50mbit:16:8 far:75:0.5:50mbit:16:8})
IMPLS=(${IMPLS:-quinn:cubic quinn:bbr iroh:cubic iroh:bbr iroh-napi:default})

if ! modprobe sch_netem 2>/dev/null; then
  echo "loading sch_netem needs linux-modules-extra; installing it"
  apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null && modprobe sch_netem
fi

ns() { ip netns exec "$@"; }
cleanup() {
  ip netns del s1n1 2>/dev/null
  ip netns del s1n2 2>/dev/null
  return 0
}
trap cleanup EXIT
cleanup
ip netns add s1n1
ip netns add s1n2
ns s1n1 ip link set lo up
ns s1n2 ip link set lo up
ip link add n1 type veth peer name n2
ip link set n1 netns s1n1
ip link set n2 netns s1n2
ns s1n1 ip addr add 198.18.0.1/24 dev n1
ns s1n2 ip addr add 198.18.0.2/24 dev n2
ns s1n1 ip link set n1 up
ns s1n2 ip link set n2 up
# Large socket buffers, as a desktop would have; the defaults on a CI runner are small.
for n in s1n1 s1n2; do
  ns "$n" sysctl -qw net.core.rmem_max=8388608 net.core.wmem_max=8388608 2>/dev/null
done

for prof in "${PROFILES[@]}"; do
  IFS=: read -r NAME DELAY LOSS RATE BULK LOAD <<<"$prof"
  for dev in s1n1:n1 s1n2:n2; do
    ns "${dev%%:*}" tc qdisc replace dev "${dev##*:}" root netem delay "${DELAY}ms" loss "${LOSS}%" rate "$RATE"
  done
  echo "profile $NAME: ${DELAY} ms each way, ${LOSS}% loss, $RATE"
  SIZES=(--rpc 300 --rpc-streams 50 --bulk-mb "$BULK" --shots 10 --load-mb "$LOAD")
  for impl in "${IMPLS[@]}"; do
    KIND="${impl%%:*}"
    CC="${impl##*:}"
    TMP="$(mktemp -d)"
    if [ "$KIND" = iroh-napi ]; then
      (cd "$SPIKE" && exec ip netns exec s1n2 "$BUN" src/iroh-napi.ts --serve --bind 198.18.0.2:47000 \
        --advertise 198.18.0.2:47000 --ticket-file "$TMP/ticket") >"$TMP/server.log" 2>&1 &
      SERVER=$!
      for _ in $(seq 100); do [ -s "$TMP/ticket" ] && break; sleep 0.1; done
      (cd "$SPIKE" && timeout 300 ip netns exec s1n1 "$BUN" src/iroh-napi.ts --dial-ticket-file "$TMP/ticket" \
        --profile "$NAME" "${SIZES[@]}") >"$TMP/client.log" 2>&1
    else
      ip netns exec s1n2 "$BIN" serve --transport "$KIND" --cc "$CC" --bind 198.18.0.2:47000 --info-file "$TMP/info.json" \
        >"$TMP/server.log" 2>&1 &
      SERVER=$!
      for _ in $(seq 100); do [ -s "$TMP/info.json" ] && break; sleep 0.1; done
      timeout 300 ip netns exec s1n1 "$BIN" bench --info-file "$TMP/info.json" --connect 198.18.0.2:47000 \
        --cc "$CC" --profile "$NAME" "${SIZES[@]}" >"$TMP/client.log" 2>&1
    fi
    kill "$SERVER" 2>/dev/null
    wait "$SERVER" 2>/dev/null
    line="$(grep '^S1RESULT ' "$TMP/client.log" | sed 's/^S1RESULT //')"
    if [ -z "$line" ]; then
      line="$(jq -cn --arg e "$(tail -c 600 "$TMP/client.log")" --arg k "$KIND" '{check:("netem-" + $k),ok:false,error:$e}')"
    fi
    echo "$line" | jq -c --arg p "$NAME" --arg i "$KIND" --arg c "$CC" \
      --arg d "$DELAY" --arg l "$LOSS" --arg r "$RATE" \
      '. + {profile:$p, impl:$i, cc:$c, netem:{oneWayDelayMs:($d|tonumber), lossPct:($l|tonumber), rate:$r}}' >>"$OUT"
    echo "$line" | jq -r --arg i "$KIND/$CC" \
      'if .ok then "  \($i): rpc p50 \(.rpcStream.p50) ms, bulk \(.bulk.MBps) MB/s, under load p50 \(.rpcUnderLoad_prioritised.p50) p99 \(.rpcUnderLoad_prioritised.p99) ms" else "  \($i): FAILED \(.error)" end'
    rm -rf "$TMP"
  done
done
echo "results in $OUT"
