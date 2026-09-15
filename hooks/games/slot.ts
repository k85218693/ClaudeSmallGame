// The slot machine's rules, with nothing on screen in them: the reel strips, the paytable and the
// random number generator are all private to this file, and everything a board or a hooks module
// needs comes back through the functions exported below.
//
// The maths is this project's own, deliberately simplified: 5 reels, 3 rows, 5 fixed lines, wins
// read left to right from reel 1, and a wild that only lives on the middle three reels.

export type SlotSymbol = '★' | '◆' | '♠' | '♥' | 'K' | 'Q' | 'W'
export type GameState = { balance: number; lineBet: number }
export type LineWin = {
  line: number
  symbol: SlotSymbol
  count: number
  pay: number
  /** the winning cells as [reel, row]; the board flashes exactly these */
  cells: [number, number][]
}
export type SpinOutcome = {
  stops: number[]
  window: SlotSymbol[][]
  totalWin: number
  lines: LineWin[]
}
/** a source of numbers in [0, 1), same shape as Math.random */
export type Rng = () => number

const WILD: SlotSymbol = 'W'

/** pay per line for 3, 4 and 5 of a kind, multiplied by the line bet. The wild pays nothing itself. */
const PAYTABLE: Record<Exclude<SlotSymbol, 'W'>, [number, number, number]> = {
  '★': [10, 50, 250],
  '◆': [6, 25, 100],
  '♠': [4, 15, 60],
  '♥': [3, 10, 40],
  K: [2, 6, 25],
  Q: [2, 5, 20],
}

// One strip per reel, all 24 long. A symbol's chance on a reel is how many times it sits on that
// reel's strip, so the RTP is tuned by moving symbols between strips and nothing else. The wild is
// on reels 2, 3 and 4 only. Order does not move the RTP — every stop is equally likely — so it is
// only chosen to keep a spinning reel from showing runs of the same symbol.
const STRIPS: SlotSymbol[][] = [
  ['Q', 'K', '♠', 'Q', '♥', 'K', 'Q', '◆', '♠', 'Q', '♥', 'K', 'Q', '♠', '★', 'Q', '♥', 'K', '♠', 'Q', '♥', 'K', '◆', 'Q'],
  ['Q', 'K', 'W', '♠', '♥', 'K', 'W', '◆', '♠', 'Q', '♥', 'W', 'K', '♠', '★', 'W', '♥', 'K', 'Q', '♠', '♥', 'W', '◆', 'K'],
  ['K', 'W', '♥', 'Q', '♠', 'W', 'K', '♥', '◆', 'W', '♠', 'K', '♥', 'Q', 'W', '♠', '★', 'K', '♥', 'W', 'Q', '♠', '◆', 'K'],
  ['♠', 'K', 'W', '♥', 'Q', 'W', '♠', 'K', '♥', 'W', '◆', 'Q', 'K', '♠', 'W', '♥', '★', 'K', '♠', 'W', '♥', 'Q', '◆', 'K'],
  ['K', 'Q', '♥', '♠', 'Q', 'K', '♥', 'Q', '◆', 'K', 'Q', '♠', '♥', 'Q', 'K', '♠', 'Q', '★', '♥', 'K', 'Q', '♠', '◆', 'Q'],
]

/** how many stop positions a reel has; every reel is the same length */
export const STRIP_LENGTH = STRIPS[0].length
export const REELS = STRIPS.length
export const ROWS = 3

// Every column the reels can show, worked out once. Reading a window is then five lookups and no
// allocation per cell, which is what lets the RTP test walk all 24^5 = 7,962,624 stop combinations.
// They are frozen because a window handed to a board is these very arrays: a caller that wrote to
// one would be editing the reel strips, and the RTP with them.
const COLUMNS: SlotSymbol[][][] = STRIPS.map(strip =>
  strip.map((_, stop) => Object.freeze(Array.from({ length: ROWS }, (_, row) => strip[(stop + row) % strip.length])) as SlotSymbol[]),
)

/** the five fixed lines, as the row each reel contributes: middle, top, bottom, V and ∧ */
const LINES: number[][] = [
  [1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0],
  [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0],
  [2, 1, 0, 1, 2],
]

export const LINE_COUNT = LINES.length
/** the only line bets there are; the board's + and - step through them */
export const LINE_BETS: readonly number[] = [1, 2, 5, 10]
export const INITIAL_STATE: GameState = { balance: 1000, lineBet: LINE_BETS[0] }
/** what Claude finishing a turn is worth */
export const TURN_REWARD = 10

export const totalBet = (lineBet: number): number => lineBet * LINE_COUNT

/** mulberry32: small, seedable, and good enough to make a spin reproducible in a test */
export const createRng = (seed: number): Rng => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const windowAt = (stops: number[]): SlotSymbol[][] =>
  COLUMNS.map((columns, reel) => columns[((stops[reel] % STRIP_LENGTH) + STRIP_LENGTH) % STRIP_LENGTH])

/**
 * Score one set of stop positions. The window comes back with the score because the board draws it
 * and the RTP test walks every combination through here — nobody should have to rebuild it.
 */
export const evaluateStops = (
  stops: number[],
  lineBet: number,
): { window: SlotSymbol[][]; totalWin: number; lines: LineWin[] } => {
  const window = windowAt(stops)
  const lines: LineWin[] = []
  let totalWin = 0
  for (let line = 0; line < LINES.length; line++) {
    const rows = LINES[line]
    // walk from reel 1 rightwards: wilds before the first real symbol join whatever it turns out to
    // be, and the run ends at the first reel that is neither that symbol nor a wild
    let symbol: SlotSymbol | undefined
    let count = 0
    for (let reel = 0; reel < REELS; reel++) {
      const cell = window[reel][rows[reel]]
      if (cell === WILD) {
        count++
        continue
      }
      if (symbol === undefined) {
        symbol = cell
        count++
        continue
      }
      if (cell !== symbol) break
      count++
    }
    // an undefined symbol means the whole line came up wild, and the wild pays nothing on its own
    if (symbol === undefined || count < 3) continue
    const pay = PAYTABLE[symbol as Exclude<SlotSymbol, 'W'>][count - 3] * lineBet
    const cells: [number, number][] = []
    for (let reel = 0; reel < count; reel++) cells.push([reel, rows[reel]])
    lines.push({ line, symbol, count, pay, cells })
    totalWin += pay
  }
  return { window, totalWin, lines }
}

/**
 * One spin: take the total bet, land the reels, pay the lines. The balance that comes back is the
 * caller's own balance moved along — the authoritative one lives in the plugin's store.
 */
export const resolveSpin = (
  state: GameState,
  rng: Rng,
): { state: GameState; outcome: SpinOutcome } | { error: 'insufficient-credits' } => {
  const bet = totalBet(state.lineBet)
  if (state.balance < bet) return { error: 'insufficient-credits' }
  const stops = Array.from({ length: REELS }, () => Math.floor(rng() * STRIP_LENGTH) % STRIP_LENGTH)
  const { window, totalWin, lines } = evaluateStops(stops, state.lineBet)
  return {
    state: { ...state, balance: state.balance - bet + totalWin },
    outcome: { stops, window, totalWin, lines },
  }
}

/** Claude finished a turn */
export const applyTurnReward = (state: GameState): GameState => ({ ...state, balance: state.balance + TURN_REWARD })

/** a line bet that is not one of the steps leaves the state alone */
export const setLineBet = (state: GameState, lineBet: number): GameState =>
  LINE_BETS.includes(lineBet) ? { ...state, lineBet } : state
