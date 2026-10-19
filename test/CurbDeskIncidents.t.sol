// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {CurbDesk} from "../src/CurbDesk.sol";
import {CurbHook} from "../src/CurbHook.sol";
import {ICurbHook} from "../src/interfaces/ICurbHook.sol";
import {Breaker} from "../src/libraries/Breaker.sol";
import {OracleAttestation, OracleAttestationConsumer} from "../src/oracle/OracleAttestation.sol";
import {OracleQuestion} from "../src/oracle/OracleQuestion.sol";
import {CurbFixture} from "./utils/CurbFixture.sol";
import {MockIntake} from "./utils/MockIntake.sol";
import {MockLaunchFactory} from "./utils/MockLaunchFactory.sol";

contract CurbDeskIncidentsTest is CurbFixture {
    bytes32 constant LAUNCH_OPEN = bytes32("launch.open@launch-1");
    bytes32 constant ORACLE_REQUEST = bytes32("oracle.request@oracle-1");
    bytes32 constant JOB_OPEN = bytes32("job.open@job-1");
    uint256 constant PRICE = 0.5 ether;
    uint256 constant SIGNER_KEY = 0xA11CE;
    uint64 constant LAUNCH = 2400;

    address steward = makeAddr("steward");
    MockIntake intake;
    MockLaunchFactory factory;
    CurbDesk desk;

    function curbIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function setUp() public override {
        super.setUp();
        vm.chainId(4663);
        intake = new MockIntake();
        intake.setPrice(LAUNCH_OPEN, address(imd), PRICE);
        intake.setPrice(ORACLE_REQUEST, address(imd), PRICE);
        intake.setPrice(JOB_OPEN, address(imd), PRICE);
        factory = new MockLaunchFactory();
        desk = new CurbDesk(intake, IERC20(address(imd)), factory, vm.addr(SIGNER_KEY), steward);
        // The launch pool, on a hook the desk owns.
        hook = deployHook(address(curb), FACTORY, address(desk), 51);
        key = keyFor(hook);
        vm.prank(FACTORY);
        manager.initialize(key, SQRT_PRICE_1_1);
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(FULL_LOWER, FULL_UPPER, int256(uint256(LIQUIDITY)), 0), "");
        factory.setPosition(LAUNCH, key, address(desk));
        vm.prank(steward);
        desk.bind(LAUNCH);
    }

    // ---- helpers ----

    function _halt() internal returns (uint32 nonce) {
        moveTo(400);
        moveTo(950);
        vm.warp(block.timestamp + LIMIT);
        vm.roll(block.number + 20);
        ICurbHook.Status memory s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Halted));
        return s.nonce;
    }

    function _fileFunded() internal returns (bytes32 id, uint32 nonce) {
        nonce = _halt();
        imd.mint(address(desk), PRICE);
        id = desk.fileIncident(address(hook));
    }

    function _attestation(bytes32 id, address leader, uint256 figure) internal view returns (OracleAttestation.Attestation memory a) {
        (, , bytes32 questionHash) = desk.pending(id);
        address[] memory leaders = new address[](1);
        leaders[0] = leader;
        (uint64 fromBlock, uint64 toBlock,) = hook.incidentWindow();
        a = OracleAttestation.Attestation({
            requestId: keccak256(abi.encode("oracle", id)),
            chainId: 4663,
            questionHash: questionHash,
            answerType: OracleAttestation.ANSWER_ADDRESS_LIST,
            answer: abi.encode(leaders),
            figure: figure,
            fromBlock: fromBlock,
            toBlock: toBlock,
            blockHash: bytes32(uint256(7)),
            panelJobId: bytes32(uint256(8)),
            panelSize: 7,
            quorum: 5,
            agreed: 6,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp + 3600)
        });
    }

    function _sign(OracleAttestation.Attestation memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, desk.attestationDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function _deliver(bytes32 id, OracleAttestation.Attestation memory a) internal returns (bool) {
        return intake.deliver(id, abi.encode(id, a, _sign(a)));
    }

    function _share(bytes32 id, uint256 bps) internal view returns (OracleAttestation.Attestation memory) {
        (,, uint256 total) = hook.incidentWindow();
        return _attestation(id, address(0xBEEF), total * bps / 10_000);
    }

    // ---- filing ----

    function test_file_requiresHalted() public {
        imd.mint(address(desk), PRICE);
        vm.expectRevert(CurbDesk.NotHalted.selector);
        desk.fileIncident(address(hook));
    }

    function test_file_unknownPool() public {
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.UnknownPool.selector, address(0xDEAD)));
        desk.fileIncident(address(0xDEAD));
    }

    function test_file_oncePerNonce() public {
        (, uint32 nonce) = _fileFunded();
        imd.mint(address(desk), PRICE);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.AlreadyFiled.selector, nonce));
        desk.fileIncident(address(hook));
    }

    function test_file_treasuryShort_exactArgs() public {
        _halt();
        imd.mint(address(desk), PRICE - 1);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.TreasuryShort.selector, PRICE - 1, PRICE));
        desk.fileIncident(address(hook));
    }

    function test_file_launchPoolSweepsFees_tryCatch() public {
        _halt();
        // A claim that pays: the fees cover the question.
        imd.mint(address(factory), PRICE);
        factory.setFees(IERC20(address(imd)), PRICE, false);
        desk.fileIncident(address(hook));
        assertEq(factory.claims(), 1);
    }

    function test_file_reentryFromFeeClaimFilesOnce() public {
        _halt();
        factory.setReenter(address(desk), address(hook));
        imd.mint(address(desk), 2 * PRICE);
        desk.fileIncident(address(hook));
        assertFalse(factory.reentered(), "a re-entrant fileIncident went through");
        assertEq(intake.pulled(), PRICE);
    }

    function test_file_claimRevertDoesNotBlockFiling() public {
        _halt();
        factory.setFees(IERC20(address(imd)), 0, true);
        imd.mint(address(desk), PRICE);
        bytes32 id = desk.fileIncident(address(hook));
        assertTrue(id != bytes32(0));
    }

    function test_file_requestShape() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        MockIntake.Stored memory r = intake.requestOf(id);
        assertEq(r.action, ORACLE_REQUEST);
        assertEq(r.target, address(desk));
        assertEq(r.selector, desk.onOracleResult.selector);
        assertEq(r.onFailure, desk.onRequestFailure.selector);
        assertEq(r.amount, PRICE);
        (uint64 fromBlock, uint64 toBlock, uint256 total) = hook.incidentWindow();
        (bytes memory body, bytes32 questionHash) = desk.oracleBody(address(hook), fromBlock, toBlock);
        assertEq(r.body, body);
        (address pHook, uint32 pNonce, bytes32 pHash) = desk.pending(id);
        assertEq(pHook, address(hook));
        assertEq(pNonce, nonce);
        assertEq(pHash, questionHash);
        CurbDesk.Incident memory inc = desk.incident(address(hook), nonce);
        assertEq(uint8(inc.state), uint8(CurbDesk.IncidentState.Filed));
        assertEq(inc.total, total);
        assertEq(inc.requestId, id);
    }

    function test_file_bodyGolden() public view {
        (bytes memory body, bytes32 questionHash) =
            desk.oracleBody(address(0xc0b0b), 92000000, 92003000);
        bytes memory doc = bytes(
            '{"answerType":"address[]","chainId":4663,"head":1,"question":"On Robinhood Chain, between L2 blocks 92000000 and 92003000, rank the trader keys of the Trade(address indexed trader, uint256 volume) events emitted by contract 0x00000000000000000000000000000000000c0b0b by their summed volume. Which trader address has the largest summed volume? Answer a list holding that one address.","v":1,"window":{"fromBlock":92000000,"toBlock":92003000}'
        );
        assertEq(body, bytes.concat(doc, ',"panelSize":7,"quorum":5,"validForSeconds":3600}'));
        assertEq(questionHash, keccak256(bytes.concat(doc, "}")));
    }

    function test_file_windowTooFresh() public {
        moveTo(400);
        moveTo(950);
        vm.warp(block.timestamp + LIMIT);
        vm.roll(block.number + 3);
        imd.mint(address(desk), PRICE);
        (, uint64 toBlock,) = hook.incidentWindow();
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.WindowTooFresh.selector, toBlock, toBlock + 3));
        desk.fileIncident(address(hook));
    }

    // ---- settling ----

    function test_settle_organic_resolvesOrganic() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        assertTrue(_deliver(id, _share(id, 2999)));
        CurbDesk.Incident memory inc = desk.incident(address(hook), nonce);
        assertEq(uint8(inc.state), uint8(CurbDesk.IncidentState.Answered));
        assertEq(uint8(inc.verdict), uint8(Breaker.Verdict.Organic));
        assertTrue(inc.applied);
        assertEq(inc.leader, address(0xBEEF));
        assertTrue(hook.isLive());
    }

    function _verdictFor(uint256 bps) internal returns (Breaker.Verdict v, bool applied) {
        (bytes32 id, uint32 nonce) = _fileFunded();
        (,, uint256 total) = hook.incidentWindow();
        OracleAttestation.Attestation memory a = _attestation(id, address(0xBEEF), total * bps / 10_000);
        // Round the figure so the share is exactly `bps`.
        if (a.figure * 10_000 / total != bps) a.figure += 1;
        assertTrue(_deliver(id, a));
        CurbDesk.Incident memory inc = desk.incident(address(hook), nonce);
        assertEq(inc.shareBps, bps);
        return (inc.verdict, inc.applied);
    }

    function test_settle_boundary_3000Organic() public {
        (Breaker.Verdict v, bool applied) = _verdictFor(3000);
        assertEq(uint8(v), uint8(Breaker.Verdict.Organic));
        assertTrue(applied);
    }

    function test_settle_boundary_3001Inconclusive() public {
        (Breaker.Verdict v, bool applied) = _verdictFor(3001);
        assertEq(uint8(v), uint8(Breaker.Verdict.Inconclusive));
        assertFalse(applied);
        assertEq(uint8(hook.status().phase), uint8(Breaker.Phase.Halted));
    }

    function test_settle_boundary_5999Inconclusive() public {
        (Breaker.Verdict v,) = _verdictFor(5999);
        assertEq(uint8(v), uint8(Breaker.Verdict.Inconclusive));
    }

    function test_settle_boundary_6000Concentrated() public {
        (Breaker.Verdict v, bool applied) = _verdictFor(6000);
        assertEq(uint8(v), uint8(Breaker.Verdict.Concentrated));
        assertTrue(applied);
        assertEq(uint8(hook.status().verdict), uint8(Breaker.Verdict.Concentrated));
    }

    function test_settle_figureAboveTotal_inconclusive() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        (,, uint256 total) = hook.incidentWindow();
        assertTrue(_deliver(id, _attestation(id, address(0xBEEF), total + 1)));
        assertEq(uint8(desk.incident(address(hook), nonce).verdict), uint8(Breaker.Verdict.Inconclusive));
    }

    function test_classify_totalZero_inconclusive() public view {
        (Breaker.Verdict v, uint16 bps) = desk.classify(5, 0);
        assertEq(uint8(v), uint8(Breaker.Verdict.Inconclusive));
        assertEq(bps, 0);
    }

    function test_settle_listLengthNotOne_inconclusive() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 9000);
        a.answer = abi.encode(new address[](2));
        assertTrue(_deliver(id, a));
        assertEq(uint8(desk.incident(address(hook), nonce).verdict), uint8(Breaker.Verdict.Inconclusive));
    }

    function test_settle_wrongSender() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        bytes memory sig = _sign(a);
        vm.expectRevert(CurbDesk.NotTheIntake.selector);
        desk.onOracleResult(id, a, sig);
    }

    function test_settle_unknownRequest() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        bytes memory sig = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.UnknownRequest.selector, bytes32(uint256(1))));
        desk.submitAttestation(bytes32(uint256(1)), a, sig);
    }

    function test_settle_wrongQuestion() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        bytes32 asked = a.questionHash;
        a.questionHash = keccak256("another question");
        bytes memory sig = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.WrongQuestion.selector, asked, a.questionHash));
        desk.submitAttestation(id, a, sig);
    }

    function test_settle_weakPanel() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        a.agreed = 4;
        bytes memory sig = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.PanelTooWeak.selector, uint16(7), uint16(4)));
        desk.submitAttestation(id, a, sig);
        a.agreed = 6;
        a.panelSize = 5;
        sig = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.PanelTooWeak.selector, uint16(5), uint16(6)));
        desk.submitAttestation(id, a, sig);
    }

    function test_settle_expired() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        a.expiresAt = uint64(block.timestamp - 1);
        bytes memory sig = _sign(a);
        vm.expectRevert(abi.encodeWithSelector(OracleAttestationConsumer.AttestationExpired.selector, a.expiresAt));
        desk.submitAttestation(id, a, sig);
    }

    function test_settle_badSignature() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, desk.attestationDigest(a));
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        desk.submitAttestation(id, a, abi.encodePacked(r, s, v));
    }

    function test_submitAttestation_anyoneCanPush() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 7000);
        bytes memory sig = _sign(a);
        vm.prank(makeAddr("keeper"));
        desk.submitAttestation(id, a, sig);
        assertEq(uint8(desk.incident(address(hook), nonce).verdict), uint8(Breaker.Verdict.Concentrated));
    }

    function test_answer_lateAfterHaltClosed_recordedNotApplied() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        vm.warp(block.timestamp + HALT);
        moveTo(900);
        assertTrue(_deliver(id, _share(id, 1000)));
        CurbDesk.Incident memory inc = desk.incident(address(hook), nonce);
        assertEq(uint8(inc.state), uint8(CurbDesk.IncidentState.Answered));
        assertEq(uint8(inc.verdict), uint8(Breaker.Verdict.Organic));
        assertFalse(inc.applied);
    }

    function test_answer_pushAfterCallback_refused() public {
        (bytes32 id,) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 1000);
        bytes memory sig = _sign(a);
        assertTrue(intake.deliver(id, abi.encode(id, a, sig)));
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.UnknownRequest.selector, id));
        desk.submitAttestation(id, a, sig);
    }

    function test_answer_forOldNonce_neverTouchesNewIncident() public {
        (bytes32 id, uint32 first) = _fileFunded();
        OracleAttestation.Attestation memory a = _share(id, 9000);
        // The first halt runs out, the pool cools down and halts again.
        vm.warp(block.timestamp + HALT);
        moveTo(900);
        vm.warp(block.timestamp + COOLDOWN);
        moveTo(910);
        moveTo(1850);
        vm.warp(block.timestamp + LIMIT);
        ICurbHook.Status memory s = hook.status();
        assertEq(uint8(s.phase), uint8(Breaker.Phase.Halted));
        assertEq(s.nonce, first + 1);
        a.issuedAt = uint64(block.timestamp);
        a.expiresAt = uint64(block.timestamp + 3600);
        assertTrue(intake.deliver(id, abi.encode(id, a, _sign(a))));
        assertFalse(desk.incident(address(hook), first).applied);
        assertEq(uint8(hook.status().verdict), uint8(Breaker.Verdict.None));
    }

    // ---- gas and failures ----

    function test_callback_fitsIn200k() public {
        (bytes32 id,) = _fileFunded();
        uint256 before = gasleft();
        assertTrue(_deliver(id, _share(id, 6500)), "the callback did not finish under the 200,000 gas stipend");
        assertLt(before - gasleft(), 400_000);
        assertTrue(desk.consumed(keccak256(abi.encode("oracle", id))));
    }

    function test_failure_marksFailed_noRefile() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        assertTrue(intake.fail(id, 2, bytes32("disagreed")));
        assertEq(uint8(desk.incident(address(hook), nonce).state), uint8(CurbDesk.IncidentState.Failed));
        imd.mint(address(desk), PRICE);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.AlreadyFiled.selector, nonce));
        desk.fileIncident(address(hook));
        assertEq(intake.pulled(), PRICE);
    }

    // ---- post-mortem ----

    function test_postMortem_needsTwoPrices() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        assertTrue(_deliver(id, _share(id, 7000)));
        imd.mint(address(desk), PRICE);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.TreasuryShort.selector, PRICE, 2 * PRICE));
        desk.commissionPostMortem(address(hook), nonce);
    }

    function test_postMortem_requiresAnswer() public {
        (, uint32 nonce) = _fileFunded();
        imd.mint(address(desk), 2 * PRICE);
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.NotAnswered.selector, nonce));
        desk.commissionPostMortem(address(hook), nonce);
    }

    function test_postMortem_bodyAndResult() public {
        (bytes32 id, uint32 nonce) = _fileFunded();
        assertTrue(_deliver(id, _share(id, 7000)));
        imd.mint(address(desk), 2 * PRICE);
        bytes32 job = desk.commissionPostMortem(address(hook), nonce);
        MockIntake.Stored memory r = intake.requestOf(job);
        assertEq(r.action, JOB_OPEN);
        assertEq(r.body, desk.postMortemBody(address(hook), nonce));
        assertEq(imd.balanceOf(address(desk)), PRICE);
        string memory body = string(r.body);
        assertTrue(_contains(body, '"template":"research"'));
        assertTrue(_contains(body, "Concentrated"));
        assertTrue(intake.deliver(job, abi.encode(job, keccak256("report"), "https://api.imd.fun/jobs/x/report.md")));
        assertEq(desk.incident(address(hook), nonce).reportUri, "https://api.imd.fun/jobs/x/report.md");
        vm.expectRevert(abi.encodeWithSelector(CurbDesk.AlreadyCommissioned.selector, nonce));
        desk.commissionPostMortem(address(hook), nonce);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        for (uint256 i = 0; i + n.length <= h.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length && ok; j++) {
                ok = h[i + j] == n[j];
            }
            if (ok) return true;
        }
        return false;
    }

    function test_question_isCanonical() public view {
        OracleQuestion.Question memory q = desk.question(address(hook), 1, 2);
        assertEq(q.answerType, OracleAttestation.ANSWER_ADDRESS_LIST);
        assertEq(q.head, 1);
        assertEq(q.chainId, 4663);
        assertFalse(q.panelEvidence);
        assertEq(q.definitions.length, 0);
    }
}
