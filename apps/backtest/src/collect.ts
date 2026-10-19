import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import type { Cache } from "./cache";
import { ETH, FACTORY, IMD, MAX_LOG_SPAN, POOL_MANAGER } from "./config";
import { RpcError, type Rpc } from "./rpc";
import type { LiquidityEvent, PoolData, SwapEvent } from "./types";

const events = parseAbi([
  "event Launched(uint64 indexed launchNumber, address indexed token, address indexed hook, address distributor, uint128 liquiditySeeded)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
const factoryAbi = parseAbi([
  "function positionOf(uint64 launchNumber) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, int24 tickLower, int24 tickUpper, address requester)",
]);
const erc20Abi = parseAbi(["function symbol() view returns (string)"]);

const topic = (name: string) => toEventSelector(events.find((e) => e.name === name)!);
const LAUNCHED = topic("Launched");
const INITIALIZE = topic("Initialize");
const SWAP = topic("Swap");
const MODIFY = topic("ModifyLiquidity");

interface RawLog {
  block: number;
  index: number;
  tx: Hex;
  topics: [Hex, ...Hex[]];
  data: Hex;
}

interface RpcLog {
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
  topics: [Hex, ...Hex[]];
  data: Hex;
}

interface Position {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  tickLower: number;
  tickUpper: number;
  requester: Address;
  symbol: string;
}

export interface Collected {
  head: { block: number; time: number };
  since: { block: number; time: number };
  pools: PoolData[];
}

const hex = (n: number) => `0x${n.toString(16)}`;

export class Collector {
  private times: Record<string, number>;
  private senders: Record<string, Address>;

  constructor(
    private readonly rpc: Rpc,
    private readonly cache: Cache,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.times = cache.read<Record<string, number>>("blocks.json") ?? {};
    this.senders = cache.read<Record<string, Address>>("senders.json") ?? {};
  }

  async collect(days: number, toBlock?: number): Promise<Collected> {
    const headBlock = toBlock ?? Number(BigInt(await this.rpc.call<Hex>("eth_blockNumber", [])));
    const headTime = (await this.timestamps([headBlock]))[0]!;
    const sinceTime = headTime - days * 86_400;
    const sinceBlock = await this.blockAt(sinceTime, headBlock);
    this.log(`window: L2 ${sinceBlock} -> ${headBlock} (${new Date(sinceTime * 1000).toISOString()} -> ${new Date(headTime * 1000).toISOString()})`);

    const launched = await this.logs("launched", FACTORY, [LAUNCHED], sinceBlock, headBlock);
    this.log(`launches: ${launched.length}`);
    const pools: PoolData[] = [];
    for (const raw of launched) {
      const ev = decodeEventLog({ abi: events, eventName: "Launched", topics: raw.topics, data: raw.data });
      const n = Number(ev.args.launchNumber);
      const token = ev.args.token.toLowerCase() as Address;
      const pos = await this.position(n, token, headBlock);
      const poolId = keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
          [pos.currency0, pos.currency1, pos.fee, pos.tickSpacing, pos.hooks],
        ),
      );
      if (pos.hooks.toLowerCase() !== ev.args.hook.toLowerCase()) throw new Error(`launch ${n}: positionOf hook differs from Launched`);
      const pairedIs0 = pos.currency1.toLowerCase() === token;
      const paired = (pairedIs0 ? pos.currency0 : pos.currency1).toLowerCase() as Address;
      if (paired !== IMD && paired !== ETH) this.log(`launch ${n}: paired with ${paired}, neither IMD nor ETH`);

      const init = await this.logs(`init-${poolId}`, POOL_MANAGER, [INITIALIZE, poolId], raw.block, raw.block);
      if (init.length !== 1) throw new Error(`launch ${n}: ${init.length} Initialize events in its block`);
      const initEv = decodeEventLog({ abi: events, eventName: "Initialize", topics: init[0]!.topics, data: init[0]!.data });

      const swapLogs = await this.logs(`swap-${poolId}`, POOL_MANAGER, [SWAP, poolId], raw.block, headBlock);
      const modLogs = await this.logs(`modify-${poolId}`, POOL_MANAGER, [MODIFY, poolId], raw.block, headBlock);
      this.log(`launch ${n} ${pos.symbol}: ${swapLogs.length} swaps, ${modLogs.length} liquidity changes`);

      const swaps: SwapEvent[] = swapLogs.map((l) => {
        const s = decodeEventLog({ abi: events, eventName: "Swap", topics: l.topics, data: l.data }).args;
        return {
          kind: "swap",
          block: l.block,
          index: l.index,
          time: 0,
          tx: l.tx,
          trader: ETH,
          amount0: s.amount0,
          amount1: s.amount1,
          liquidity: s.liquidity,
          tick: s.tick,
        };
      });
      const mods: LiquidityEvent[] = modLogs.map((l) => {
        const m = decodeEventLog({ abi: events, eventName: "ModifyLiquidity", topics: l.topics, data: l.data }).args;
        return { kind: "liquidity", block: l.block, index: l.index, tickLower: m.tickLower, tickUpper: m.tickUpper, delta: m.liquidityDelta };
      });

      pools.push({
        launchNumber: n,
        token,
        symbol: pos.symbol,
        hook: ev.args.hook.toLowerCase() as Address,
        requester: pos.requester.toLowerCase() as Address,
        paired,
        pairedIs0,
        poolId,
        fee: pos.fee,
        tickSpacing: pos.tickSpacing,
        launchBlock: raw.block,
        launchTime: 0,
        initTick: initEv.args.tick,
        seeded: ev.args.liquiditySeeded,
        seedLower: pos.tickLower,
        seedUpper: pos.tickUpper,
        events: [...swaps, ...mods].sort((a, b) => a.block - b.block || a.index - b.index),
      });
    }

    const swapsAll = pools.flatMap((p) => p.events.filter((e): e is SwapEvent => e.kind === "swap"));
    await this.swapBlocks(swapsAll);
    await this.timestamps(pools.map((p) => p.launchBlock));
    for (const p of pools) {
      p.launchTime = this.times[p.launchBlock]!;
      for (const e of p.events) {
        if (e.kind !== "swap") continue;
        e.time = this.times[e.block]!;
        e.trader = this.senders[e.tx]!;
      }
    }
    return { head: { block: headBlock, time: headTime }, since: { block: sinceBlock, time: sinceTime }, pools };
  }

  /**
   * Timestamps and senders for every swap, one full block per call: the endpoint meters calls, not
   * bytes, so this is half the calls of a block header plus a transaction lookup per swap.
   */
  private async swapBlocks(swaps: SwapEvent[]): Promise<void> {
    const wanted = new Map<number, Set<Hex>>();
    for (const s of swaps) {
      if (this.times[s.block] !== undefined && this.senders[s.tx] !== undefined) continue;
      if (!wanted.has(s.block)) wanted.set(s.block, new Set());
      wanted.get(s.block)!.add(s.tx);
    }
    const blocks = [...wanted.keys()];
    this.log(`blocks to read: ${blocks.length} (of ${new Set(swaps.map((s) => s.block)).size} with swaps)`);
    const step = 250;
    for (let i = 0; i < blocks.length; i += step) {
      const part = blocks.slice(i, i + step);
      const res = await this.rpc.batch<{ timestamp: Hex; transactions: { hash: Hex; from: Address }[] } | null>(
        part.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), true] })),
      );
      const missed: Hex[] = [];
      res.forEach((r, j) => {
        const b = part[j]!;
        if (!r) throw new Error(`block ${b} not found`);
        this.times[b] = Number(BigInt(r.timestamp));
        const from = new Map(r.transactions.map((t) => [t.hash.toLowerCase(), t.from.toLowerCase() as Address]));
        for (const h of wanted.get(b)!) {
          const f = from.get(h.toLowerCase());
          if (f) this.senders[h] = f;
          else missed.push(h);
        }
      });
      if (missed.length > 0) {
        const txs = await this.rpc.batch<{ from: Address } | null>(missed.map((h) => ({ method: "eth_getTransactionByHash", params: [h] })));
        txs.forEach((t, j) => {
          if (!t) throw new Error(`transaction ${missed[j]} not found`);
          this.senders[missed[j]!] = t.from.toLowerCase() as Address;
        });
      }
      this.cache.write("blocks.json", this.times);
      this.cache.write("senders.json", this.senders);
      this.log(`  blocks ${Math.min(i + step, blocks.length)}/${blocks.length}`);
    }
  }

  /** The first block at or after `ts`, by bisection on block timestamps. */
  private async blockAt(ts: number, head: number): Promise<number> {
    let lo = 1;
    let hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const [t] = await this.timestamps([mid], false);
      if (t! < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private async timestamps(blocks: number[], persist = true): Promise<number[]> {
    const missing = [...new Set(blocks.filter((b) => this.times[b] === undefined))];
    if (missing.length > 0) {
      const res = await this.rpc.batch<{ timestamp: Hex } | null>(
        missing.map((b) => ({ method: "eth_getBlockByNumber", params: [hex(b), false] })),
      );
      res.forEach((r, i) => {
        if (!r) throw new Error(`block ${missing[i]} not found`);
        this.times[missing[i]!] = Number(BigInt(r.timestamp));
      });
      if (persist) this.cache.write("blocks.json", this.times);
    }
    return blocks.map((b) => this.times[b]!);
  }

  private async position(n: number, token: Address, head: number): Promise<Position> {
    const all = this.cache.read<Record<string, Position>>("positions.json") ?? {};
    const hit = all[n];
    if (hit) return hit;
    const ret = await this.rpc.call<Hex>("eth_call", [
      { to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "positionOf", args: [BigInt(n)] }) },
      hex(head),
    ]);
    const [key, tickLower, tickUpper, requester] = decodeFunctionResult({ abi: factoryAbi, functionName: "positionOf", data: ret });
    let symbol = "?";
    try {
      const s = await this.rpc.call<Hex>("eth_call", [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }) }, hex(head)]);
      symbol = decodeFunctionResult({ abi: erc20Abi, functionName: "symbol", data: s });
    } catch {
      // A token without a readable symbol is still a pool; it is reported by address.
    }
    const pos: Position = { ...key, tickLower, tickUpper, requester, symbol };
    all[n] = pos;
    this.cache.write("positions.json", all);
    return pos;
  }

  /**
   * Logs for one filter over [from, to], cached by name. Later runs fetch only the blocks past the
   * cached range.
   */
  private async logs(name: string, address: Address, topics: Hex[], from: number, to: number): Promise<RawLog[]> {
    const file = `logs/${name}.json`;
    const have = this.cache.read<{ from: number; to: number; logs: RawLog[] }>(file) ?? { from, to: from - 1, logs: [] };
    let changed = false;
    if (from < have.from) {
      have.logs = [...(await this.fetchLogs(address, topics, from, have.from - 1)), ...have.logs];
      have.from = from;
      changed = true;
    }
    if (to > have.to) {
      have.logs.push(...(await this.fetchLogs(address, topics, Math.max(have.to + 1, from), to)));
      have.to = to;
      changed = true;
    }
    if (changed) this.cache.write(file, have);
    return have.logs.filter((l) => l.block >= from && l.block <= to);
  }

  /** Splits a range the node refuses, by span or by result size, until it answers. */
  private async fetchLogs(address: Address, topics: Hex[], from: number, to: number): Promise<RawLog[]> {
    if (to - from + 1 > MAX_LOG_SPAN) {
      const mid = from + MAX_LOG_SPAN - 1;
      return [...(await this.fetchLogs(address, topics, from, mid)), ...(await this.fetchLogs(address, topics, mid + 1, to))];
    }
    try {
      const res = await this.rpc.call<RpcLog[]>("eth_getLogs", [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }]);
      return res.map((l) => ({
        block: Number(BigInt(l.blockNumber)),
        index: Number(BigInt(l.logIndex)),
        tx: l.transactionHash,
        topics: l.topics,
        data: l.data,
      }));
    } catch (e) {
      if (!(e instanceof RpcError) || to === from) throw e;
      const mid = Math.floor((from + to) / 2);
      return [...(await this.fetchLogs(address, topics, from, mid)), ...(await this.fetchLogs(address, topics, mid + 1, to))];
    }
  }
}
