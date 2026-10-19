// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Breaker} from "../../src/libraries/Breaker.sol";
import {BreakerHarness} from "../utils/BreakerHarness.sol";

/// @notice The TypeScript model in packages/sdk (used by the backtest and the web simulator) and the
/// Solidity breaker agree, step for step, on seeded random walks: same refusals, same halts, same
/// state after every swap and verdict. Regenerate the traces with
/// `pnpm --dir apps/cli exec tsx ../../packages/sdk/scripts/fixtures.ts`.
contract BreakerDiffTest is Test {
    struct Step {
        uint8 op;
        uint64 now;
        int24 tickAfter;
        bool liquidBefore;
        bool liquidAfter;
        bool crossed;
        int24 boundary;
        uint8 verdict;
        uint8 expectRevert;
        int24 ref;
        int24 lastTick;
        uint32 nonce;
        uint64 edgeSince;
        uint64 cooldownEnd;
        uint64 pinUntil;
        uint8 phase;
    }

    function _replay(uint256 n) internal {
        string memory path = string.concat("test/fixtures/breaker-trace-", vm.toString(n), ".hex");
        Step[] memory steps = abi.decode(vm.parseBytes(vm.readFile(path)), (Step[]));
        BreakerHarness h = new BreakerHarness(Breaker.Config(1000, 100, 300, 15, 900, 1800));
        h.init(0, 1000);
        for (uint256 i = 0; i < steps.length; i++) {
            Step memory s = steps[i];
            uint8 got = 0;
            if (s.op == 1) {
                Breaker.State memory before = h.state();
                try h.resolve(s.now, before.nonce, Breaker.Verdict(s.verdict)) {}
                catch {
                    got = 3;
                }
            } else {
                try h.swapFull(s.now, s.tickAfter, s.liquidBefore, s.liquidAfter, s.crossed, s.boundary) {}
                catch (bytes memory reason) {
                    bytes4 sel = bytes4(reason);
                    got = sel == BreakerHarness.Refused.selector ? 1 : sel == Breaker.Halted.selector ? 2 : 9;
                }
            }
            string memory at = string.concat("trace ", vm.toString(n), " step ", vm.toString(i));
            assertEq(got, s.expectRevert, string.concat(at, ": revert"));
            Breaker.State memory st = h.state();
            assertEq(st.ref, s.ref, string.concat(at, ": ref"));
            assertEq(st.lastTick, s.lastTick, string.concat(at, ": lastTick"));
            assertEq(st.nonce, s.nonce, string.concat(at, ": nonce"));
            assertEq(st.edgeSince, s.edgeSince, string.concat(at, ": edgeSince"));
            assertEq(st.cooldownEnd, s.cooldownEnd, string.concat(at, ": cooldownEnd"));
            assertEq(st.pinUntil, s.pinUntil, string.concat(at, ": pinUntil"));
            assertEq(uint8(h.phase(s.now)), s.phase, string.concat(at, ": phase"));
        }
    }

    function test_trace_1() public {
        _replay(1);
    }

    function test_trace_2() public {
        _replay(2);
    }

    function test_trace_3() public {
        _replay(3);
    }

    function test_trace_4() public {
        _replay(4);
    }

    function test_trace_5() public {
        _replay(5);
    }
}
