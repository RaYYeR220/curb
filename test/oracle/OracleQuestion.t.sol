// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {OracleAttestation} from "../../src/oracle/OracleAttestation.sol";
import {OracleQuestion} from "../../src/oracle/OracleQuestion.sol";

/// @notice The protocol's own question vector: the copy of `OracleQuestion` Curb ships hashes it to
/// the `questionHash` the oracle signed in the conformance attestation.
contract OracleQuestionTest is Test {
    function test_protocolVectorHash() public pure {
        OracleQuestion.Question memory q;
        q.question = "Which Uniswap v4 pool did the most WETH volume in the last day?";
        q.chainId = 1;
        q.fromBlock = 100;
        q.toBlock = 200;
        q.answerType = OracleAttestation.ANSWER_BYTES32_LIST;
        q.head = 1;
        q.definitions = new OracleQuestion.Definition[](1);
        q.definitions[0] =
            OracleQuestion.Definition("denomination", "WETH, summed as the absolute swapped amount on the WETH side");
        assertEq(OracleQuestion.hash(q), 0x2117f4362ebfa37aa8a8c0fed548604fe09ac46faf8ae7559cd64780f26a46fb);
    }
}
