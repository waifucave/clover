#!/usr/bin/env bash
# S1 question 3: which NAT pairs connect directly with no relay, and (with a relay) what a dial
# sends through it.
#
#   sudo [PHASES="matrix timing relay"] spikes/s1-transport/nat/matrix.sh <clover-link-sidecar> <results.jsonl>
#
# Phases (default "matrix"):
#   matrix  every NAT pair, relays off: iroh and quinn both dialling, iroh with one side dialling
#   timing  restricted x symmetric, five times each, as is, with a second dial 100 ms after the
#           first, and with a 100 ms initial RTT (the 1 s case in the report)
#   relay   a local iroh relay at 203.0.113.50 (needs a sidecar built with --features
#           relay-server): chosen pairs under each dial policy (punch.rs), and once with the
#           relay's QUIC address discovery off
#
# Linux only, as root. Builds a small internet out of network namespaces:
#
#   s1pa ─ s1ra ─┐                          ┌─ s1rb ─ s1pb      peers behind their routers
#                ├─ s1inet (bridge br0, 203.0.113.0/24) ─┤
#   s1stun ──────┘                          └─ s1relay         STUN at 203.0.113.100 and .101,
#                                                              the relay at 203.0.113.50
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
# addresses through a shared folder (the waifucave handshake's job). Every NAT here that maps
# endpoint-independently also keeps the inside port, so the lab can't show a mapping outliving
# its socket (report, lab limits). Each peer asks both STUN servers from its one socket, so its
# record says whether its mapping depends on the destination (report, edit 6 option (c)).

set -uo pipefail
BIN="$(readlink -f "$1")"
OUT="$(readlink -f "$2")"
TYPES=(${NAT_TYPES:-public full restricted port-restricted symmetric})
RUNS=(${RUNS:-iroh:both quinn:both iroh:one})
PHASES=(${PHASES:-matrix})
TIMEOUT="${PUNCH_TIMEOUT:-10}"
STUN=203.0.113.100:3478
STUN2=203.0.113.101:3478
RELAY_IP=203.0.113.50
: >"$OUT"
has_phase() { local p; for p in "${PHASES[@]}"; do [ "$p" = "$1" ] && return 0; done; return 1; }

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
  ip netns del s1relay 2>/dev/null
  ip netns del s1stun 2>/dev/null
  ip netns del s1inet 2>/dev/null
  return 0
}
trap cleanup_all EXIT
cleanup_all

# The internet: one bridge, and the STUN host on it with two addresses (two STUN servers).
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
ns s1stun ip addr add 203.0.113.101/24 dev s1stun0
ns s1stun ip link set s1stun0 up
ip netns exec s1stun "$BIN" stun-server --bind "$STUN" 2>/dev/null &
STUN_PID=$!
ip netns exec s1stun "$BIN" stun-server --bind "$STUN2" 2>/dev/null &
STUN2_PID=$!
BG_PIDS="$STUN_PID $STUN2_PID"
trap 'kill $BG_PIDS 2>/dev/null; cleanup_all' EXIT

# The relay host, for the relay phase only.
RELAY_DIR=""
if has_phase relay; then
  RELAY_DIR="$(mktemp -d)"
  ip netns add s1relay
  ns s1relay ip link set lo up
  ip link add s1relay0 type veth peer name s1relay-br
  ip link set s1relay0 netns s1relay
  ip link set s1relay-br netns s1inet
  ns s1inet ip link set s1relay-br master br0 up
  ns s1relay ip addr add "$RELAY_IP/24" dev s1relay0
  ns s1relay ip link set s1relay0 up
  ip netns exec s1relay "$BIN" relay-server --bind-ip "$RELAY_IP" --https-port 3443 --http-port 3340 --qad-port 7842 \
    --metrics-file "$RELAY_DIR/metrics.json" --info-file "$RELAY_DIR/relay.json" >"$RELAY_DIR/relay.log" 2>&1 &
  BG_PIDS="$BG_PIDS $!"
  for _ in $(seq 100); do [ -s "$RELAY_DIR/relay.json" ] && break; sleep 0.1; done
  if [ ! -s "$RELAY_DIR/relay.json" ]; then
    echo "the relay did not start:" >&2
    cat "$RELAY_DIR/relay.log" >&2
    exit 1
  fi
  echo "relay: $(cat "$RELAY_DIR/relay.json")"
  RELAY_URL="$(jq -r .url "$RELAY_DIR/relay.json")"
  RELAY_SHA="$(jq -r .certSha256 "$RELAY_DIR/relay.json")"
fi

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

