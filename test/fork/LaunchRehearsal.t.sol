// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LiquidityAmounts} from "v4-core/test/utils/LiquidityAmounts.sol";
import {CurbHook} from "../../src/CurbHook.sol";
import {CurbToken} from "../../src/CurbToken.sol";
import {CurbDesk} from "../../src/CurbDesk.sol";
import {ICurbHook} from "../../src/interfaces/ICurbHook.sol";
import {IIntake} from "../../src/interfaces/IIntake.sol";
import {ILaunchFactory} from "../../src/interfaces/ILaunchFactory.sol";
import {Breaker} from "../../src/libraries/Breaker.sol";
import {OracleAttestation} from "../../src/oracle/OracleAttestation.sol";
import {CurbRouter} from "../../src/tools/CurbRouter.sol";
import {IImdIntake, IImdLaunchFactory, IImdRegistry} from "./imd/LaunchTypes.sol";

/// @notice The CURB launch, rehearsed on a Robinhood Chain fork against IMD's live contracts: the
/// launch wallet calls the real LaunchFactory with our token and hook, exactly as it will after
/// the swarm admits the repository, and then the pool trades, refuses, pays fees, halts, has its
/// incident filed through the real Intake, answered through the Intake's own `complete`, and
/// reopens on the pinned reference.
///
/// The template is IMD's own call for launch #2185 (KEPT, a hook launch paired with IMD), read from
/// chain into `test/fixtures/kept-launch-input.hex`; only what makes it ours is replaced.
///
/// Skipped unless `RH_RPC` is set: `RH_RPC=https://rpc.mainnet.chain.robinhood.com forge test
/// --match-contract LaunchRehearsal -vv`.
contract LaunchRehearsalTest is Test {
    address constant FACTORY = 0xA25B02A1e93903b790E6aaf7dA1b8B8d50294645;
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant IMD = 0x5F7Bb59365ce557C26dbcAa4EE9d39A4b95B7127;
    address constant INTAKE = 0xa43e6F75ee006411F79Ac1C84120606C2330DE82;
    uint160 constant FLAGS = 0x20C0;
    /// @dev A key of our own: well-known test keys have EIP-7702 delegations on live chains, which
    /// sends `SignatureChecker` down the ERC-1271 path. IMD's real signer is a plain EOA there.
    uint256 constant SIGNER_KEY = uint256(keccak256("curb rehearsal oracle signer"));
    uint256 constant SUPPLY = 1_000_000_000 ether;
    uint160 constant SQRT_PRICE_CURB_BELOW = 125270724187523965593206900;
    uint160 constant SQRT_PRICE_CURB_ABOVE = 50108289675009586237282760313921;

    IImdLaunchFactory factory = IImdLaunchFactory(FACTORY);
    CurbDesk desk;
    CurbRouter router;
    CurbHook hook;
    PoolKey key;
    bool imdIs0;

    function test_rehearsal_curbBelowImd() public {
        _rehearse(true);
    }

    function test_rehearsal_curbAboveImd() public {
        _rehearse(false);
    }

    function _rehearse(bool curbBelow) internal {
        string memory rpc = vm.envOr("RH_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        console.log("fork L1 block.number", block.number);

        desk = new CurbDesk(IIntake(INTAKE), IERC20(IMD), ILaunchFactory(FACTORY), vm.addr(SIGNER_KEY), address(this));
        router = new CurbRouter(IPoolManager(POOL_MANAGER));
        console.log("fork L2 block", desk.head());

        // ---- the launch, as IMD's launch wallet sends it ----
        IImdLaunchFactory.LaunchParams memory p = _params(curbBelow);
        uint256 before = gasleft();
        vm.prank(factory.deployer());
        (address token, address hookAddr,) = factory.launch(p);
        uint256 used = before - gasleft();
        console.log("launch gas", used);
        assertLt(used, 16_777_216, "over the EIP-7825 transaction gas cap");
        assertEq(token < IMD, curbBelow);

        hook = CurbHook(hookAddr);
        assertEq(hook.owner(), address(desk));
        assertEq(hook.initializer(), FACTORY);
        (PoolKey memory k,,, address requester) = ILaunchFactory(FACTORY).positionOf(p.launchNumber);
        assertEq(requester, address(desk));
        assertEq(address(k.hooks), hookAddr);
        assertEq(IERC20(token).totalSupply(), SUPPLY);
        key = hook.poolKey();
        imdIs0 = Currency.unwrap(key.currency0) == IMD;
        ICurbHook.Status memory s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Open));
        int24 openRef = s.ref;
        desk.bind(p.launchNumber);

        // ---- trade both ways through the live PoolManager ----
        _buyImd(3 ether);
        IERC20(IMD).approve(address(router), type(uint256).max);
        IERC20(token).approve(address(router), type(uint256).max);
        _buyCurb(10 ether);
        uint256 curbHeld = IERC20(token).balanceOf(address(this));
        assertGt(curbHeld, 0);
        _sellCurb(curbHeld / 2);
        // An order that would carry the price through the band is refused, with the reason.
        bytes memory refused = _tryBuyCurb(400 ether);
        assertEq(bytes4(_inner(refused)), ICurbHook.OutsideBand.selector);

        // ---- the factory's fee collect, with the hook live ----
        uint256 deskImd = IERC20(IMD).balanceOf(address(desk));
        ILaunchFactory(FACTORY).claimFees(p.launchNumber);
        assertGt(IERC20(IMD).balanceOf(address(desk)), deskImd, "requester share of LP fees not paid");

        // ---- press the price into the edge zone and wait out the limit state ----
        int24 edgeTarget = imdIs0 ? openRef - 950 : openRef + 950;
        router.swap(key, imdIs0, -1000 ether, TickMath.getSqrtPriceAtTick(edgeTarget));
        s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Limit));
        vm.warp(block.timestamp + 15);
        vm.roll(block.number + 40);
        bytes memory halted = _tryBuyCurb(1 ether);
        assertEq(bytes4(_inner(halted)), Breaker.Halted.selector);

        // ---- the desk files the incident through the real Intake ----
        // A fork freezes ArbSys at the fork block; the chain itself would be ~60 L2 blocks on by
        // now (four a second), so move its block number the way the chain would.
        uint64 l2Now = desk.head();
        vm.mockCall(address(100), abi.encodeWithSignature("arbBlockNumber()"), abi.encode(uint256(l2Now + 60)));
        IERC20(IMD).transfer(address(desk), 1 ether);
        // Filing sweeps the launch's fees first; sweep them now so the price paid is what moves.
        ILaunchFactory(FACTORY).claimFees(p.launchNumber);
        uint256 deskBefore = IERC20(IMD).balanceOf(address(desk));
        bytes32 id = desk.fileIncident(address(hook));
        assertEq(deskBefore - IERC20(IMD).balanceOf(address(desk)), 0.5 ether);
        uint32 nonce = hook.status().nonce;

        // ---- the oracle's answer, delivered by the Intake's writer under its stipend ----
        OracleAttestation.Attestation memory a = _attestation(id, nonce);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(SIGNER_KEY, desk.attestationDigest(a));
        vm.expectEmit(INTAKE);
        emit IImdIntake.Completed(id, 0, keccak256("result"), "ipfs://result", true);
        vm.prank(IImdIntake(INTAKE).writer());
        IImdIntake(INTAKE).complete(id, 0, keccak256("result"), "ipfs://result", abi.encode(id, a, abi.encodePacked(r, sg, v)));
        CurbDesk.Incident memory inc = desk.incident(address(hook), nonce);
        assertEq(uint8(inc.verdict), uint8(Breaker.Verdict.Concentrated));
        assertTrue(inc.applied);
        assertEq(uint8(hook.status().verdict), uint8(Breaker.Verdict.Concentrated));

        // ---- the halt runs its full length, then reopens on the pre-move reference ----
        vm.warp(block.timestamp + 900);
        _sellCurb(IERC20(token).balanceOf(address(this)) / 10);
        s = hook.status();
        assertEq(s.nonce, nonce + 1);
        assertEq(s.ref, openRef, "the pin did not hold the reference from before the move");
        assertGt(s.pinUntil, block.timestamp);
        console.log("hook", hookAddr);
        console.log("token", token);
    }

    // ---- building the launch ----

    function _params(bool curbBelow) internal view returns (IImdLaunchFactory.LaunchParams memory p) {
        bytes memory input = vm.parseBytes(vm.readFile("test/fixtures/kept-launch-input.hex"));
        IImdLaunchFactory.LaunchParams memory t = abi.decode(_tail(input), (IImdLaunchFactory.LaunchParams));

        bytes memory tokenCode = type(CurbToken).creationCode;
        uint64 n = t.launchNumber + 5000;
        address token;
        while (true) {
            token = factory.predictToken(n, tokenCode);
            if ((token < IMD) == curbBelow && !IImdRegistry(factory.registry()).isRecorded(n)) break;
            n++;
        }
        bytes memory hookCode = abi.encodePacked(
            type(CurbHook).creationCode,
            abi.encode(
                POOL_MANAGER, token, FACTORY, address(desk), int24(1000), int24(100), uint32(300), uint32(15), uint32(900), uint32(1800), true
            )
        );

        p = t;
        p.launchNumber = n;
        p.tokenCreationCode = tokenCode;
        p.hookCreationCode = hookCode;
        p.hookSalt = _mineSalt(hookCode);
        p.hookFlags = FLAGS;
        p.totalSupply = SUPPLY;
        p.poolBps = 9000;
        p.remainderTo = address(desk);
        p.pairedCurrency = Currency.wrap(IMD);
        p.fee = 12500;
        p.tickSpacing = 60;
        p.requester = address(desk);
        // Single-sided CURB from the opening price outward, the shape IMD seeds: 2,500 IMD of
        // market cap at open, with a hair under 90% of the supply in the pool.
        uint256 seed = SUPPLY * 9000 / 10_000 * 999 / 1000;
        if (curbBelow) {
            p.sqrtPriceX96 = SQRT_PRICE_CURB_BELOW;
            (p.tickLower, p.tickUpper) = (-128940, 887220);
            p.liquidity = LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(p.tickLower), TickMath.getSqrtPriceAtTick(p.tickUpper), seed
            );
        } else {
            p.sqrtPriceX96 = SQRT_PRICE_CURB_ABOVE;
            (p.tickLower, p.tickUpper) = (-887220, 128940);
            p.liquidity = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(p.tickLower), TickMath.getSqrtPriceAtTick(p.tickUpper), seed
            );
        }
    }

    function _mineSalt(bytes memory code) internal pure returns (bytes32) {
        bytes32 codeHash = keccak256(code);
        for (uint256 i = 0; i < 1_000_000; i++) {
            address at = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), FACTORY, bytes32(i), codeHash)))));
            if (uint160(at) & 0x3FFF == FLAGS) return bytes32(i);
        }
        revert("no salt");
    }

    // ---- trading ----

    function _buyImd(uint256 eth) internal {
        vm.deal(address(this), eth);
        PoolKey memory imdEth = PoolKey(Currency.wrap(address(0)), Currency.wrap(IMD), 10000, 100, IHooks(address(0)));
        router.swap{value: eth}(imdEth, true, -int256(eth), TickMath.MIN_SQRT_PRICE + 1);
        assertGt(IERC20(IMD).balanceOf(address(this)), 0);
    }

    function _buyCurb(uint256 imdIn) internal {
        router.swap(key, imdIs0, -int256(imdIn), imdIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
    }

    function _sellCurb(uint256 curbIn) internal {
        router.swap(key, !imdIs0, -int256(curbIn), imdIs0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1);
    }

    function _tryBuyCurb(uint256 imdIn) internal returns (bytes memory data) {
        try router.swap(key, imdIs0, -int256(imdIn), imdIs0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1) {
            revert("expected a refusal");
        } catch (bytes memory reason) {
            data = reason;
        }
    }

    // ---- the answer ----

    function _attestation(bytes32 id, uint32 nonce) internal view returns (OracleAttestation.Attestation memory a) {
        (,, bytes32 questionHash) = desk.pending(id);
        CurbDesk.Incident memory inc = desk.incident(address(hook), nonce);
        address[] memory leaders = new address[](1);
        leaders[0] = address(this);
        a = OracleAttestation.Attestation({
            requestId: keccak256(abi.encode("rehearsal", id)),
            chainId: 4663,
            questionHash: questionHash,
            answerType: OracleAttestation.ANSWER_ADDRESS_LIST,
            answer: abi.encode(leaders),
            figure: inc.total * 7 / 10,
            fromBlock: inc.fromBlock,
            toBlock: inc.toBlock,
            blockHash: blockhash(block.number - 1),
            panelJobId: keccak256("panel"),
            panelSize: 7,
            quorum: 5,
            agreed: 6,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 3600)
        });
    }

    // ---- bytes ----

    function _inner(bytes memory data) internal pure returns (bytes memory reason) {
        if (data.length < 4 || bytes4(data) != CustomRevert.WrappedError.selector) return data;
        (,, reason,) = abi.decode(_tail(data), (address, bytes4, bytes, bytes));
    }

    function _tail(bytes memory data) internal pure returns (bytes memory body) {
        body = new bytes(data.length - 4);
        for (uint256 i = 0; i < body.length; i++) {
            body[i] = data[i + 4];
        }
    }

    receive() external payable {}
}
