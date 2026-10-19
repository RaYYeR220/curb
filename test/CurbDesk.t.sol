// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurbDesk} from "../src/CurbDesk.sol";
import {IIntake} from "../src/interfaces/IIntake.sol";
import {MockIntake} from "./utils/MockIntake.sol";
import {MockLaunchFactory} from "./utils/MockLaunchFactory.sol";

contract StubHook {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }
}

contract CurbDeskTest is Test {
    bytes32 constant LAUNCH_OPEN = bytes32("launch.open@launch-1");
    bytes32 constant ORACLE_REQUEST = bytes32("oracle.request@oracle-1");
    bytes32 constant JOB_OPEN = bytes32("job.open@job-1");
    uint256 constant PRICE = 0.5 ether;

    address steward = makeAddr("steward");
    address alice = makeAddr("alice");
    address signer = makeAddr("signer");

    MockERC20 imd;
    MockIntake intake;
    MockLaunchFactory factory;
    CurbDesk desk;

    function setUp() public {
        imd = new MockERC20("IMD", "IMD", 18);
        intake = new MockIntake();
        intake.setPrice(LAUNCH_OPEN, address(imd), PRICE);
        intake.setPrice(ORACLE_REQUEST, address(imd), PRICE);
        intake.setPrice(JOB_OPEN, address(imd), PRICE);
        factory = new MockLaunchFactory();
        desk = new CurbDesk(intake, IERC20(address(imd)), factory, signer, steward);
    }

    function _keyFor(address hook) internal view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(imd)), Currency.wrap(address(0xC0B)), 12500, 60, IHooks(hook));
    }

    function _bindLaunch(uint64 n) internal returns (address hook) {
        hook = address(new StubHook(address(desk)));
        factory.setPosition(n, _keyFor(hook), address(desk));
        desk.bind(n);
    }

    // ---- launch ----

    function test_launch_onlySteward() public {
        imd.mint(address(desk), 1 ether);
        vm.expectRevert(CurbDesk.NotSteward.selector);
        vm.prank(alice);
        desk.launch("{}");
    }

    function test_launch_paysExactPrice_viaRequestWithFailure() public {
        imd.mint(address(desk), 1 ether);
        vm.prank(steward);
        bytes32 id = desk.launch('{"onchain":"univ4_hook"}');
        MockIntake.Stored memory r = intake.requestOf(id);
        assertEq(r.payer, address(desk));
        assertEq(r.action, LAUNCH_OPEN);
        assertEq(r.body, bytes('{"onchain":"univ4_hook"}'));
        assertEq(r.target, address(desk));
        assertEq(r.selector, desk.onResult.selector);
        assertEq(r.onFailure, desk.onRequestFailure.selector);
        assertEq(r.asset, address(imd));
        assertEq(r.amount, PRICE);
        assertEq(imd.balanceOf(address(desk)), 1 ether - PRICE);
        assertEq(imd.allowance(address(desk), address(intake)), 0);
        assertEq(desk.launchRequestId(), id);
    }

    function test_launch_treasuryShort() public {
        imd.mint(address(desk), 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.TreasuryShort.selector, 0.1 ether, PRICE));
        vm.prank(steward);
        desk.launch("{}");
    }

    function test_launch_refusedAfterBind() public {
        _bindLaunch(7);
        imd.mint(address(desk), 1 ether);
        vm.expectRevert(CurbDesk.AlreadyBound.selector);
        vm.prank(steward);
        desk.launch("{}");
    }

    // ---- binding ----

    function test_bind_requiresRequesterAndOwner() public {
        address hook = address(new StubHook(address(desk)));
        factory.setPosition(7, _keyFor(hook), alice);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.NotOurLaunch.selector, uint64(7)));
        desk.bind(7);

        address foreign = address(new StubHook(alice));
        factory.setPosition(8, _keyFor(foreign), address(desk));
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.NotOurHook.selector, foreign));
        desk.bind(8);

        factory.setPosition(9, _keyFor(hook), address(desk));
        vm.expectEmit(address(desk));
        emit CurbDesk.Bound(hook, CurbDesk.Kind.Launch, 9);
        vm.prank(alice);
        desk.bind(9);
        (CurbDesk.Kind kind, uint64 n) = desk.pools(hook);
        assertEq(uint8(kind), uint8(CurbDesk.Kind.Launch));
        assertEq(n, 9);
        assertEq(desk.launchNumber(), 9);
        assertEq(desk.hooks(0), hook);
    }

    function test_bind_unknownLaunch() public {
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.NotOurLaunch.selector, uint64(404)));
        desk.bind(404);
    }

    function test_bind_once() public {
        _bindLaunch(7);
        address other = address(new StubHook(address(desk)));
        factory.setPosition(8, _keyFor(other), address(desk));
        vm.expectRevert(CurbDesk.AlreadyBound.selector);
        desk.bind(8);
    }

    function test_bindDrill_stewardOnly_ownerCheck() public {
        address hook = address(new StubHook(address(desk)));
        vm.expectRevert(CurbDesk.NotSteward.selector);
        desk.bindDrill(hook);
        address foreign = address(new StubHook(alice));
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.NotOurHook.selector, foreign));
        vm.prank(steward);
        desk.bindDrill(foreign);
        vm.prank(steward);
        desk.bindDrill(hook);
        (CurbDesk.Kind kind,) = desk.pools(hook);
        assertEq(uint8(kind), uint8(CurbDesk.Kind.Drill));
        vm.expectRevert(CurbDesk.AlreadyBound.selector);
        vm.prank(steward);
        desk.bindDrill(hook);
    }

    // ---- steward ----

    function test_timelock_executeBefore48hReverts_afterWorks() public {
        MockIntake next = new MockIntake();
        vm.prank(steward);
        desk.proposeIntake(next);
        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.Timelocked.selector, eta));
        vm.prank(steward);
        desk.executeIntake();
        vm.warp(eta);
        vm.prank(steward);
        desk.executeIntake();
        assertEq(address(desk.intake()), address(next));

        address nextSigner = makeAddr("next signer");
        vm.prank(steward);
        desk.proposeOracleSigner(nextSigner);
        (, uint64 signerEta) = desk.signerProposal();
        assertEq(signerEta, eta + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.Timelocked.selector, signerEta));
        vm.prank(steward);
        desk.executeOracleSigner();
        vm.warp(signerEta);
        vm.prank(steward);
        desk.executeOracleSigner();
        assertEq(desk.oracleSigner(), nextSigner);
    }

    function test_timelock_nothingProposed() public {
        vm.expectRevert(CurbDesk.NothingProposed.selector);
        vm.prank(steward);
        desk.executeIntake();
        vm.expectRevert(CurbDesk.NothingProposed.selector);
        vm.prank(steward);
        desk.executeOracleSigner();
    }

    function test_steward_onlyStewardProposes() public {
        vm.expectRevert(CurbDesk.NotSteward.selector);
        desk.proposeIntake(IIntake(address(1)));
        vm.expectRevert(CurbDesk.NotSteward.selector);
        desk.proposeOracleSigner(address(1));
    }

    function test_renounce_disablesSteward() public {
        vm.prank(steward);
        desk.renounce();
        assertEq(desk.steward(), address(0));
        imd.mint(address(desk), 1 ether);
        vm.expectRevert(CurbDesk.NotSteward.selector);
        vm.prank(steward);
        desk.launch("{}");
    }

    function test_fund() public {
        imd.mint(alice, 2 ether);
        vm.startPrank(alice);
        imd.approve(address(desk), 2 ether);
        vm.expectEmit(address(desk));
        emit CurbDesk.Funded(alice, 2 ether);
        desk.fund(2 ether);
        vm.stopPrank();
        assertEq(imd.balanceOf(address(desk)), 2 ether);
    }

    // ---- launch results ----

    function test_onResult_onlyIntake() public {
        vm.expectRevert(CurbDesk.NotTheIntake.selector);
        desk.onResult(bytes32(0), bytes32(0), "");
    }

    function test_onResult_recordsLaunchResult() public {
        imd.mint(address(desk), 1 ether);
        vm.prank(steward);
        bytes32 id = desk.launch("{}");
        assertTrue(intake.deliver(id, abi.encode(id, keccak256("launch"), "https://api.imd.fun/launches/2400")));
        assertEq(uint8(desk.launchState()), uint8(CurbDesk.RequestState.Completed));
        assertEq(desk.launchUri(), "https://api.imd.fun/launches/2400");
    }

    function test_launchFailure_recorded() public {
        imd.mint(address(desk), 1 ether);
        vm.prank(steward);
        bytes32 id = desk.launch("{}");
        assertTrue(intake.fail(id, 2, bytes32("failed")));
        assertEq(uint8(desk.launchState()), uint8(CurbDesk.RequestState.Failed));
    }

    // ---- custody ----

    /// @dev Whatever anyone calls, IMD leaves the desk only as an exact Intake price.
    function testFuzz_noTokenLeavesExceptIntakePrice(uint256 seed, address caller) public {
        vm.assume(caller != address(0) && caller != address(desk));
        imd.mint(address(desk), 3 ether);
        imd.mint(caller, 1 ether);
        vm.prank(caller);
        imd.approve(address(desk), type(uint256).max);
        uint256 funded;
        for (uint256 i = 0; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 3 == 0 ? steward : caller;
            vm.startPrank(who);
            uint256 action = seed % 7;
            if (action == 0) {
                try desk.launch("{}") {} catch {}
            } else if (action == 1) {
                try desk.bind(uint64(seed)) {} catch {}
            } else if (action == 2) {
                uint256 amount = seed % 1e17;
                try desk.fund(amount) {
                    if (who == caller) funded += amount;
                } catch {}
            } else if (action == 3) {
                try desk.bindDrill(address(uint160(seed))) {} catch {}
            } else if (action == 4) {
                try desk.proposeIntake(IIntake(address(uint160(seed)))) {} catch {}
            } else if (action == 5) {
                try desk.onResult(bytes32(seed), bytes32(seed), "") {} catch {}
            } else {
                try desk.onRequestFailure(bytes32(seed), 2, bytes32(0), 0, 0, "") {} catch {}
            }
            vm.stopPrank();
        }
        assertEq(imd.balanceOf(address(desk)), 3 ether + funded - intake.pulled());
        assertEq(intake.pulled() % PRICE, 0);
    }
}
