#!/usr/bin/env bash
# The drill: Curb's whole refusal path, live, on the DRILL/ETH pool. Each step is a transaction a
# reviewer can open on the explorer:
#
#   1. a buy that would leave the band       -> reverts OutsideBand(ref, tickAfter, limit, zeroForOne)
#   2. a buy into the band's edge zone       -> succeeds, LimitEntered
#   3. a swap once the limit state has held  -> reverts Halted(nonce, reopensAt)
#   4. the desk asked to file the incident   -> reverts TreasuryShort(have, need) while unfunded
#   5. a swap after the halt's maximum       -> succeeds, HaltClosed
#
# Refused steps are sent with a fixed gas limit so they are mined as failed transactions.
#
#   RPC=... DEPLOYER_KEY=... bash script/drill.sh          # live: waits in real time
#   RPC=http://127.0.0.1:8546 FORK=1 DEPLOYER_KEY=... bash script/drill.sh   # anvil: moves the clock
set -uo pipefail
cd "$(dirname "$0")/.."

RPC=${RPC:?set RPC}
KEY=${DEPLOYER_KEY:?set DEPLOYER_KEY}
FORK=${FORK:-0}
J=deployments/4663.json
# Walks a dotted path through the deployments file.
read_json() { python -I -c "import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split('.'): d=d[k]
print(d)" "$J" "$1"; }
ROUTER=$(read_json router)
DESK=$(read_json desk)
HOOK=$(read_json drill.drillHook)
TOKEN=$(read_json drill.drillToken)
POOL="(0x0000000000000000000000000000000000000000,$TOKEN,12500,60,$HOOK)"
SWAP="swap((address,address,uint24,int24,address),bool,int256,uint160)"
MIN_LIMIT=4295128740
sqrt_at() { python -I -c "import math,sys; print(int(math.sqrt(1.0001**int(sys.argv[1]))*2**96))" "$1"; }

wait_s() {
  if [ "$FORK" = "1" ]; then
    cast rpc evm_increaseTime "$1" --rpc-url "$RPC" >/dev/null
    cast rpc anvil_mine 12 --rpc-url "$RPC" >/dev/null
  else
    sleep "$1"
  fi
}

# The hook's error inside v4's WrappedError, by name.
why() {
  cast call --private-key "$KEY" --rpc-url "$RPC" "$@" 2>&1 | python -I -c "import re,sys
out=sys.stdin.read()
names={'6903c757':'OutsideBand','a4e8c8ab':'Halted','df99685d':'TreasuryShort','78b19eb2':'NotHalted'}
m=re.search(r'WrappedError\(0x[0-9a-fA-F]{40}, 0x[0-9a-fA-F]{8}, 0x([0-9a-fA-F]{8})', out) or re.search(r'custom error 0x([0-9a-fA-F]{8})', out)
sel=m.group(1).lower() if m else ''
n=re.search(r'execution reverted: (\w+)', out)
print('  reason:', names.get(sel, sel or (n.group(1) if n else 'passes')))"
}

send() {
  local label=$1; shift
  local out
  out=$(cast send --json --private-key "$KEY" --rpc-url "$RPC" "$@" 2>&1)
  local hash status
  hash=$(printf '%s' "$out" | python -I -c "import json,sys
try:
  d=json.loads(sys.stdin.read()); print(d.get('transactionHash',''))
except Exception: print('')")
  status=$(printf '%s' "$out" | python -I -c "import json,sys
try:
  d=json.loads(sys.stdin.read()); print(int(d.get('status','0x0'),16))
except Exception: print('?')")
  echo "$label  status=$status  tx=$hash"
  [ -n "$hash" ] || echo "$out" | tail -3
}

STATUS="status()((uint8,uint32,int24,int24,int24,int24,uint64,uint64,uint64,uint64,uint64,uint8,uint64,uint64,uint256))"
show() { echo "  status: $(cast call "$HOOK" "$STATUS" --rpc-url "$RPC")"; }

REF=$(cast call "$HOOK" "$STATUS" --rpc-url "$RPC" | python -I -c "import re,sys
s=re.sub(r'\[[^]]*\]', '', sys.stdin.read()).strip('() \n')
print(s.split(',')[2].strip())")
echo "drill hook $HOOK, reference tick $REF"

# 1. Through the band: 0.0001 ETH with no price limit carries the price far past it.
why --value 100000000000000 "$ROUTER" "$SWAP" -- "$POOL" true -100000000000000 $MIN_LIMIT
send "1 refused  OutsideBand " --value 100000000000000 --gas-limit 900000 "$ROUTER" "$SWAP" -- "$POOL" true -100000000000000 $MIN_LIMIT
# 2. Into the edge zone: stop 270 ticks below the reference (band 300, edge 60).
EDGE_LIMIT=$(sqrt_at $((REF - 270)))
send "2 passes   LimitEntered" --value 100000000000000 --gas-limit 900000 "$ROUTER" "$SWAP" -- "$POOL" true -100000000000000 "$EDGE_LIMIT"
show
# 3. The limit state holds 10 seconds, then the pool halts both ways.
wait_s 12
why --value 1000000000 "$ROUTER" "$SWAP" -- "$POOL" true -1000000000 $MIN_LIMIT
send "3 refused  Halted      " --value 1000000000 --gas-limit 900000 "$ROUTER" "$SWAP" -- "$POOL" true -1000000000 $MIN_LIMIT
show
# 4. Ask the desk to buy the oracle's verdict; with no IMD in its treasury it says so.
why "$DESK" "fileIncident(address)" "$HOOK"
send "4 refused  TreasuryShort" --gas-limit 900000 "$DESK" "fileIncident(address)" "$HOOK"
# 5. After the halt's maximum the first swap reopens the pool and closes the incident.
wait_s 300
send "5 passes   HaltClosed  " --value 1000000000 --gas-limit 900000 "$ROUTER" "$SWAP" -- "$POOL" true -1000000000 $MIN_LIMIT
show
