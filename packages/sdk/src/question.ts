import { keccak256, toBytes, type Address } from "viem";

/** The oracle's answer types, as the request body names them. */
export type AnswerType = "bool" | "address" | "bytes32" | "uint256" | "address[]" | "bytes32[]";

export interface Question {
  question: string;
  chainId: number;
  fromBlock: bigint;
  toBlock: bigint;
  answerType: AnswerType;
  head?: number;
  panelEvidence?: boolean;
  definitions?: Record<string, string>;
}

/** CurbDesk's panel: seven seats, five must agree, the answer is good for an hour. */
export const PANEL_SIZE = 7;
export const QUORUM = 5;
export const VALID_FOR = 3600;
export const ROBINHOOD_CHAIN_ID = 4663;

/**
 * The document's members in canonical order: keys sorted, strings as JSON.stringify writes them,
 * integers in decimal. The same bytes OracleQuestion.sol builds on chain.
 */
function members(q: Question): string {
  let m = `{"answerType":"${q.answerType}","chainId":${q.chainId}`;
  const defs = q.definitions ? Object.keys(q.definitions).sort() : [];
  if (defs.length > 0) {
    m += `,"definitions":{${defs.map((k) => `${JSON.stringify(k)}:${JSON.stringify(q.definitions![k])}`).join(",")}}`;
  }
  if (q.panelEvidence) m += `,"evidence":"panel"`;
  if (q.head) m += `,"head":${q.head}`;
  m += `,"question":${JSON.stringify(q.question)},"v":1,"window":{"fromBlock":${q.fromBlock},"toBlock":${q.toBlock}}`;
  return m;
}

export function canonicalDocument(q: Question): string {
  return `${members(q)}}`;
}

export function requestBody(q: Question, panelSize: number, quorum: number, validForSeconds: number): string {
  return `${members(q)},"panelSize":${panelSize},"quorum":${quorum},"validForSeconds":${validForSeconds}}`;
}

/** The question CurbDesk asks about a hook's halt: who did the most volume on its Trade tape. */
export function deskQuestion(hook: Address, fromBlock: bigint, toBlock: bigint): Question {
  return {
    question:
      `On Robinhood Chain, between L2 blocks ${fromBlock} and ${toBlock}, rank the trader keys of the ` +
      `Trade(address indexed trader, uint256 volume) events emitted by contract ${hook.toLowerCase()} by their ` +
      `summed volume. Which trader address has the largest summed volume? Answer a list holding that one address.`,
    chainId: ROBINHOOD_CHAIN_ID,
    fromBlock,
    toBlock,
    answerType: "address[]",
    head: 1,
  };
}

export function questionDocument(hook: Address, fromBlock: bigint, toBlock: bigint): string {
  return canonicalDocument(deskQuestion(hook, fromBlock, toBlock));
}

export function questionHash(hook: Address, fromBlock: bigint, toBlock: bigint): `0x${string}` {
  return keccak256(toBytes(questionDocument(hook, fromBlock, toBlock)));
}

export function oracleBody(hook: Address, fromBlock: bigint, toBlock: bigint): string {
  return requestBody(deskQuestion(hook, fromBlock, toBlock), PANEL_SIZE, QUORUM, VALID_FOR);
}
