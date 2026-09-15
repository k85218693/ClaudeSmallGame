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

type State = { game: GameState; window: SlotSymbol[][]; outcome?: SpinOutcome; message?: string }
type Span = { text: string; color: string; dim: boolean; bold: boolean }

const randomStops = (): number[] => Array.from({ length: REELS }, () => Math.floor(Math.random() * 1e6))

export default function Slot(_props: unknown, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements

  const spin = () => {
    const s = surface.state
    if (!s) return
    const result = resolveSpin(s.game, Math.random)
    if ('error' in result) {
      const bet = totalBet(s.game.lineBet)
      const cheaper = s.game.lineBet > LINE_BETS[0] ? ' · - lowers the line bet' : ''
      surface.setState({ ...s, message: `${s.game.balance} credits is not enough for a ${bet}-credit spin${cheaper}` })
      return
    }
    surface.setState({ game: result.state, window: result.outcome.window, outcome: result.outcome, message: undefined })
  }

  // the new bet shows on the board straight away — the next spin is not where the player finds out
  const changeBet = (direction: number) => {
    const s = surface.state
    if (!s) return
    surface.setState({ ...s, game: stepLineBet(s.game, direction), message: undefined })
  }

  if (surface.state === undefined) {
    // reels at rest before the first spin: a board to look at, and nothing paid for it
    surface.setState({ game: INITIAL_STATE, window: evaluateStops(randomStops(), INITIAL_STATE.lineBet).window })
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

  const s = surface.state
  const win = s?.outcome?.totalWin ?? 0
  // the winning cells, exactly as the game module named them
  const lit = new Set((s?.outcome?.lines ?? []).flatMap(line => line.cells.map(([reel, row]) => `${reel},${row}`)))
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
  const result = win > 0 ? `won ${win} on ${lines} line${lines === 1 ? '' : 's'}` : s?.outcome ? 'no win' : 'ready'
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
