// Delayed-confirmation launch bot for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Thesis (from the dev leaderboard): hourly Sharpe rewards many small wins, tiny drawdown and
// broad diversification — not big PnL. So this bot trades small (0.05 SOL per coin), holds at most
// two positions, takes one full exit per trade, and grinds through many launches.
//
// Entry is NOT a pure launch snipe. A coin is watched from its CreateEvent for roughly 60-130s
// before it may be bought, and only when the tape confirms sustained demand:
//   * at least 10 distinct non-creator buyers (same-slot, same-amount bursts count once, so a
//     bundled launch does not inflate the count),
//   * net SOL inflow positive in each of the last two observation periods,
//   * any sell seen so far has been fully absorbed by later non-creator buys,
//   * removing the single largest buyer still leaves net flow positive,
//   * no substantive creator sell that has not been absorbed (dust sells are tolerated),
//   * real SOL reserve large enough that 0.05 SOL is at most 0.5% of it (so the whole position
//     can be sold without moving the curve against us),
//   * price has not already run away from its create price.
// Exits are gross-price based (TP +30%, SL -6% against the decision price), a 5-minute max hold,
// a stale-trade exit, a flow exit (two consecutive periods of net selling), and a creator-sell
// exit when the creator's sale is not absorbed within a grace window. One position per creator.
// A drawdown guard skips entries that would push post-fill liquidation equity below 98.2% of
// peak equity. Filler trades (0.01 SOL, looser filters) use their own TP/SL and a 420-slot
// max hold, and only top the completed-qualifying-mint pace up toward its target.
//
// Pure function of the batches fed in: no clock, no randomness, no I/O, no network.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lamports per coin (0.05 SOL = 50_000_000). */
  stakeLamports: number;
  /** Max open positions at once (2: keeps exposure ~0.10 SOL). */
  maxOpen: number;
  /** Entry age window in slots since create (~4.7 slots/s: 140 ~= 30s). */
  minAge: number;
  maxAge: number;
  /** Distinct non-creator buyers (cluster-adjusted) required before entry. */
  minBuyers: number;
  /** Length of one flow observation period, in slots. */
  flowPeriod: number;
  /** Consecutive recent flow periods that must each be net positive (1 or 2). */
  minPosPeriods: number;
  /** Max entries per mint (re-entries after an exit, once the cooldown passes). */
  maxEntries: number;
  /** Slots after an exit before the same mint may be entered again. */
  reEntryCooldown: number;
  /** 'first': buy at first qualification. 'absorbed': also require a sell to have happened and been absorbed. */
  entryMode: 'first' | 'absorbed';
  /** Real SOL reserve window at decision time (lamports). minRealSol enforces stake <= 0.5% of reserve. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator sell at or above this (lamports) counts as substantive; below it is dust. */
  devSellDust: number;
  /** Slots after a substantive creator sell before an unabsorbed sell forces an exit. */
  devSellGrace: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Slippage allowed on buys/sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Gross take-profit / stop-loss against the fill price (bps). tpBps >= 100000 means no fixed TP. */
  tpBps: number;
  slBps: number;
  /** Trailing stop: once up at least trailArmBps (gross), exit on a fall of trailBps from the best price. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Drawdown guard: skip an entry when post-fill cash would fall below this share (bps) of peak equity. */
  ddGuardBps: number;
  /** Filler tier: minimum-size (0.01 SOL) round trips on looser filters, only when the
   * completed-round-trip pace lags the 20-mint guardrail target. Filler exits use their own TP/SL. */
  fillerStakeLamports: number;
  fillerMinRealSol: number;
  fillerMinBuyers: number;
  fillerMinAge: number;
  fillerMaxAge: number;
  fillerTpBps: number;
  fillerSlBps: number;
  /** Filler tier max hold, in slots (420 ~= 90s; strict trades keep maxHold). */
  fillerMaxHold: number;
  /** Target completed round trips per 6h window; fillers top the pace up toward this. */
  fillerTargetRT: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 50_000_000,
  maxOpen: 2,
  minAge: 280,
  maxAge: 600,
  minBuyers: 10,
  flowPeriod: 70,
  minPosPeriods: 2,
  maxEntries: 1,
  reEntryCooldown: 700,
  entryMode: 'first',
  minRealSol: 10_000_000_000,
  maxRealSol: 60_000_000_000,
  devSellDust: 20_000_000,
  devSellGrace: 70,
  minRunupBps: 5_000,
  maxRunupBps: 20_000,
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
  tpBps: 3_000,
  slBps: 600,
  trailArmBps: 1_000_000,
  trailBps: 1_000,
  maxHold: 1_400,
  staleSlots: 700,
  ddGuardBps: 9_820,
  fillerStakeLamports: 10_000_000,
  fillerMinRealSol: 2_000_000_000,
  fillerMinBuyers: 5,
  fillerMinAge: 70,
  fillerMaxAge: 1_200,
  fillerTpBps: 5_000,
  fillerSlBps: 1_000,
  fillerMaxHold: 420,
  fillerTargetRT: 24,
};

