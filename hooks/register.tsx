/* @jsx h */
import type { Register } from 'claude-code'
import {
  INITIAL_STATE,
  LINE_BETS,
  LINE_COUNT,
  REELS,
  ROWS,
  TURN_REWARD,
  applyDelta,
  applyTurnReward,
  paytable,
  statistics,
  totalBet,
  type GameState,
} from './games/slot.ts'

// One command, /slot. This module is the plugin's only hooks module: it registers the command at
// session start, mounts the board into the band above the prompt, and owns the wallet.
//
// The wallet is the plugin's own key-value store, which is one file per machine — not per project —
// so two sessions open at once are writing to the same place. That is why the board never sends an
// absolute balance: it posts the stake when the reels start turning and the win when they land, and
// every write here re-reads the store first, applies the difference and hands the authoritative
// balance back as the board's next props. A session that spins while another one is spinning loses
// nothing, and a read that fails is never mistaken for a wallet that is empty.
//
// $ cannot be handed to a helper — the engine reads `$.noun.event(...)` off this source — so each
// hook opens the store itself and only the arithmetic is shared.

let wallet: GameState = INITIAL_STATE
let open = false
/** how many turns Claude has finished since this session started; the board flashes each new one */
let credited = 0

/** what the board is drawn from: the wallet, plus the turn count it watches for a new +10 */
const boardProps = () => ({ ...wallet, credited })

/**
 * What a read that threw hands back, so that it cannot be mistaken for a key that was never written.
 * The difference matters more than it looks: a key with nothing under it is a first run and starts
 * at 1000, while a store that could not be read is a wallet whose balance is unknown — and writing
 * 1000 over it would be this plugin spending a player's credits for them.
 */
const UNREADABLE = Symbol('unreadable')

/** whatever the store holds, turned into a wallet; anything it cannot account for starts fresh */
const walletFrom = (balance: unknown, lineBet: unknown): GameState => ({
  balance: typeof balance === 'number' && Number.isFinite(balance) ? Math.max(0, Math.floor(balance)) : INITIAL_STATE.balance,
  lineBet: typeof lineBet === 'number' && LINE_BETS.includes(lineBet) ? lineBet : INITIAL_STATE.lineBet,
})

