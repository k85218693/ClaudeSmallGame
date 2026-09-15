/* @jsx h */
import type { ClientSurface } from 'claude-code'
import {
  INITIAL_STATE,
  LINE_BETS,
  LINE_COUNT,
  REELS,
  ROWS,
  evaluateStops,
  resolveSpin,
  stepLineBet,
  totalBet,
  TURN_REWARD,
  type GameState,
  type SlotSymbol,
  type SpinOutcome,
} from '../games/slot.ts'

// The board: a surface module, so it runs on the drawing thread with its own state, keys (after a
// click gives it focus; Esc hands the prompt back) and mouse. It draws what the game module hands
// it and works nothing out for itself — which cells to flash is in the outcome.
//
// Never name a local `h` in this file: every JSX tag compiles to a call of `h`.

/** one colour per symbol, so a symbol can be told apart without reading its shape */
const COLORS: Record<SlotSymbol, string> = {
  '★': 'yellowBright',
  '◆': 'magentaBright',
  '♠': 'cyanBright',
  '♥': 'redBright',
  K: 'blueBright',
  Q: 'greenBright',
  W: 'whiteBright',
}

// every symbol is one column wide, and every cell is padded to the same width, so the reels line up
// whatever lands in them
const CELL_WIDTH = 4
const BOARD_WIDTH = REELS * CELL_WIDTH + 2

// The spin, counted in frames rather than wall clock: one ticker drives the whole thing, so there
// is no drift between the reels and no timer left running when the board is idle.
const TICK_MS = 50
const FIRST_STOP_MS = 400
const STOP_GAP_MS = 250
/** the frame each reel lands on: 400ms, then every 250ms after that */
const STOPS_AT = Array.from({ length: REELS }, (_, reel) => Math.round((FIRST_STOP_MS + STOP_GAP_MS * reel) / TICK_MS))
const LANDED = STOPS_AT[REELS - 1]
/** the flash after the reels land: three off-beats, ending lit */
const FLASH_TICKS = 4
const FLASH_BEATS = 6
const FLASH_OVER = LANDED + FLASH_TICKS * FLASH_BEATS

/** the wallet as the hooks module last handed it over; the board never decides what it holds */
type Props = { balance?: number; lineBet?: number } | undefined
type Spin = { tick: number; outcome: SpinOutcome; paid: GameState }
type State = {
  game: GameState
  /** the last props taken up, so a wallet that has not moved is not taken up twice */
  seen: GameState
  window: SlotSymbol[][]
  outcome?: SpinOutcome
  spin?: Spin
  message?: string
}
type Span = { text: string; color: string; dim: boolean; bold: boolean }

/** turning reels take no input; once they have landed the flash is just decoration, so it does not */
const turning = (state: State): boolean => state.spin !== undefined && state.spin.tick < LANDED

const randomStops = (): number[] => Array.from({ length: REELS }, () => Math.floor(Math.random() * 1e6))
/** a column of symbols off the real strips, which is what a reel shows while it is still turning */
const blur = (): SlotSymbol[][] => evaluateStops(randomStops(), 1).window

const fromProps = (props: Props, fallback: GameState): GameState => ({
  balance: typeof props?.balance === 'number' ? props.balance : fallback.balance,
  lineBet: typeof props?.lineBet === 'number' ? props.lineBet : fallback.lineBet,
})

