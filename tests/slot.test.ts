import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  INITIAL_STATE,
  LINE_BETS,
  LINE_COUNT,
  REELS,
  ROWS,
  STRIP_LENGTH,
  TURN_REWARD,
  applyDelta,
  applyTurnReward,
  createRng,
  evaluateStops,
  resolveSpin,
  setLineBet,
  stepLineBet,
  totalBet,
  type GameState,
  type SlotSymbol,
} from '../hooks/games/slot.ts'

// The tests only ever speak to the module's exports. The strips, the paytable and the generator are
// its business, so a board is built here the way a player would get one: by looking for the stop
// that puts the wanted symbol on the wanted row of a reel, and reading the window back out.
const stopShowing = (reel: number, row: number, symbol: SlotSymbol): number => {
  for (let stop = 0; stop < STRIP_LENGTH; stop++) {
    const stops = Array(REELS).fill(0)
    stops[reel] = stop
    if (evaluateStops(stops, 1).window[reel][row] === symbol) return stop
  }
  throw new Error(`reel ${reel + 1} never shows ${symbol} on row ${row}`)
}

/** stops that put the given symbols along one row, left to right */
const rowOf = (row: number, symbols: SlotSymbol[]): number[] => symbols.map((symbol, reel) => stopShowing(reel, row, symbol))

const MIDDLE = 1
const lineWin = (stops: number[], lineBet: number, line: number) => evaluateStops(stops, lineBet).lines.find(l => l.line === line)

describe('paying lines', () => {
  it('pays three, four and five of a kind', () => {
    // '♠' pays 4 / 15 / 60 per line; 'Q' is the blocker because it is neither '♠' nor the wild
    const three = lineWin(rowOf(MIDDLE, ['♠', '♠', '♠', 'Q', 'Q']), 1, 0)
    const four = lineWin(rowOf(MIDDLE, ['♠', '♠', '♠', '♠', 'Q']), 1, 0)
    const five = lineWin(rowOf(MIDDLE, ['♠', '♠', '♠', '♠', '♠']), 1, 0)
    assert.equal(three?.count, 3)
    assert.equal(three?.pay, 4)
    assert.equal(four?.count, 4)
    assert.equal(four?.pay, 15)
    assert.equal(five?.count, 5)
    assert.equal(five?.pay, 60)
  })

  it('names the winning cells so the board does not have to work them out', () => {
    const win = lineWin(rowOf(MIDDLE, ['♠', '♠', '♠', 'Q', 'Q']), 1, 0)
    assert.deepEqual(win?.cells, [
      [0, MIDDLE],
      [1, MIDDLE],
      [2, MIDDLE],
    ])
  })

  it('pays nothing for two of a kind', () => {
    assert.equal(lineWin(rowOf(MIDDLE, ['♠', '♠', 'Q', 'Q', 'Q']), 1, 0), undefined)
  })

  it('pays nothing when the run does not start on reel 1', () => {
    // four '♠' in a row, but reel 1 is a 'Q', so the line is a one-'Q' run and pays nothing
    assert.equal(lineWin(rowOf(MIDDLE, ['Q', '♠', '♠', '♠', '♠']), 1, 0), undefined)
  })

  it('lets the wild stand in for a symbol', () => {
    const win = lineWin(rowOf(MIDDLE, ['♠', 'W', '♠', 'Q', 'Q']), 1, 0)
    assert.equal(win?.symbol, '♠')
    assert.equal(win?.count, 3)
    assert.equal(win?.pay, 4)
  })

  it('keeps the wild off reels 1 and 5, so a line is never all wild', () => {
    // with no wild on the first reel, a run always takes its symbol from reel 1 and the wild never
    // has to pay for itself
    for (const reel of [0, REELS - 1]) {
      for (let stop = 0; stop < STRIP_LENGTH; stop++) {
        const stops = Array(REELS).fill(0)
        stops[reel] = stop
        const column = evaluateStops(stops, 1).window[reel]
        assert.equal(column.includes('W'), false, `reel ${reel + 1} shows a wild at stop ${stop}`)
      }
    }
  })

  it('adds up every line that wins', () => {
    const board = rowOf(MIDDLE, ['♠', '♠', '♠', 'Q', 'Q'])
    const { totalWin, lines } = evaluateStops(board, 1)
    assert.equal(
      totalWin,
      lines.reduce((sum, line) => sum + line.pay, 0),
    )
    // and the invariant holds across the reels, not just on one hand-built board
    const rng = createRng(7)
    for (let i = 0; i < 500; i++) {
      const random = Array.from({ length: REELS }, () => Math.floor(rng() * STRIP_LENGTH))
      const spin = evaluateStops(random, 2)
      assert.equal(
        spin.totalWin,
        spin.lines.reduce((sum, line) => sum + line.pay, 0),
      )
    }
  })

  it('scales every pay with the line bet', () => {
    const board = rowOf(MIDDLE, ['♠', '♠', '♠', '♠', '♠'])
    const one = evaluateStops(board, 1)
    const ten = evaluateStops(board, 10)
    assert.equal(ten.totalWin, one.totalWin * 10)
    assert.equal(ten.lines[0].pay, one.lines[0].pay * 10)
  })

  it('shows five reels of three symbols', () => {
    const { window } = evaluateStops([0, 0, 0, 0, 0], 1)
    assert.equal(window.length, REELS)
    for (const column of window) assert.equal(column.length, ROWS)
  })
})

