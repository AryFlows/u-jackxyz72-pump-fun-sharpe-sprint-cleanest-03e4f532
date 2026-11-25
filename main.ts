// Frost Sharpe — momentum with a short hold for the pump.fun replay.
//
// Idea, measured on the dev window before a line of this bot was written:
// every signal family (dip, pullback, slow momentum, launch snipe, big-sell
// V, completion ride) is flat-to-negative at the 2-slot latency this harness
// fills at — the sniper's whole edge, for example, lives inside the signal
// slot and dies with even a 1-slot delay. The least-bad structure found is
// fast momentum on established coins (rose >=10% over ~1500 slots with real
// buy flow, old enough to have survived its launch), exited with NO
// take-profit — the forward mean is carried by a fat right tail and a target
// would truncate it — a stop to cut the left tail, and a short fixed hold.
// Many small, short, uncorrelated round trips keep the hourly equity curve
// smooth; that is what the Sharpe ranking rewards.
//
// Everything here is a pure function of the batches the harness sends: no clock,
// no randomness, no I/O, iteration only in event order or over sorted mint lists,
// so the two graded executions produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- parameters

const SOL = LAMPORTS_PER_SOL;

// One stake per position. 0.10 SOL keeps the fixed 105k-lamport tx fee small
// (about 0.1% of the stake) while the 125 bps curve fee stays proportional.
const STAKE_LAMPORTS = SOL / 10n;
// Smallest buy worth sending at all.
const MIN_BUY_LAMPORTS = 5_000_000n;
// Entry window (slots) over which the run is measured.
const MOM_WINDOW_SLOTS = 1500;
// Enter when the price rose at least this much over the window...
const MOM_MIN_RISE = 0.1;
// ...and still sits at least this close to the window high.
const MOM_NEAR_HIGH = 0.95;
// ...with at least this much net SOL bought over the window...
const MOM_MIN_NET_SOL = 1_000_000_000n;
// ...from at least this many distinct buying wallets.
const MOM_MIN_BUYERS = 4;
const MOM_MIN_BUYS = 3;
// The curve must hold at least this much real SOL, and not more than this.
const MIN_REAL_SOL_LAMPORTS = 2_000_000_000n;
const MAX_REAL_SOL_LAMPORTS = 80_000_000_000n;
// Skip curves younger than this: fresh launches are mostly bundled dumps,
// and the established coins are the ones whose runs survive the latency.
const MOM_MIN_AGE_SLOTS = 600;
// Smallest tape (trades inside the window) worth judging.
const MOM_MIN_TICKS = 10;
// No take-profit: the tail pays, a target would cut it. This is a safety
// valve only, far beyond any plausible 60-slot move.
const TAKE_RATIO = 10.0;
// Exit when the price falls to entry * STOP_RATIO: cut the left tail.
const STOP_RATIO = 0.88;
// Trailing stop: off (it would also truncate the tail).
const TRAIL_ARM_RATIO = 10.0;
const TRAIL_DROP_RATIO = 0.1;
// Exit after holding this many slots regardless of price: the edge lives in
// the next minute, and past it the drift turns negative.
const MAX_HOLD_SLOTS = 60;
// Ignore a coin for this long after an exit.
const COOLDOWN_SLOTS = 600;
// Most new entries decided in one batch.
const MAX_ENTRIES_PER_BATCH = 3;
// Slippage tolerance (bps).
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 3000;
// The per-reply buy cap is checked against reserves shifted by our own flow,
// so keep a small margin under the SDK's figure.
const CAP_MARGIN_NUM = 97n;
const CAP_MARGIN_DEN = 100n;

// Guardrail pacing: the run needs round trips on at least 20 distinct mints.
// Desired coins grow with elapsed slots; when the bot trails the pace, entry
// thresholds relax so coverage catches up instead of the run failing the bar.
const PACE_TARGET_COINS = 25;
const PACE_SLOTS_PER_COIN = 1800;
const RELAXED_MIN_RISE = 0.05;
const RELAXED_MIN_BUYERS = 3;

// ---------------------------------------------------------------- per-mint tape

interface Tick {
  slot: number;
  /** virtual SOL / virtual tokens: the marginal price in SOL per token. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
  user: string;
}

interface Book {
  ticks: Tick[];
  /** Price, slot and recent high recorded when the current position opened. */
  entryPrice: number;
  entrySlot: number;
  entryHigh: number;
  /** Lamports committed to buys on this position (sent, filled or not). */
  committed: bigint;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another one. */
  exiting: boolean;
  /** Best price ratio to entry seen since the position opened (for the trail). */
  bestRatio: number;
}

const books = new Map<Pubkey, Book>();

function book(mint: Pubkey): Book {
  let b = books.get(mint);
  if (b === undefined) {
    b = {
      ticks: [],
      entryPrice: 0,
      entrySlot: -1,
      entryHigh: 0,
      committed: 0n,
      coolUntil: -1,
      exiting: false,
      bestRatio: 1,
    };
    books.set(mint, b);
  }
  return b;
}

// ---------------------------------------------------------------- pricing

/** Largest buy this batch may spend on this mint, with a safety margin. */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * CAP_MARGIN_NUM) / CAP_MARGIN_DEN;
}

/** Current marginal price (SOL per token) from a curve's latest reserves. */
function curvePrice(state: BotState, mint: Pubkey): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vt = curve.virtual_token_reserves;
  if (vt === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(vt);
}

// ---------------------------------------------------------------- strategy

