#!/usr/bin/env bash
# S1 question 3: which NAT pairs connect directly with no relay.
#
#   sudo spikes/s1-transport/nat/matrix.sh <clover-link-sidecar> <results.jsonl>
#
# Linux only, as root. Builds a small internet out of network namespaces:
#
#   s1pa ─ s1ra ─┐                          ┌─ s1rb ─ s1pb      peers behind their routers
#                ├─ s1inet (bridge br0, 203.0.113.0/24) ─┤
#   s1stun ──────┘                          └───────────       STUN at 203.0.113.100:3478
#
# Each router is an iptables NAT of one type (RFC 4787 terms):
#   public           no NAT: the peer sits on the bridge with a public address
#   full             endpoint-independent mapping and filtering (full cone)
#   restricted       endpoint-independent mapping, address-dependent filtering (xt_recent)
#   port-restricted  endpoint-independent mapping, address-and-port-dependent filtering
#                    (Linux's default SNAT with conntrack; the usual home router)
#   symmetric        address-and-port-dependent mapping (SNAT --random): a new port per destination
# plus `lan`: both peers on one LAN behind one port-restricted router (the same-Wi-Fi case).
#
# Routers drop unsolicited UDP silently instead of answering ICMP, as most home routers do.
# Each pair gets fresh namespaces, so no conntrack state carries over. The two peers exchange
# addresses through a shared folder (the waifucave handshake's job) and use no relay.

set -uo pipefail
BIN="$(readlink -f "$1")"
OUT="$(readlink -f "$2")"
TYPES=(${NAT_TYPES:-public full restricted port-restricted symmetric})
RUNS=(${RUNS:-iroh:both quinn:both iroh:one})
TIMEOUT="${PUNCH_TIMEOUT:-10}"
STUN=203.0.113.100:3478
: >"$OUT"

IPT=iptables
probe_ipt() {
  ip netns add s1probe
  if ip netns exec s1probe "$IPT" -t mangle -A POSTROUTING -m recent --name s1probe --rdest --set 2>/dev/null; then
    ip netns del s1probe
    return 0
  fi
  ip netns del s1probe
  return 1
}
if ! probe_ipt; then
  if command -v iptables-legacy >/dev/null && IPT=iptables-legacy probe_ipt; then IPT=iptables-legacy; else
    echo "iptables cannot load xt_recent; the restricted-cone NAT needs it" >&2
  fi
fi
echo "using $IPT ($($IPT --version))"

ns() { ip netns exec "$@"; }

cleanup_sides() {
  # Delete the bridge-side veth ends first: that is synchronous, while a namespace's own
  # teardown is not, and the next pair reuses these names at once.
  local ifc n
  for ifc in pa-br pb-br ra-br rb-br rl-br; do ip netns exec s1inet ip link del "$ifc" 2>/dev/null; done
  for n in s1pa s1pb s1ra s1rb s1rl; do ip netns del "$n" 2>/dev/null; done
  return 0
}

cleanup_all() {
  cleanup_sides
  ip netns del s1stun 2>/dev/null
  ip netns del s1inet 2>/dev/null
  return 0
}
trap cleanup_all EXIT
cleanup_all

# The internet: one bridge, and the STUN host on it.
ip netns add s1inet
ns s1inet ip link set lo up
ns s1inet ip link add br0 type bridge
ns s1inet ip link set br0 up
ip netns add s1stun
ns s1stun ip link set lo up
ip link add s1stun0 type veth peer name s1stun-br
ip link set s1stun0 netns s1stun
ip link set s1stun-br netns s1inet
ns s1inet ip link set s1stun-br master br0 up
ns s1stun ip addr add 203.0.113.100/24 dev s1stun0
ns s1stun ip link set s1stun0 up
ip netns exec s1stun "$BIN" stun-server --bind "$STUN" 2>/dev/null &
STUN_PID=$!
trap 'kill $STUN_PID 2>/dev/null; cleanup_all' EXIT

