import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { oracleBody, questionDocument, questionHash, canonicalDocument } from "../src/question";

describe("the oracle question", () => {
  it("matches the desk's on-chain document byte for byte", () => {
    // test_file_bodyGolden in test/CurbDeskIncidents.t.sol.
    const doc =
      '{"answerType":"address[]","chainId":4663,"head":1,"question":"On Robinhood Chain, between L2 blocks 92000000 and 92003000, rank the trader keys of the Trade(address indexed trader, uint256 volume) events emitted by contract 0x00000000000000000000000000000000000c0b0b by their summed volume. Which trader address has the largest summed volume? Answer a list holding that one address.","v":1,"window":{"fromBlock":92000000,"toBlock":92003000}}';
    const hook = "0x00000000000000000000000000000000000C0b0B";
    expect(questionDocument(hook, 92000000n, 92003000n)).toBe(doc);
    expect(oracleBody(hook, 92000000n, 92003000n)).toBe(
      doc.slice(0, -1) + ',"panelSize":7,"quorum":5,"validForSeconds":3600}',
    );
    expect(questionHash(hook, 92000000n, 92003000n)).toBe(keccak256(toBytes(doc)));
  });

  it("reproduces the protocol's conformance vector", () => {
    const doc = canonicalDocument({
      question: "Which Uniswap v4 pool did the most WETH volume in the last day?",
      chainId: 1,
      fromBlock: 100n,
      toBlock: 200n,
      answerType: "bytes32[]",
      head: 1,
      definitions: { denomination: "WETH, summed as the absolute swapped amount on the WETH side" },
    });
    expect(keccak256(toBytes(doc))).toBe("0x2117f4362ebfa37aa8a8c0fed548604fe09ac46faf8ae7559cd64780f26a46fb");
  });
});