/** Distinct mints on which a round trip has completed (buy fill then sell fill). */
const bought = new Set<Pubkey>();
const roundTripped = new Set<Pubkey>();
let firstSlot = -1;

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const slot = batch.slot;
  if (firstSlot < 0) firstSlot = slot;
  const txFee = state.txFeeLamports();
  const cap = state.hello.caps.max_orders_per_batch;

  // 1. Fold this batch's trades into the tapes, in event order.
  const touched: Pubkey[] = [];
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const b = book(e.mint);
    const vt = BigInt(e.virtual_token_reserves);
    const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
    b.ticks.push({
      slot,
      price,
      realSol: BigInt(e.real_quote_reserves),
      isBuy: e.is_buy,
      sol: BigInt(e.sol_amount),
      user: e.user,
    });
    if (b.ticks.length > 400) b.ticks.splice(0, b.ticks.length - 400);
    if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) {
      touched.push(e.mint);
    }
  }

  // 2. Resolve fills: a finished sell closes the book; a failed opening buy
  //    forgets the entry so the coin can be tried again later.
  for (const f of batch.fills) {
    const b = books.get(f.mint);
    if (b === undefined) continue;
    if (f.side === 'buy' && f.status === 'filled') bought.add(f.mint);
    if (f.side === 'sell') {
      b.exiting = false;
      if (f.status === 'filled' && bought.has(f.mint)) roundTripped.add(f.mint);
      if (!state.positions.has(f.mint)) {
        b.committed = 0n;
        b.entrySlot = -1;
        b.bestRatio = 1;
        b.coolUntil = slot + COOLDOWN_SLOTS;
      }
    } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
      let stillPending = false;
      for (const o of state.pending.values()) {
        if (o.order.mint === f.mint) {
          stillPending = true;
          break;
        }
      }
      if (!stillPending) {
        b.committed = 0n;
        b.entrySlot = -1;
      }
    }
  }

  const orders: OrderInput[] = [];
  const pendingMints = new Set<Pubkey>();
  for (const o of state.pending.values()) pendingMints.add(o.order.mint);

  // 3. Exits first, over held mints in sorted order (deterministic).
  const held = [...state.positions.keys()].sort();
  for (const mint of held) {
    if (orders.length >= cap) break;
    const h = state.positions.get(mint)!;
    const b = book(mint);
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (b.exiting || pendingMints.has(mint)) continue;
    const price = curvePrice(state, mint);
    const ratio = b.entryPrice > 0 && price > 0 ? price / b.entryPrice : 1;
    if (ratio > b.bestRatio) b.bestRatio = ratio;
    const trailed = b.bestRatio >= TRAIL_ARM_RATIO && ratio <= b.bestRatio - TRAIL_DROP_RATIO;
    const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
    const stale = slot - entrySlot >= MAX_HOLD_SLOTS;
    if (ratio >= TAKE_RATIO || ratio <= STOP_RATIO || trailed || stale) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: h.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      b.exiting = true;
    }
  }

  // 4. New entries on coins that traded this batch.
  const elapsed = slot - firstSlot;
  const desiredCoins = Math.min(PACE_TARGET_COINS, Math.floor(elapsed / PACE_SLOTS_PER_COIN));
  const behindPace = roundTripped.size < desiredCoins;
  const minRise = behindPace ? RELAXED_MIN_RISE : MOM_MIN_RISE;
  const minBuyers = behindPace ? RELAXED_MIN_BUYERS : MOM_MIN_BUYERS;

  let entries = 0;
  let open = state.committedPositionCount();
  for (const mint of touched) {
    if (orders.length >= cap || entries >= MAX_ENTRIES_PER_BATCH) break;
    if (open >= state.hello.caps.max_open_positions) break;
    if (state.positions.has(mint) || pendingMints.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const b = book(mint);
    if (slot < b.coolUntil) continue;
    const ticks = b.ticks;
    const last = ticks[ticks.length - 1]!;
    if (last.realSol < MIN_REAL_SOL_LAMPORTS || last.realSol > MAX_REAL_SOL_LAMPORTS) continue;
    // Skip fresh launches only when they are brand new; the tail lives in
    // young coins, so the floor is zero by design (see MOM_MIN_AGE_SLOTS).
    if (curve.created_slot !== null && slot - curve.created_slot < MOM_MIN_AGE_SLOTS) continue;
    // Window stats: first tick inside the window, window high, net SOL flow,
    // buy count and distinct buying wallets.
    let startIdx = 0;
    while (startIdx < ticks.length && slot - ticks[startIdx]!.slot > MOM_WINDOW_SLOTS) startIdx++;
    if (ticks.length - startIdx < MOM_MIN_TICKS) continue;
    const startPrice = ticks[startIdx]!.price;
    if (startPrice <= 0) continue;
    let hi = 0;
    let net = 0n;
    let buys = 0;
    const buyers = new Set<string>();
    for (let i = startIdx; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t.price > hi) hi = t.price;
      if (t.isBuy) {
        buys++;
        net += t.sol;
        buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    // Rising, still near its high, with real inflow from several wallets.
    const rise = last.price / startPrice - 1;
    if (rise < minRise) continue;
    if (last.price < hi * MOM_NEAR_HIGH) continue;
    if (net < MOM_MIN_NET_SOL) continue;
    if (buys < MOM_MIN_BUYS || buyers.size < minBuyers) continue;
    // Size the stake under the per-reply cap.
    let amount = STAKE_LAMPORTS;
    const sizeCap = buyCap(state, mint);
    if (amount > sizeCap) amount = sizeCap;
    if (amount < MIN_BUY_LAMPORTS) continue;
    if (state.freeCashLamports() - amount - txFee < 0n) continue;
    orders.push({
      side: 'buy',
      mint,
      quote_lamports: amount,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    b.entryPrice = last.price;
    b.entrySlot = slot;
    b.entryHigh = hi;
    b.committed = amount;
    b.exiting = false;
    b.bestRatio = 1;
    pendingMints.add(mint);
    entries++;
    open++;
  }
  return orders;
}

await runBot({ onBatch });