# wire <ns-a> <if-a> <ns-b> <if-b>: a veth pair between two namespaces.
wire() {
  ip link add "$2" type veth peer name "$4"
  ip link set "$2" netns "$1"
  ip link set "$4" netns "$3"
  ns "$1" ip link set "$2" up
  ns "$3" ip link set "$4" up
}

# router_rules <router-ns> <type> <public-ip> <lan-if> <wan-if> <host-ip>
router_rules() {
  local R=$1 T=$2 PUB=$3 LANIF=$4 WANIF=$5 HOST=$6
  local I=(ip netns exec "$R" "$IPT")
  ns "$R" sysctl -qw net.ipv4.ip_forward=1
  "${I[@]}" -P FORWARD DROP
  "${I[@]}" -A FORWARD -i "$LANIF" -o "$WANIF" -j ACCEPT
  "${I[@]}" -A FORWARD -i "$WANIF" -o "$LANIF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  "${I[@]}" -A FORWARD -i "$LANIF" -o "$LANIF" -j ACCEPT
  "${I[@]}" -A INPUT -i "$WANIF" -p udp -j DROP
  case "$T" in
    symmetric)
      "${I[@]}" -t nat -A POSTROUTING -o "$WANIF" -j SNAT --to-source "$PUB" --random
      ;;
    port-restricted | lan)
      "${I[@]}" -t nat -A POSTROUTING -o "$WANIF" -j SNAT --to-source "$PUB"
      ;;
    restricted)
      "${I[@]}" -t nat -A POSTROUTING -o "$WANIF" -j SNAT --to-source "$PUB"
      "${I[@]}" -t mangle -A POSTROUTING -o "$WANIF" -m recent --name s1contacted --rdest --set
      "${I[@]}" -t nat -A PREROUTING -i "$WANIF" -p udp --dport 47000:47999 \
        -m recent --name s1contacted --rsource --rcheck --seconds 600 -j DNAT --to-destination "$HOST"
      "${I[@]}" -A FORWARD -i "$WANIF" -o "$LANIF" -m conntrack --ctstate DNAT -j ACCEPT
      ;;
    full)
      "${I[@]}" -t nat -A POSTROUTING -o "$WANIF" -j SNAT --to-source "$PUB"
      "${I[@]}" -t nat -A PREROUTING -i "$WANIF" -p udp --dport 47000:47999 -j DNAT --to-destination "$HOST"
      "${I[@]}" -A FORWARD -i "$WANIF" -o "$LANIF" -m conntrack --ctstate DNAT -j ACCEPT
      ;;
  esac
}

# side <a|b> <type> <index>: peer s1p<x>, behind router s1r<x> unless the type is public.
side() {
  local X=$1 T=$2 N=$3
  local PUB=203.0.113.$N LAN=10.0.$N
  ip netns add "s1p$X"
  ns "s1p$X" ip link set lo up
  if [ "$T" = public ]; then
    wire "s1p$X" "p$X-wan" s1inet "p$X-br"
    ns s1inet ip link set "p$X-br" master br0
    ns "s1p$X" ip addr add "$PUB/24" dev "p$X-wan"
    return
  fi
  ip netns add "s1r$X"
  ns "s1r$X" ip link set lo up
  wire "s1r$X" "r$X-wan" s1inet "r$X-br"
  ns s1inet ip link set "r$X-br" master br0
  ns "s1r$X" ip addr add "$PUB/24" dev "r$X-wan"
  wire "s1r$X" "r$X-lan" "s1p$X" "p$X-lan"
  ns "s1r$X" ip addr add "$LAN.1/24" dev "r$X-lan"
  ns "s1p$X" ip addr add "$LAN.2/24" dev "p$X-lan"
  ns "s1p$X" ip route add default via "$LAN.1"
  router_rules "s1r$X" "$T" "$PUB" "r$X-lan" "r$X-wan" "$LAN.2"
}