export default function Slot(props: Props, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements

  const spin = () => {
    const s = surface.state
    // a press while the reels are turning is ignored: the spin that is running is the spin you get.
    // A press during the flash starts the next one, so the board can be played at speed.
    if (!s || turning(s)) return
    const result = resolveSpin(s.game, Math.random)
    if ('error' in result) {
      // no top-up: the three ways out are all the player gets, and they are all on screen
      const bet = totalBet(s.game.lineBet)
      const cheaper = s.game.lineBet > LINE_BETS[0] ? `- drops the line bet to ${stepLineBet(s.game, -1).lineBet}` : 'the line bet is already at its lowest'
      const message = `${s.game.balance} credits is not enough for a ${bet}-credit spin · ${cheaper} · Claude pays ${TURN_REWARD} each time it finishes a turn · /slot reset starts over`
      surface.setState({ ...s, message })
      return
    }
    // the stake leaves now and the win arrives when the last reel lands, so the balance on screen is
    // never ahead of the reels
    surface.setState({
      game: { ...s.game, balance: s.game.balance - totalBet(s.game.lineBet) },
      window: blur(),
      outcome: undefined,
      spin: { tick: 0, outcome: result.outcome, paid: result.state },
      message: undefined,
    })
  }

  // the new bet shows on the board straight away — the next spin is not where the player finds out
  const changeBet = (direction: number) => {
    const s = surface.state
    if (!s || turning(s)) return
    const game = stepLineBet(s.game, direction)
    if (game.lineBet !== s.game.lineBet) surface.post({ slot: true, lineBet: game.lineBet })
    surface.setState({ ...s, game, message: undefined })
  }

  if (surface.state === undefined) {
    // reels at rest before the first spin: a board to look at, and nothing paid for it
    const start = fromProps(props, INITIAL_STATE)
    surface.setState({ game: start, seen: start, window: blur() })
    surface.every(TICK_MS, () => {
      const s = surface.state
      // nothing to draw between spins, so the idle board costs no frames
      if (!s?.spin) return
      const tick = s.spin.tick + 1
      const landed = tick >= LANDED
      // a reel that has landed shows the outcome; the ones still turning keep changing
      const rolling = landed ? undefined : blur()
      const window = rolling
        ? s.spin.outcome.window.map((column, reel) => (tick >= STOPS_AT[reel] ? column : rolling[reel]))
        : s.spin.outcome.window
      // the moment the last reel is home: tell the hooks module what this spin cost and paid, and
      // let it work out the balance against the store
      if (landed && s.spin.tick < LANDED) surface.post({ slot: true, bet: totalBet(s.game.lineBet), win: s.spin.outcome.totalWin })
      surface.setState({
        ...s,
        // the win is only counted once every reel is home
        game: landed ? s.spin.paid : s.game,
        window,
        outcome: landed ? s.spin.outcome : undefined,
        spin: tick >= FLASH_OVER ? undefined : { ...s.spin, tick },
      })
    })
    surface.onPointer(ev => {
      if (ev.type === 'down') spin()
    })
    surface.onKey(({ key }) => {
      // the space bar may arrive as the character or by name
      const k = key === 'space' ? ' ' : key.toLowerCase()
      if (k === ' ' || k === 'return') spin()
      // '=' and '_' are what the + and - keys give unshifted
      else if (k === '+' || k === '=') changeBet(1)
      else if (k === '-' || k === '_') changeBet(-1)
    })
  }

  // The wallet is one file per machine, so another session — or Claude finishing a turn — can move
  // it under this board. Whatever comes back is the truth; the board only holds a picture of it.
  // While the reels are turning the picture is left alone, so a spin still lands on its own result.
  const held = surface.state
  if (held && !turning(held)) {
    const next = fromProps(props, held.seen)
    if (next.balance !== held.seen.balance || next.lineBet !== held.seen.lineBet) {
      surface.setState({ ...held, game: next, seen: next })
    }
  }

  const s = surface.state
  const spinning = s?.spin !== undefined
  const win = s?.outcome?.totalWin ?? 0
  // the winning cells, exactly as the game module named them; they blink off and on while the flash
  // runs and stay lit once it is over
  const beat = s?.spin ? Math.floor((s.spin.tick - LANDED) / FLASH_TICKS) : 0
  const showWin = !s?.spin || s.spin.tick >= LANDED
  const lit = new Set(
    showWin && beat % 2 === 0 ? (s?.outcome?.lines ?? []).flatMap(line => line.cells.map(([reel, row]) => `${reel},${row}`)) : [],
  )
  const dimRest = lit.size > 0

  // one span per run of cells that share a colour and a weight: fewer nodes for the engine to draw
  const rows = Array.from({ length: ROWS }, (_, row) => {
    const spans: Span[] = []
    for (let reel = 0; reel < REELS; reel++) {
      const symbol = s?.window[reel][row] ?? 'Q'
      const on = lit.has(`${reel},${row}`)
      const span = { text: ` ${symbol}  `.slice(0, CELL_WIDTH), color: COLORS[symbol], dim: dimRest && !on, bold: on }
      const last = spans[spans.length - 1]
      if (last && last.color === span.color && last.dim === span.dim && last.bold === span.bold) last.text += span.text
      else spans.push(span)
    }
    return (
      <Text>
        {spans.map(span => (
          <Text color={span.color} dimColor={span.dim} bold={span.bold}>
            {span.text}
          </Text>
        ))}
      </Text>
    )
  })

  const lineBet = s?.game.lineBet ?? INITIAL_STATE.lineBet
  const balance = s?.game.balance ?? INITIAL_STATE.balance
  const lines = s?.outcome?.lines.length ?? 0
  const result = spinning && !showWin ? 'spinning…'
    : win > 0 ? `won ${win} on ${lines} line${lines === 1 ? '' : 's'}`
    : s?.outcome ? 'no win'
    : 'ready'
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={win > 0 ? 'yellow' : 'gray'} width={BOARD_WIDTH}>
        {rows}
      </Box>
      <Text wrap="truncate-end">
        <Text bold color={win > 0 ? 'yellow' : undefined}>{result}</Text>
        <Text dimColor>{' · balance '}</Text>
        <Text>{balance}</Text>
        <Text dimColor>{' · line bet '}</Text>
        <Text>{lineBet}</Text>
        <Text dimColor>{` × ${LINE_COUNT} lines = `}</Text>
        <Text>{totalBet(lineBet)}</Text>
      </Text>
      {s?.message
        ? <Text color="redBright" wrap="truncate-end">{s.message}</Text>
        : <Text dimColor wrap="truncate-end">click the board, then space or enter spins · + and - change the line bet · Esc returns to the prompt</Text>}
    </Box>
  )
}