# pair <phase> <variant> <type-a> <type-b> <transport> <strategy> [punch flags...]
pair() {
  local PH=$1 VAR=$2 TA=$3 TB=$4 TR=$5 ST=$6
  shift 6
  cleanup_sides
  if [ "$TA" = lan ]; then lan_sides; else
    side a "$TA" 1
    side b "$TB" 2
  fi
  local RDV
  RDV="$(mktemp -d)"
  local COMMON=(punch --transport "$TR" --strategy "$ST" --stun "$STUN" --stun2 "$STUN2" --rendezvous "$RDV"
    --timeout "$TIMEOUT" --label "$TA/$TB" "$@")
  ip netns exec s1pa "$BIN" "${COMMON[@]}" --name a --port 47001 >"$RDV/a.out" 2>"$RDV/a.err" &
  local PA=$!
  ip netns exec s1pb "$BIN" "${COMMON[@]}" --name b --port 47002 >"$RDV/b.out" 2>"$RDV/b.err" &
  local PB=$!
  wait "$PA" "$PB"
  for X in a b; do
    local line
    line="$(grep '^S1RESULT ' "$RDV/$X.out" | sed 's/^S1RESULT //')"
    if [ -z "$line" ]; then
      line="$(jq -cn --arg e "$(tail -c 400 "$RDV/$X.err")" --arg n "$X" --arg t "$TR" --arg s "$ST" \
        '{check:"punch",ok:false,name:$n,transport:$t,strategy:$s,error:("no result: " + $e)}')"
    fi
    echo "$line" | jq -c --arg ta "$TA" --arg tb "$TB" --arg ph "$PH" --arg v "$VAR" \
      '. + {natA:$ta, natB:$tb, phase:$ph, variant:$v}' >>"$OUT"
  done
  local verdict
  verdict="$(grep '^S1RESULT ' "$RDV/a.out" | sed 's/^S1RESULT //' | jq -r 'if .ok then "connected in \(.connectMs) ms (\(.how)), relayed during dial \(.relayDuringDial.sendPacketsRecv // "-")" else "FAILED: \(.error // "?")" end' 2>/dev/null)"
  printf '%-7s %-12s %-6s %-5s a=%-16s b=%-16s %s\n' "$PH" "$VAR" "$TR" "$ST" "$TA" "$TB" "${verdict:-FAILED: no result}"
  rm -rf "$RDV"
}

if has_phase matrix; then
  for run in "${RUNS[@]}"; do
    TR="${run%%:*}"
    ST="${run##*:}"
    pair matrix relay-off lan lan "$TR" "$ST"
    for ((i = 0; i < ${#TYPES[@]}; i++)); do
      # Ordered pairs for strategy "one" (only a dials, so roles matter); unordered for "both".
      for ((j = 0; j < ${#TYPES[@]}; j++)); do
        if [ "$ST" = both ] && [ "$j" -lt "$i" ]; then continue; fi
        pair matrix relay-off "${TYPES[$i]}" "${TYPES[$j]}" "$TR" "$ST"
      done
    done
  done
fi

if has_phase timing; then
  # The pair whose first Initial often loses the race (report, Q3 point 3), five times each way.
  for TR in iroh quinn; do
    for rep in 1 2 3 4 5; do
      pair timing as-is restricted symmetric "$TR" both
      pair timing redial-100ms restricted symmetric "$TR" both --redial-ms 100
      pair timing initial-rtt-100ms restricted symmetric "$TR" both --initial-rtt-ms 100
    done
  done
fi

if has_phase relay; then
  RELAY_FLAGS=(--relay-url "$RELAY_URL" --relay-cert-sha256 "$RELAY_SHA" --relay-metrics "$RELAY_DIR/metrics.json")
  # A pair that connects directly, two that never do, one that needs QUIC's 1 s resend, and one
  # with a symmetric side that still connects directly.
  RELAY_PAIRS=(${RELAY_PAIRS:-port-restricted:port-restricted symmetric:symmetric port-restricted:symmetric restricted:symmetric public:symmetric})
  for p in "${RELAY_PAIRS[@]}"; do
    TA="${p%%:*}"
    TB="${p##*:}"
    for policy in direct race headstart:500 headstart:1000 auto:500; do
      POL="${policy%%:*}"
      HS="${policy##*:}"
      [ "$HS" = "$POL" ] && HS=500
      pair relay "$policy" "$TA" "$TB" iroh both "${RELAY_FLAGS[@]}" --relay-qad-port 7842 \
        --policy "$POL" --headstart-ms "$HS" --second-direct-dial
    done
  done
  # The one lever iroh has to keep address discovery off a relay that is on: no QUIC config.
  pair relay direct-no-qad port-restricted port-restricted iroh both "${RELAY_FLAGS[@]}" --policy direct
  pair relay race-no-qad port-restricted port-restricted iroh both "${RELAY_FLAGS[@]}" --policy race
  echo "relay log tail:"
  tail -n 20 "$RELAY_DIR/relay.log"
fi
echo "results in $OUT"