# lan_sides: both peers on one LAN bridge behind one port-restricted router (s1rl).
lan_sides() {
  ip netns add s1rl
  ns s1rl ip link set lo up
  wire s1rl rl-wan s1inet rl-br
  ns s1inet ip link set rl-br master br0
  ns s1rl ip addr add 203.0.113.9/24 dev rl-wan
  ns s1rl ip link add lanbr type bridge
  ns s1rl ip link set lanbr up
  ns s1rl ip addr add 10.0.9.1/24 dev lanbr
  local i=2
  for X in a b; do
    ip netns add "s1p$X"
    ns "s1p$X" ip link set lo up
    wire "s1p$X" "p$X-lan" s1rl "rl-$X"
    ns s1rl ip link set "rl-$X" master lanbr
    ns "s1p$X" ip addr add "10.0.9.$i/24" dev "p$X-lan"
    ns "s1p$X" ip route add default via 10.0.9.1
    i=$((i + 1))
  done
  router_rules s1rl lan 203.0.113.9 lanbr rl-wan 10.0.9.2
}

# pair <type-a> <type-b> <transport> <strategy>
pair() {
  local TA=$1 TB=$2 TR=$3 ST=$4
  cleanup_sides
  if [ "$TA" = lan ]; then lan_sides; else
    side a "$TA" 1
    side b "$TB" 2
  fi
  local RDV
  RDV="$(mktemp -d)"
  ip netns exec s1pa "$BIN" punch --transport "$TR" --strategy "$ST" --name a --port 47001 --stun "$STUN" \
    --rendezvous "$RDV" --timeout "$TIMEOUT" --label "$TA/$TB" >"$RDV/a.out" 2>"$RDV/a.err" &
  local PA=$!
  ip netns exec s1pb "$BIN" punch --transport "$TR" --strategy "$ST" --name b --port 47002 --stun "$STUN" \
    --rendezvous "$RDV" --timeout "$TIMEOUT" --label "$TA/$TB" >"$RDV/b.out" 2>"$RDV/b.err" &
  local PB=$!
  wait "$PA" "$PB"
  for X in a b; do
    local line
    line="$(grep '^S1RESULT ' "$RDV/$X.out" | sed 's/^S1RESULT //')"
    if [ -z "$line" ]; then
      line="$(jq -cn --arg e "$(tail -c 400 "$RDV/$X.err")" --arg n "$X" --arg t "$TR" --arg s "$ST" \
        '{check:"punch",ok:false,name:$n,transport:$t,strategy:$s,error:("no result: " + $e)}')"
    fi
    echo "$line" | jq -c --arg ta "$TA" --arg tb "$TB" '. + {natA:$ta, natB:$tb}' >>"$OUT"
  done
  local verdict
  verdict="$(grep '^S1RESULT ' "$RDV/a.out" | sed 's/^S1RESULT //' | jq -r 'if .ok then "direct in \(.connectMs) ms (\(.how))" else "FAILED: \(.error // "?")" end' 2>/dev/null)"
  printf '%-6s %-5s a=%-16s b=%-16s %s\n' "$TR" "$ST" "$TA" "$TB" "${verdict:-FAILED: no result}"
  rm -rf "$RDV"
}

for run in "${RUNS[@]}"; do
  TR="${run%%:*}"
  ST="${run##*:}"
  pair lan lan "$TR" "$ST"
  for ((i = 0; i < ${#TYPES[@]}; i++)); do
    # Ordered pairs for strategy "one" (only a dials, so roles matter); unordered for "both".
    for ((j = 0; j < ${#TYPES[@]}; j++)); do
      if [ "$ST" = both ] && [ "$j" -lt "$i" ]; then continue; fi
      pair "${TYPES[$i]}" "${TYPES[$j]}" "$TR" "$ST"
    done
  done
done
echo "results in $OUT"
