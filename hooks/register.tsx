/* @jsx h */
import type { Register } from 'claude-code'

// One command, /slot. This module is the plugin's only hooks module: it registers the command at
// session start so the very first turn can find it, and it mounts the board into the band above the
// prompt. The board in ./boards/slot.tsx is a surface module and runs on the drawing thread; the
// rules it draws live in ./games/slot.ts.

let open = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // a command that fails to register costs the game, never the session: an unhandled rejection
    // here would unmount the whole module
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
    open = true
    $.ui.invalidate('ui.render')
    return { text: 'slot: click the board above the prompt, then space spins · Esc returns to the prompt · /slot stop closes it' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // the board needs a terminal's keys and mouse; the desktop and mobile surfaces draw their own
    // band, and a survey on screen gets the space to itself
    if (!open || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    const { Box, Client } = await $.ui.resolve(e)
    // the module path must be a string literal: the engine reads it straight off this source
    return (
      <Box flexDirection="column">
        <Client key="board:slot" module="./boards/slot.tsx" width={e.viewport?.columns ?? 80} />
        {await next(e)}
      </Box>
    )
  })
}
