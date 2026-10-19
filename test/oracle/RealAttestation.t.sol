// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAttestation, OracleAttestationConsumer} from "../../src/oracle/OracleAttestation.sol";

contract VerifyingConsumer is OracleAttestationConsumer {
    constructor(address signer) OracleAttestationConsumer(signer) {}

    function verify(OracleAttestation.Attestation calldata a, bytes calldata signature) external view {
        _verifyAttestation(a, signature);
    }
}

/// @notice The library Curb vendors accepts a signature the live oracle actually produced: request
/// 2f590561, an IMD/ETH spot figure signed on 2026-10-18 for imdUSD's SpotFeed on Ethereum
/// (`test/fixtures/oracle_attestation_sample.json`, from `GET /oracle/requests/:id/attestation`).
/// Self-signed tests prove the code agrees with itself; this one proves it agrees with the oracle.
contract RealAttestationTest is Test {
    address constant SPOT_FEED = 0x77E1684402869Bf2B7c70B8bf21E1C7Ca7104951;
    address constant ORACLE_SIGNER = 0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982;
    bytes constant SIGNATURE =
        hex"bce5826e9defd63d3ac39564819cbf8f448442853c072670cc18439419f70be23de7d26f79dd2b2d8fc979a8120b06e31f60857c7e81cfb21e07d9895fdf75631c";

    VerifyingConsumer consumer;

    function setUp() public {
        vm.chainId(1);
        deployCodeTo("RealAttestation.t.sol:VerifyingConsumer", abi.encode(ORACLE_SIGNER), SPOT_FEED);
        consumer = VerifyingConsumer(SPOT_FEED);
        vm.warp(1792362817);
    }

    function sample() internal pure returns (OracleAttestation.Attestation memory) {
        return OracleAttestation.Attestation({
            requestId: 0x2f59056163c64a5d8286553cd8c6270f00000000000000000000000000000000,
            chainId: 1,
            questionHash: 0x2fe76f0542b845e9a2f2e33dfc1317c70a25ef1b62759d1ed0f177ffaa2dcc47,
            answerType: OracleAttestation.ANSWER_UINT256,
            answer: hex"0000000000000000000000000000000000000000000000000007b8538950915e",
            figure: 2172993762529630,
            fromBlock: 26222154,
            toBlock: 26222452,
            blockHash: 0x4409eca1c28234dc10e91d3c23f1a20c11862cb49aee49f2abb66cc5c1da320b,
            panelJobId: 0xfbc3cc637c4c4c95b10c1e13117f679d00000000000000000000000000000000,
            panelSize: 100,
            quorum: 67,
            agreed: 68,
            issuedAt: 1792362817,
            expiresAt: 1792449217
        });
    }

    function test_realSignatureFromLiveOracle() public view {
        consumer.verify(sample(), SIGNATURE);
    }

    function test_tamperedFigureFails() public {
        OracleAttestation.Attestation memory a = sample();
        a.figure += 1;
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        consumer.verify(a, SIGNATURE);
    }

    function test_otherConsumerFails() public {
        deployCodeTo("RealAttestation.t.sol:VerifyingConsumer", abi.encode(ORACLE_SIGNER), address(0xC0B));
        vm.expectRevert(OracleAttestationConsumer.BadSignature.selector);
        VerifyingConsumer(address(0xC0B)).verify(sample(), SIGNATURE);
    }
}