/** a store that will not read is a store nothing is written to; the session plays on what it holds */
const unreadable = (...values: unknown[]): boolean => values.includes(UNREADABLE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // a store that cannot be read or written costs the wallet, never the session: an unhandled
    // rejection in a hook unmounts the whole module
    const failed = (what: string) => (err: unknown) => {
      $.ui.log(`claude-small-game: store ${what} failed: ${err}`)
      return UNREADABLE
    }
    const balance = await $.store.get('balance').catch(failed('read'))
    const lineBet = await $.store.get('lineBet').catch(failed('read'))
    if (!unreadable(balance, lineBet)) {
      wallet = walletFrom(balance, lineBet)
      // first run on this machine: put the starting wallet where the next session will find it
      await $.store.set('balance', wallet.balance).catch(failed('write'))
      await $.store.set('lineBet', wallet.lineBet).catch(failed('write'))
    }
    // a command that fails to register costs the game, never the session
    await $.command.register({
      name: 'slot',
      description: 'A 5x3 slot machine above the prompt (claude-small-game)',
      argumentHint: '[stop | reset | stats]',
      immediate: true,
    }).catch(err => $.ui.log(`claude-small-game: /slot not registered: ${err}`))
    return r
  })

  // every form of /slot answers here; none of them passes the command on
  on('command.run', { command: 'slot' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const failed = (what: string) => (err: unknown) => {
      $.ui.log(`claude-small-game: store ${what} failed: ${err}`)
      return undefined
    }
    if (arg === 'stop') {
      open = false
      $.ui.invalidate('ui.render')
      return { text: 'slot: board closed · /slot opens it again, and the balance is where you left it' }
    }
    if (arg === 'stats') {
      // counted, not sampled, and counted once per session: the first call walks every stop
      // combination, which takes about a second, and every call after it reads the answer off
      const { rtp, hitRate, combinations } = statistics()
      const table = paytable().map(row => `  ${row.symbol}  ${row.pays.map(pay => String(pay).padStart(3)).join(' / ')}`)
      return {
        text: [
          `slot: ${REELS} reels × ${ROWS} rows · ${LINE_COUNT} fixed lines · line bets ${LINE_BETS.join(' / ')}`,
          `RTP ${(rtp * 100).toFixed(3)}% · hit rate ${(hitRate * 100).toFixed(2)}% · counted over all ` +
            `${combinations.toLocaleString('en-US')} stop combinations, which is what the test suite pins`,
          'pay per line at a line bet of 1, for 3 / 4 / 5 of a kind:',
          ...table,
          'W is wild on reels 2–4, joins any symbol and pays nothing on its own · wins read left to right from reel 1',
          `Claude pays ${TURN_REWARD} credits every time it finishes a turn · a spin costs the line bet × ${LINE_COUNT} lines`,
        ].join('\n'),
      }
    }
    if (arg === 'reset') {
      // the one place a balance is written whole rather than as a difference: a reset is meant to
      // overrule whatever the wallet holds, in this session and in any other one sharing it
      const balance = await $.store.get('balance').catch(failed('read'))
      const lineBet = await $.store.get('lineBet').catch(failed('read'))
      // the line bet it keeps is the stored one, so a store that will not read cannot be reset onto
      // a line bet this session only guessed at
      if (unreadable(balance, lineBet)) return { text: 'slot: the wallet could not be read, so nothing was reset · try again' }
      wallet = { balance: INITIAL_STATE.balance, lineBet: walletFrom(balance, lineBet).lineBet }
      await $.store.set('balance', wallet.balance).catch(failed('write'))
      $.ui.invalidate('ui.render')
      return {
        text: `slot: balance reset to ${wallet.balance} credits · the line bet stays where it was, at ${wallet.lineBet} ` +
          `(${totalBet(wallet.lineBet)} a spin) · every session on this machine shares the wallet, so this resets theirs too`,
      }
    }
    if (arg !== '') {
      return { text: `slot: "${arg}" is not a subcommand · /slot opens the board, and stop, reset and stats are the three it takes` }
    }
    // the balance may have moved in another session since this one last looked; if it will not read,
    // the board opens on the wallet this session already has rather than on one made up here
    const balance = await $.store.get('balance').catch(failed('read'))
    const lineBet = await $.store.get('lineBet').catch(failed('read'))
    if (!unreadable(balance, lineBet)) wallet = walletFrom(balance, lineBet)
    open = true
    $.ui.invalidate('ui.render')
    return { text: `slot: ${wallet.balance} credits · click the board above the prompt, then space spins · + and - change the line bet · Esc returns to the prompt · /slot stop closes it` }
  })

  // Claude finishing a turn is what pays for the next spin. It settles the same way a spin does —
  // re-read the store, apply the difference, write it back — so a turn credited while another
  // session is mid-spin adds to that spin's result instead of overwriting it. Nothing is said in
  // the transcript and no toast is raised: the board flashes it, or it is there next time it opens.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const { agentId, isAborted } = e as { agentId?: string; isAborted?: boolean }
    // a subagent's turn is Claude working inside this one, not another turn finished, and a turn
    // the user interrupted was not finished at all
    if (agentId !== undefined || isAborted === true) return r
    const failed = (what: string) => (err: unknown) => {
      $.ui.log(`claude-small-game: store ${what} failed: ${err}`)
      return undefined
    }
    const balance = await $.store.get('balance').catch(failed('read'))
    const lineBet = await $.store.get('lineBet').catch(failed('read'))
    // an unreadable store swallows the credit rather than paying it against a balance nobody knows:
    // the next turn that reads the store cleanly is the one that pays
    if (unreadable(balance, lineBet)) return r
    wallet = applyTurnReward(walletFrom(balance, lineBet))
    await $.store.set('balance', wallet.balance).catch(failed('write'))
    credited++
    if (open) $.ui.invalidate('ui.render')
    return r
  })

  // the board posts what a spin cost and what it paid, or a new line bet — never a balance it worked
  // out itself. Re-read, apply, write back, hand the authoritative wallet forward as props.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { slot?: unknown; bet?: unknown; win?: unknown; lineBet?: unknown } | null
    if (data?.slot !== true) return next(e)
    const failed = (what: string) => (err: unknown) => {
      $.ui.log(`claude-small-game: store ${what} failed: ${err}`)
      return undefined
    }
    const balance = await $.store.get('balance').catch(failed('read'))
    const lineBet = await $.store.get('lineBet').catch(failed('read'))
    // applyDelta throws out anything that is not a number the wallet can take, so a board cannot
    // mint credits with a negative bet or poison the store with a NaN. Against an unreadable store
    // the spin settles on this session's own wallet and is not written: the board stays sensible,
    // and nobody else's balance is overwritten by a guess.
    const delta = {
      bet: typeof data.bet === 'number' ? data.bet : 0,
      win: typeof data.win === 'number' ? data.win : 0,
      lineBet: typeof data.lineBet === 'number' ? data.lineBet : undefined,
    }
    if (unreadable(balance, lineBet)) {
      wallet = applyDelta(wallet, delta)
      return { props: boardProps() }
    }
    wallet = applyDelta(walletFrom(balance, lineBet), delta)
    await $.store.set('balance', wallet.balance).catch(failed('write'))
    await $.store.set('lineBet', wallet.lineBet).catch(failed('write'))
    return { props: boardProps() }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the board needs a terminal's keys and mouse; the desktop and mobile surfaces draw their own
    // band, and a survey on screen gets the space to itself
    if (!open || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const { Box, Client } = await $.ui.resolve(e)
    // the module path must be a string literal: the engine reads it straight off this source
    return (
      <Box flexDirection="column">
        <Client key="board:slot" module="./boards/slot.tsx" width={e.viewport?.columns ?? 80} props={boardProps()} />
        {await next(e)}
      </Box>
    )
  })
}