describe('the wallet', () => {
  it('takes the total bet and pays the win back', () => {
    const state: GameState = { balance: 1000, lineBet: 2 }
    const spin = resolveSpin(state, createRng(42))
    assert.ok(!('error' in spin))
    assert.equal(spin.state.balance, 1000 - totalBet(2) + spin.outcome.totalWin)
    assert.equal(state.balance, 1000, 'the state handed in is left alone')
  })

  it('bets the line bet on each of the five lines', () => {
    assert.equal(totalBet(2), 2 * LINE_COUNT)
    assert.equal(LINE_COUNT, 5)
  })

  it('refuses a spin the balance cannot cover, and changes nothing', () => {
    const state: GameState = { balance: 4, lineBet: 1 }
    const spin = resolveSpin(state, createRng(1))
    assert.deepEqual(spin, { error: 'insufficient-credits' })
    assert.deepEqual(state, { balance: 4, lineBet: 1 })
  })

  it('allows the spin that spends the last of the balance', () => {
    const spin = resolveSpin({ balance: 5, lineBet: 1 }, createRng(1))
    assert.ok(!('error' in spin))
  })

  it('pays for a finished turn', () => {
    const state: GameState = { balance: 40, lineBet: 5 }
    assert.deepEqual(applyTurnReward(state), { balance: 40 + TURN_REWARD, lineBet: 5 })
    assert.equal(state.balance, 40)
  })

  it('starts at 1000 credits and the smallest line bet', () => {
    assert.deepEqual(INITIAL_STATE, { balance: 1000, lineBet: LINE_BETS[0] })
  })

  it('only takes a line bet that is one of the steps', () => {
    const state: GameState = { balance: 100, lineBet: 1 }
    for (const bet of LINE_BETS) assert.equal(setLineBet(state, bet).lineBet, bet)
    for (const bet of [0, 3, -1, 11, 1.5]) assert.deepEqual(setLineBet(state, bet), state)
  })

  it('steps up and down the ladder of line bets, and stops at both ends', () => {
    let state: GameState = { balance: 100, lineBet: 1 }
    assert.equal(stepLineBet(state, -1).lineBet, 1, 'the bottom step holds')
    for (const expected of [2, 5, 10, 10]) {
      state = stepLineBet(state, 1)
      assert.equal(state.lineBet, expected)
    }
    for (const expected of [5, 2, 1, 1]) {
      state = stepLineBet(state, -1)
      assert.equal(state.lineBet, expected)
    }
  })

  it('snaps a line bet that is off the ladder back onto it', () => {
    assert.equal(stepLineBet({ balance: 100, lineBet: 7 }, 1).lineBet, LINE_BETS[0])
  })

  it('replays the same spin from the same seed', () => {
    const first = resolveSpin(INITIAL_STATE, createRng(123))
    const second = resolveSpin(INITIAL_STATE, createRng(123))
    assert.deepEqual(first, second)
    const other = resolveSpin(INITIAL_STATE, createRng(124))
    assert.notDeepEqual(first, other)
  })

  it('only ever stops somewhere a reel can stop', () => {
    const rng = createRng(9)
    for (let i = 0; i < 2000; i++) {
      const spin = resolveSpin({ balance: 1000, lineBet: 1 }, rng)
      assert.ok(!('error' in spin))
      for (const stop of spin.outcome.stops) {
        assert.ok(Number.isInteger(stop) && stop >= 0 && stop < STRIP_LENGTH, `stop ${stop} is off the strip`)
      }
    }
  })
})

