/* @jsx h */
import type { Register } from 'claude-code'

// One command, /slot. This module is the plugin's only hooks module: it registers the command at
// session start so the very first turn can find it, and it is where the board will later be mounted
// into the AbovePrompt band. For now the command only answers with a line of text.

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
    if (arg === '') return { text: 'slot: the board is not built yet · /slot stop, reset and stats are coming too' }
    return { text: `slot: "${arg}" is not a subcommand yet · /slot on its own is all there is so far` }
  })
}