const FEE_BPS = 125n;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  trades: number;
  /** Distinct non-creator buyers, cluster-adjusted (see noteBuy). */
  buyers: Set<Pubkey>;
  /** Buys in the create slot, grouped by (user, sol): identical amounts share one cluster. */
  createBuys: Map<string, Set<Pubkey>>;
  buyByUser: Map<Pubkey, bigint>;
  boughtNonDev: bigint;
  sold: bigint;
  /** Unabsorbed sell volume (any seller): only later non-creator buys reduce it. Entry needs 0. */
  outstandingSell: bigint;
  /** Unabsorbed creator-sell volume: creator sells add, only later non-creator buys reduce it. */
  devOutstanding: bigint;
  devSellSlot: number;
  lastTradeSlot: number;
  recent: Tick[];
  entries: number;
  cooldownUntil: number;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Fill-time entry price as a rational (SOL in / tokens out, curve fees stripped). */
  entryQ: bigint;
  entryT: bigint;
  /** Cost basis: quote paid + tx fees, for exit PnL accounting. */
  cost: bigint;
  /** Actual buy spend on this open trip (fill quote_lamports, fees included). A trip only
   * counts toward the qualifying-mint pace when this reaches 10,000,000 lamports. */
  spend: bigint;
  /** Best gross price ratio seen (vq*entryT / entryQ*vt, scaled by BPS) for the trailing stop. */
  best: bigint;
  /** This trade's gross TP/SL (bps), set by its tier at fill time. */
  tpBps: number;
  slBps: number;
  /** This trade's max hold (slots), set by its tier at fill time. */
  maxHold: number;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}


