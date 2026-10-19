// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleAttestation} from "../../src/oracle/OracleAttestation.sol";
import {CurbDesk} from "../../desk/CurbDesk.sol";
import {IIntake} from "../../src/interfaces/IIntake.sol";
import {ILaunchFactory} from "../../src/interfaces/ILaunchFactory.sol";

/// @dev CurbDesk with a way to hold a request pending for a given question, so the protocol's
/// vector can be presented to the real callback.
contract DeskHarness is CurbDesk {
    constructor(IIntake intake_, IERC20 imd_, ILaunchFactory factory_, address signer_, address steward_)
        CurbDesk(intake_, imd_, factory_, signer_, steward_)
    {}

    function holdPending(bytes32 requestId, address hook, uint32 nonce, bytes32 questionHash) external {
        pending[requestId] = Pending(hook, nonce, questionHash);
    }
}

/// @notice IMD's consumer conformance test, adapted to CurbDesk: deployed at the protocol's vector
/// address with the vector's attester as its oracle signer, it must reproduce the protocol's digest
/// and expose the canonical callback. The vector's answer is a `bytes32[]`, which the desk refuses
/// by design, so the acceptance check signs an `address[]` answer to the same question with the
/// vector's key, as the protocol's instructions say.
contract DeskConformanceTest is Test {
    // ---- the protocol's vector: do not change these ----
    uint256 constant VECTOR_CHAIN = 11155111;
    address constant VECTOR_CONSUMER = 0x0000000000000000000000000000000000002748;
    bytes32 constant VECTOR_DIGEST = 0x95fefa8b7c529852f4e2b6aec888930eb2bf5078e6443a85808e36df19e1325c;
    address constant SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 constant SIGNER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint64 constant ISSUED_AT = 1800000000;
    uint64 constant EXPIRES_AT = 1800003600;
    string constant CALLBACK =
        "onOracleResult(bytes32,(bytes32,uint256,bytes32,uint8,bytes,uint256,uint64,uint64,bytes32,bytes32,uint16,uint16,uint16,uint64,uint64),bytes)";

    address constant INTAKE = address(0x1A7A);
    DeskHarness desk;

    function setUp() public {
        vm.chainId(VECTOR_CHAIN);
        vm.warp(ISSUED_AT);
        deployCodeTo(
            "DeskConformance.t.sol:DeskHarness",
            abi.encode(INTAKE, address(0x1111), address(0x2222), SIGNER, address(this)),
            VECTOR_CONSUMER
        );
        desk = DeskHarness(VECTOR_CONSUMER);
    }

    function vector() internal pure returns (OracleAttestation.Attestation memory a) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = bytes32(uint256(1));
        a = OracleAttestation.Attestation({
            requestId: 0x0000000000004000800000000000000100000000000000000000000000000000,
            chainId: 1,
            questionHash: 0x2117f4362ebfa37aa8a8c0fed548604fe09ac46faf8ae7559cd64780f26a46fb,
            answerType: OracleAttestation.ANSWER_BYTES32_LIST,
            answer: abi.encode(ids),
            figure: 12345,
            fromBlock: 100,
            toBlock: 200,
            blockHash: bytes32(uint256(7)),
            panelJobId: 0x0000000000004000800000000000000200000000000000000000000000000000,
            panelSize: 5,
            quorum: 4,
            agreed: 5,
            issuedAt: ISSUED_AT,
            expiresAt: EXPIRES_AT
        });
    }

    function test_digestMatchesTheProtocol() public view {
        assertEq(
            desk.attestationDigest(vector()), VECTOR_DIGEST, "struct, type string or domain differs from the protocol's"
        );
    }

    function test_callbackSelectorIsCanonical() public view {
        assertEq(
            desk.onOracleResult.selector,
            bytes4(keccak256(bytes(CALLBACK))),
            "callback parameters differ from the protocol's"
        );
    }

    function test_acceptsAFreshSignatureFromTheVectorKey() public {
        OracleAttestation.Attestation memory a = vector();
        a.requestId = keccak256("another request");
        a.answerType = OracleAttestation.ANSWER_ADDRESS_LIST;
        address[] memory leaders = new address[](1);
        leaders[0] = address(0xBEEF);
        a.answer = abi.encode(leaders);
        a.panelSize = 7;
        a.quorum = 5;
        a.agreed = 7;
        bytes32 id = keccak256("intake request");
        desk.holdPending(id, address(0xC0B), 0, a.questionHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, desk.attestationDigest(a));
        vm.prank(INTAKE);
        desk.onOracleResult(id, a, abi.encodePacked(r, s, v));
        assertTrue(desk.consumed(a.requestId));
    }
}