describe('the wallet two sessions share', () => {
  // The store is one file per machine, so the board posts a difference and whoever writes it re-reads
  // first. These tests stand in for that: a fake store, two sessions, and no absolute balance anywhere.
  const settle = (store: { wallet: GameState }, delta: { bet?: number; win?: number; lineBet?: number }) => {
    const current = store.wallet // re-read, always, however stale the caller's own copy is
    store.wallet = applyDelta(current, delta)
  }

  it('lands on the same balance however two sessions interleave', () => {
    const spins = [
      { bet: 5, win: 0 },
      { bet: 10, win: 40 },
      { bet: 5, win: 4 },
      { bet: 50, win: 0 },
      { bet: 5, win: 12 },
      { bet: 10, win: 0 },
    ]
    const expected = 1000 - spins.reduce((sum, s) => sum + s.bet - s.win, 0)
    // every way of dealing these six spins between two sessions ends in the same place
    for (let mask = 0; mask < 1 << spins.length; mask++) {
      const store = { wallet: { balance: 1000, lineBet: 1 } }
      const mine = spins.filter((_, i) => (mask >> i) & 1)
      const theirs = spins.filter((_, i) => !((mask >> i) & 1))
      // interleaved: one from each session in turn, which is what two open sessions look like
      for (let i = 0; i < Math.max(mine.length, theirs.length); i++) {
        if (mine[i]) settle(store, mine[i])
        if (theirs[i]) settle(store, theirs[i])
      }
      assert.equal(store.wallet.balance, expected)
    }
  })

  it('does not let a session that bets a balance it no longer has go negative', () => {
    const store = { wallet: { balance: 5, lineBet: 1 } }
    // the other session spent the last of it between this one reading and posting
    settle(store, { bet: 5, win: 0 })
    settle(store, { bet: 5, win: 0 })
    assert.equal(store.wallet.balance, 0)
  })

  it('carries a line bet through without touching the balance', () => {
    const store = { wallet: { balance: 120, lineBet: 1 } }
    settle(store, { lineBet: 10 })
    assert.deepEqual(store.wallet, { balance: 120, lineBet: 10 })
    // and an impossible one is left where it was
    settle(store, { lineBet: 7 })
    assert.equal(store.wallet.lineBet, 10)
  })

  it('applies a win with no bet, which is what a finished turn is', () => {
    const store = { wallet: { balance: 10, lineBet: 2 } }
    settle(store, { win: TURN_REWARD })
    assert.deepEqual(store.wallet, { balance: 10 + TURN_REWARD, lineBet: 2 })
  })
})

describe('return to player', () => {
  it('pays back between 94% and 96%, counted over every stop combination', () => {
    // no sampling: all STRIP_LENGTH^5 = 7,962,624 ways the reels can land, each equally likely
    const started = Date.now()
    const stops = [0, 0, 0, 0, 0]
    let paid = 0
    let hits = 0
    let combinations = 0
    for (stops[0] = 0; stops[0] < STRIP_LENGTH; stops[0]++)
      for (stops[1] = 0; stops[1] < STRIP_LENGTH; stops[1]++)
        for (stops[2] = 0; stops[2] < STRIP_LENGTH; stops[2]++)
          for (stops[3] = 0; stops[3] < STRIP_LENGTH; stops[3]++)
            for (stops[4] = 0; stops[4] < STRIP_LENGTH; stops[4]++) {
              const { totalWin } = evaluateStops(stops, 1)
              paid += totalWin
              if (totalWin > 0) hits++
              combinations++
            }
    const rtp = paid / (combinations * totalBet(1))
    console.log(
      `RTP ${(rtp * 100).toFixed(3)}% · hit ${(hits / combinations * 100).toFixed(2)}% · ` +
        `${combinations.toLocaleString('en-US')} combinations in ${((Date.now() - started) / 1000).toFixed(2)}s`,
    )
    assert.equal(combinations, STRIP_LENGTH ** REELS)
    assert.ok(rtp >= 0.94 && rtp <= 0.96, `RTP is ${(rtp * 100).toFixed(3)}%, outside 94%–96%`)
  })

  it('does not depend on the line bet', () => {
    // the pays all scale with the line bet and so does the stake, so one board is enough to show it
    const board = [3, 11, 7, 19, 2]
    const one = evaluateStops(board, 1).totalWin / totalBet(1)
    for (const bet of LINE_BETS) assert.equal(evaluateStops(board, bet).totalWin / totalBet(bet), one)
  })
})

describe('the window handed out', () => {
  it('cannot be written back into the reels', () => {
    const { window } = evaluateStops([0, 0, 0, 0, 0], 1)
    assert.throws(() => {
      window[0][0] = '★'
    })
    assert.equal(evaluateStops([0, 0, 0, 0, 0], 1).window[0][0], window[0][0])
  })
})