export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Buys sent and not yet filled, by client_id. */
  const pendingBuys = new Map<string, { mint: Pubkey; slot: number; tier: 'strict' | 'filler' }>();
  /** Distinct mints whose open trip spent >= 10,000,000 lamports on buys and then fully
   * closed (sell fill or harness close). This set — not a close count — paces the filler. */
  const qualifiedMints = new Set<Pubkey>();
  let firstTime: number | null = null;
  let nowTime = 0;
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  let peakEquity = 10_000_000_000n;

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          trades: 0,
          buyers: new Set(),
          createBuys: new Map(),
          buyByUser: new Map(),
          boughtNonDev: 0n,
          sold: 0n,
          outstandingSell: 0n,
          devOutstanding: 0n,
          devSellSlot: -1,
          lastTradeSlot: e.slot,
          recent: [],
          entries: 0,
          cooldownUntil: -1,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        const isDev = e.user === c.creator;
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        // Keep only the recent tape; aggregates above carry the lifetime picture.
        while (c.recent.length > 0 && c.recent[0]!.slot <= e.slot - 5000) c.recent.shift();
        if (e.is_buy) {
          if (!isDev) {
            c.boughtNonDev += sol;
            c.buyers.add(e.user);
            c.buyByUser.set(e.user, (c.buyByUser.get(e.user) ?? 0n) + sol);
            // Only non-creator buys absorb outstanding sells (either side's sells, or the
            // creator's): a creator buy-back must not clear the absorption check.
            if (c.outstandingSell > 0n) c.outstandingSell = sol >= c.outstandingSell ? 0n : c.outstandingSell - sol;
            if (c.devOutstanding > 0n) c.devOutstanding = sol >= c.devOutstanding ? 0n : c.devOutstanding - sol;
            if (e.slot === c.createSlot) {
              const key = sol.toString();
              let s = c.createBuys.get(key);
              if (s === undefined) {
                s = new Set();
                c.createBuys.set(key, s);
              }
              s.add(e.user);
            }
          }
        } else {
          c.sold += sol;
          c.outstandingSell += sol;
          if (isDev) {
            c.devOutstanding += sol;
            c.devSellSlot = e.slot;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Distinct non-creator buyers, with same-slot same-amount create-slot bursts collapsed to one.
   * A wallet counted as excess in one amount group is not deducted again in another: excess
   * wallets are collected in one union set first, then subtracted once. */
  function effectiveBuyers(c: Coin): number {
    const excess = new Set<Pubkey>();
    for (const users of c.createBuys.values()) {
      if (users.size <= 1) continue;
      let first = true;
      for (const u of users) {
        if (first) { first = false; continue; }
        excess.add(u);
      }
    }
    return c.buyers.size - excess.size;
  }

  /** Net SOL flow (buys - sells) over [fromSlot, toSlot). */
  function netFlow(c: Coin, fromSlot: number, toSlot: number): bigint {
    let net = 0n;
    for (const t of c.recent) {
      if (t.slot < fromSlot) continue;
      if (t.slot >= toSlot) break;
      net += t.isBuy ? t.sol : -t.sol;
    }
    return net;
  }

  /** Largest single non-creator buyer removed: is the flow still net positive? */
  function flowExLargest(c: Coin): bigint {
    let largest = 0n;
    for (const v of c.buyByUser.values()) if (v > largest) largest = v;
    return c.boughtNonDev - largest - c.sold;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  function priceOf(state: BotState, mint: Pubkey): { vq: bigint; vt: bigint } | null {
    const cv = state.curves.get(mint);
    if (cv === undefined || cv.virtual_token_reserves <= 0n) return null;
    return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
  }

  function equity(state: BotState): bigint {
    let e = state.cash;
    const tx = state.txFeeLamports();
    for (const [mint, pos] of state.positions) {
      const p = priceOf(state, mint);
      if (p === null) continue;
      const v = sellValue(pos.token_amount, p.vq, p.vt);
      if (v > tx) e += v - tx;
    }
    return e;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Fold fills: open held records with the decision price, drop closed ones.
      // A trip qualifies toward the mint pace only on a full close, and only when the
      // trip's actual buy spend reached 10,000,000 lamports.
      const qualifyOnClose = (mint: Pubkey): void => {
        const h = held.get(mint);
        if (h !== undefined && h.spend >= 10_000_000n) qualifiedMints.add(mint);
      };
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          qualifyOnClose(f.mint);
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled') {
          const pb = pendingBuys.get(f.client_id);
          pendingBuys.delete(f.client_id);
          // An entry counts only once its buy actually fills: a failed or rejected buy
          // leaves the mint a fresh entry, subject to the normal age window.
          const c0 = coins.get(f.mint);
          if (c0 !== undefined) c0.entries += 1;
          const paid = BigInt(f.quote_lamports);
          const existing = held.get(f.mint);
          if (existing !== undefined) {
            existing.spend += paid;
          } else {
            const fee = BigInt(f.fee_lamports);
            const tokens = BigInt(f.token_amount);
            const tier = pb?.tier ?? 'strict';
            // Entry price from the fill: SOL that entered the curve per token received.
            held.set(f.mint, {
              openedSlot: f.slot,
              entryQ: paid - fee > 0n ? paid - fee : paid,
              entryT: tokens > 0n ? tokens : 1n,
              cost: paid + BigInt(f.tx_fee_lamports),
              spend: paid,
              best: BPS,
              tpBps: tier === 'filler' ? P.fillerTpBps : P.tpBps,
              slBps: tier === 'filler' ? P.fillerSlBps : P.slBps,
              maxHold: tier === 'filler' ? P.fillerMaxHold : P.maxHold,
            });
          }
        } else if (f.side === 'sell' && f.status === 'filled') {
          qualifyOnClose(f.mint);
          held.delete(f.mint);
          selling.delete(f.mint);
          const c = coins.get(f.mint);
          if (c !== undefined) {
            if (c.entries < P.maxEntries) c.cooldownUntil = state.slot + P.reEntryCooldown;
            else c.done = true;
          }
        } else if (f.status === 'rejected' || f.status === 'failed') {
          pendingBuys.delete(f.client_id);
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Peak equity for the drawdown guard.
      const eq = equity(state);
      if (eq > peakEquity) peakEquity = eq;

      // Exits first: one full exit per trigger.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          const p = priceOf(state, mint);
          if (p === null) continue;
          // No fill record (e.g. position from an earlier session state): use current price.
          h = { openedSlot: state.slot, entryQ: p.vq, entryT: p.vt, cost: pos.cost_lamports, spend: pos.cost_lamports, best: BPS, tpBps: P.tpBps, slBps: P.slBps, maxHold: P.maxHold };
          held.set(mint, h);
        }
        const p = priceOf(state, mint);
        if (p === null) continue;
        let exit = false;
        let reason = '';
        // Gross TP / SL against the FILL price: compare (vq/vt) with (entryQ/entryT).
        // ratioBps = current price / entry price, in bps.
        const ratioBps = (p.vq * h.entryT * BPS) / (h.entryQ * p.vt);
        if (ratioBps > h.best) h.best = ratioBps;
        if (ratioBps >= BPS + BigInt(h.tpBps)) { exit = true; reason = 'tp'; }
        if (ratioBps <= BPS - BigInt(h.slBps)) { exit = true; reason = 'sl'; }
        if (
          h.best >= BPS + BigInt(P.trailArmBps) &&
          ratioBps <= h.best - (h.best * BigInt(P.trailBps)) / BPS
        ) { exit = true; reason = 'trail'; }
        if (state.slot - h.openedSlot >= h.maxHold) { exit = true; reason = 'hold'; }
        if (c !== undefined) {
          if (state.slot - c.lastTradeSlot >= P.staleSlots) { exit = true; reason = 'stale'; }
          // Two consecutive flow periods both net negative -> the bid is gone. Both windows
          // end at slot + 1 so the decision slot itself is included, like the other signals.
          const fp = P.flowPeriod;
          if (netFlow(c, state.slot - 2 * fp, state.slot - fp) < 0n && netFlow(c, state.slot - fp, state.slot + 1) < 0n) { exit = true; reason = 'flow'; }
          // Substantive creator sell not absorbed within the grace window.
          if (
            c.devOutstanding >= BigInt(P.devSellDust) &&
            c.devSellSlot > h.openedSlot &&
            state.slot - c.devSellSlot >= P.devSellGrace
          ) {
            exit = true; reason = 'dev';
          }
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlippageBps });
        selling.add(mint);
      }

      // Entries. One per-reply cash budget, shared by both tiers: it starts from the free
      // cash (which already nets pending orders) minus this reply's exit-order tx fees, and
      // every queued buy decrements it by amount + 2 tx fees (buy + reserved exit tx).
      let budget = state.freeCashLamports() - tx * BigInt(orders.length);
      // One unified open count: committed positions (held + pending buys) plus buys queued
      // in this reply, tracked in queuedBuyMints so neither tier can overshoot the cap.
      const queuedBuyMints = new Set<Pubkey>();
      const openCount = (): number => state.committedPositionCount() + queuedBuyMints.size;
      const heldCreators = new Set<Pubkey>();
      for (const mint of held.keys()) {
        const c = coins.get(mint);
        if (c !== undefined) heldCreators.add(c.creator);
      }
      // Seed the creator blocklist from pending buys too: two coins by one creator must not
      // enter across batches while the first buy is still in flight.
      for (const p of state.pending.values()) {
        if (p.order.side !== 'buy') continue;
        const c = coins.get(p.order.mint);
        if (c !== undefined) heldCreators.add(c.creator);
      }
      // Marked sell value of current positions, net of one exit tx fee each. The drawdown
      // floor below protects liquidation equity (projected cash + this marked value), not
      // raw cash: selling the book must still leave equity above the floor.
      let marked = 0n;
      for (const [m2, pos2] of state.positions) {
        const pp = priceOf(state, m2);
        if (pp === null) continue;
        const v = sellValue(pos2.token_amount, pp.vq, pp.vt);
        if (v > tx) marked += v - tx;
      }
      const passesDdGuard = (amount: bigint): boolean =>
        budget - amount - 2n * tx + marked >= (peakEquity * BigInt(P.ddGuardBps)) / BPS;
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isReEntry = c.entries > 0 && state.slot >= c.cooldownUntil;
        if (age < P.minAge || (age > P.maxAge && !isReEntry)) {
          // Only retire the coin when no re-entry is still possible.
          if (age > P.maxAge && !isReEntry && c.entries >= P.maxEntries) { c.done = true; }
          continue;
        }
        if (c.entries > 0 && !isReEntry) continue;
        if (openCount() >= Math.min(P.maxOpen, state.hello.caps.max_open_positions)) continue;
        if (heldCreators.has(c.creator)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // Depth: the whole stake must be at most 0.5% of real SOL reserve.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        // Demand confirmation.
        if (effectiveBuyers(c) < P.minBuyers) continue;
        const fp = P.flowPeriod;
        if (netFlow(c, state.slot - fp, state.slot + 1) <= 0n) continue;
        if (P.minPosPeriods >= 2 && netFlow(c, state.slot - 2 * fp, state.slot - fp) <= 0n) continue;
        // Every sell seen so far must have been fully absorbed by later non-creator buys.
        if (c.outstandingSell > 0n) continue;
        if (P.entryMode === 'absorbed' && c.sold <= 0n) continue;
        // No single-buyer story.
        if (flowExLargest(c) <= 0n) continue;
        // No substantive unabsorbed creator sell.
        if (c.devOutstanding >= BigInt(P.devSellDust)) continue;
        // Not a run-up chase. The lower bound is 1.5x the create price at minimum:
        // runLhs < runRhs * (BPS + minRunupBps) rejects anything below a 50% run-up.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (vt <= 0n || c.vt0 <= 0n) continue;
        const runLhs = vq * c.vt0 * BPS;
        const runRhs = c.vq0 * vt;
        if (runLhs > runRhs * (BPS + BigInt(P.maxRunupBps))) continue;
        if (runLhs < runRhs * (BPS + BigInt(P.minRunupBps))) continue;
        // Whole-position exit must be worth doing (sanity against dust curves).
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < 5_000_000n) continue;
        if (budget < amount + 2n * tx) continue;
        // Drawdown guard: post-fill liquidation equity vs 98.2% of peak equity.
        if (!passesDdGuard(amount)) continue;
        // Whole-position sell quote sanity: the tokens we would receive must sell for >= 90% of stake.
        const estTokens = amount <= 1n ? 0n : ((amount - 1n) * vt) / (vq + amount - 1n);
        if (sellValue(estTokens, vq, vt) < (amount * 9n) / 10n) continue;
        if (hasPendingBuy(state, c.mint)) continue;
        const clientId = state.clientId();
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps, client_id: clientId });
        pendingBuys.set(clientId, { mint: c.mint, slot: state.slot, tier: 'strict' });
        queuedBuyMints.add(c.mint);
        budget -= amount + 2n * tx;
        heldCreators.add(c.creator);
      }
      // Filler tier: only when the completed-round-trip pace lags the guardrail target.
      // Pace is measured in block time from the first event; fillers start after 30 min so
      // the strict tier gets the first shot at every coin.
      if (firstTime !== null && nowTime - firstTime >= 1800) {
        const elapsed = Math.min(21600, nowTime - firstTime);
        const expected = (P.fillerTargetRT * elapsed) / 21600;
        // Unified open count: committed positions plus strict buys queued earlier in this
        // reply. Re-checked after every filler buy below, so the tier cannot overshoot.
        let openTotal = openCount();
        if (qualifiedMints.size + openTotal < expected - 1 && openTotal < 4) {
          const fillerStake = BigInt(P.fillerStakeLamports);
          for (const c of coins.values()) {
            if (orders.length >= cap) break;
            if (openTotal >= 4) break;
            if (c.done || c.complete) continue;
            if (state.positions.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
            if (queuedBuyMints.has(c.mint)) continue;
            if (c.entries >= P.maxEntries) continue;
            if (heldCreators.has(c.creator)) continue;
            const age = state.slot - c.createSlot;
            if (age < P.fillerMinAge || age > P.fillerMaxAge) continue;
            const curve = state.curves.get(c.mint);
            if (curve === undefined || curve.complete) continue;
            const rq = curve.real_quote_reserves;
            if (rq < BigInt(P.fillerMinRealSol)) continue;
            if (effectiveBuyers(c) < P.fillerMinBuyers) continue;
            const fp = P.flowPeriod;
            if (netFlow(c, state.slot - fp, state.slot + 1) <= 0n) continue;
            if (flowExLargest(c) <= 0n) continue;
            if (c.devOutstanding >= BigInt(P.devSellDust)) continue;
            const vq = curve.virtual_quote_reserves;
            const vt = curve.virtual_token_reserves;
            if (vt <= 0n) continue;
            const runLhs = vq * c.vt0 * BPS;
            const runRhs = c.vq0 * vt;
            if (runLhs > runRhs * (BPS + BigInt(P.maxRunupBps))) continue;
            const maxBuy = state.maxBuyLamports(c.mint);
            const amount = fillerStake < maxBuy ? fillerStake : maxBuy;
            if (amount < 10_000_000n) continue;
            if (budget < amount + 2n * tx) continue;
            // Same shared budget and drawdown floor as the strict tier.
            if (!passesDdGuard(amount)) continue;
            const clientId = state.clientId();
            orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps, client_id: clientId });
            pendingBuys.set(clientId, { mint: c.mint, slot: state.slot, tier: 'filler' });
            queuedBuyMints.add(c.mint);
            budget -= amount + 2n * tx;
            openTotal += 1;
            heldCreators.add(c.creator);
            if (qualifiedMints.size + openTotal >= expected) break;
          }
        }
      }
      return orders;
    },
  };
}
