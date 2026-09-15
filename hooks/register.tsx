/* @jsx h */
import type { Register } from 'claude-code'
import { INITIAL_STATE, LINE_BETS, applyDelta, type GameState } from './games/slot.ts'

// One command, /slot. This module is the plugin's only hooks module: it registers the command at
// session start, mounts the board into the band above the prompt, and owns the wallet.
//
// The wallet is the plugin's own key-value store, which is one file per machine — not per project —
// so two sessions open at once are writing to the same place. That is why the board never sends an
// absolute balance: it posts what this spin cost and what it paid, and every write here re-reads the
// store first, applies the difference and hands the authoritative balance back as the board's next
// props. A session that spins while another one is spinning loses nothing.
//
// $ cannot be handed to a helper — the engine reads `$.noun.event(...)` off this source — so each
// hook opens the store itself and only the arithmetic is shared.

let wallet: GameState = INITIAL_STATE
let open = false

/** whatever the store holds, turned into a wallet; anything it cannot account for starts fresh */
const walletFrom = (balance: unknown, lineBet: unknown): GameState => ({
  balance: typeof balance === 'number' && Number.isFinite(balance) ? Math.max(0, Math.floor(balance)) : INITIAL_STATE.balance,
  lineBet: typeof lineBet === 'number' && LINE_BETS.includes(lineBet) ? lineBet : INITIAL_STATE.lineBet,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // a store that cannot be read or written costs the wallet, never the session: an unhandled
    // rejection in a hook unmounts the whole module
    const failed = (what: string) => (err: unknown) => {
      $.ui.log(`claude-small-game: store ${what} failed: ${err}`)
      return undefined
    }
    wallet = walletFrom(await $.store.get('balance').catch(failed('read')), await $.store.get('lineBet').catch(failed('read')))
    // first run on this machine: put the starting wallet where the next session will find it
    await $.store.set('balance', wallet.balance).catch(failed('write'))
    await $.store.set('lineBet', wallet.lineBet).catch(failed('write'))
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
    if (arg === 'stop') {
      open = false
      $.ui.invalidate('ui.render')
      return { text: 'slot closed' }
    }
    if (arg !== '') return { text: `slot: "${arg}" is not a subcommand yet · /slot opens the board, /slot stop closes it` }
    const failed = (err: unknown) => {
      $.ui.log(`claude-small-game: store read failed: ${err}`)
      return undefined
    }
    // the balance may have moved in another session since this one last looked
    wallet = walletFrom(await $.store.get('balance').catch(failed), await $.store.get('lineBet').catch(failed))
    open = true
    $.ui.invalidate('ui.render')
    return { text: `slot: ${wallet.balance} credits · click the board above the prompt, then space spins · Esc returns to the prompt · /slot stop closes it` }
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
    const current = walletFrom(await $.store.get('balance').catch(failed('read')), await $.store.get('lineBet').catch(failed('read')))
    wallet = applyDelta(current, {
      bet: typeof data.bet === 'number' ? data.bet : 0,
      win: typeof data.win === 'number' ? data.win : 0,
      lineBet: typeof data.lineBet === 'number' ? data.lineBet : undefined,
    })
    await $.store.set('balance', wallet.balance).catch(failed('write'))
    await $.store.set('lineBet', wallet.lineBet).catch(failed('write'))
    return { props: wallet }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the board needs a terminal's keys and mouse; the desktop and mobile surfaces draw their own
    // band, and a survey on screen gets the space to itself
    if (!open || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const { Box, Client } = await $.ui.resolve(e)
    // the module path must be a string literal: the engine reads it straight off this source
    return (
      <Box flexDirection="column">
        <Client key="board:slot" module="./boards/slot.tsx" width={e.viewport?.columns ?? 80} props={wallet} />
        {await next(e)}
      </Box>
    )
  })
}
