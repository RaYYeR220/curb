#!/usr/bin/env bash
# Runs IMD's univ4_hook protected suites against the exact creation code a CURB/IMD launch deploys,
# with the verifier's probes standing in for $token, $factory and $owner.
#
#   bash script/protected.sh            # CURB sorts below IMD
#   bash script/protected.sh above      # CURB sorts above IMD
set -euo pipefail
cd "$(dirname "$0")/.."

ORDER=${1:-below}
[ $# -gt 0 ] && shift

POOL_MANAGER=0x8366a39cc670b4001a1121b8f6a443a643e40951
IMD=0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127
FACTORY_PROBE=0x000000000000000000000000000000000000FaC7
OWNER_PROBE=0x000000000000000000000000000000000000D35C

# Opening price: 2,500 IMD for the whole 1e27 supply, in the pool's own token order.
if [ "$ORDER" = "above" ]; then
  TOKEN_PROBE=0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF
  SQRT_PRICE=50108289675009586237282760313921
else
  TOKEN_PROBE=0x00000000000000000000000000000000000070CE
  SQRT_PRICE=125270724187523965593206900
fi

forge build --silent
HOOK_CODE=$(forge inspect CurbHook bytecode)
HOOK_ARGS=$(cast abi-encode "constructor(address,address,address,address,int24,int24,uint32,uint32,uint32,uint32,bool)" \
  $POOL_MANAGER $TOKEN_PROBE $FACTORY_PROBE $OWNER_PROBE 1000 100 300 15 900 1800 true)

export IMD_HOOK_CREATION_CODE="${HOOK_CODE}${HOOK_ARGS#0x}"
export IMD_HOOK_FLAGS=0x20C0
export IMD_HOOK_NAME=CurbHook
export IMD_PROJECT_CHAIN_ID=4663
export IMD_PAIRED_CURRENCY=$IMD
export IMD_POOL_MANAGER=$POOL_MANAGER
export IMD_TOKEN_PROBE=$TOKEN_PROBE
export IMD_TOKEN_CREATION_CODE=$(forge inspect CurbToken bytecode)
export IMD_FACTORY_PROBE=$FACTORY_PROBE
export IMD_POOL_FEE=12500
export IMD_TICK_SPACING=60
export IMD_SQRT_PRICE=$SQRT_PRICE
export IMD_EXPECTED_SUPPLY=1000000000000000000000000000
export IMD_TOKEN_DECIMALS=18

FOUNDRY_PROFILE=protected forge test --match-path 'test/protected/*' "$@"
