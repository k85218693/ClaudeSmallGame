# claude-small-game

A 5×3 slot machine in the band above the Claude Code prompt. Five reels turn, stop left to right and
the winning lines flash. Credits are one wallet per machine, and Claude pays you 10 of them every
time it finishes a turn — so the machine is fed by the work you were doing anyway.

```
╭────────────────────╮
│ ♠   W   ♠   K   Q  │
│ K   ♥   K   ♥   ♥  │
│ ♥   K   Q   W   ♠  │
╰────────────────────╯
won 30 on 2 lines · balance 1040 · line bet 2 × 5 lines = 10  +10
```

## Install

Two lines, from anywhere:

```sh
claude plugin marketplace add k85218693/ClaudeSmallGame
claude plugin install claude-small-game@claude-small-game
```

Restart Claude Code and type `/slot`.

To run it from a clone instead, point the first line at the checkout —
`claude plugin marketplace add ./ClaudeSmallGame` — and install the same way.

## It needs function hooks

The plugin is nothing but function hooks, an early-access feature that is off unless the environment
says otherwise. Turn it on:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1   # or the same key under "env" in settings.json
```

Without it the plugin still installs and `hooks/hooks.json` is simply ignored: **`/slot` is not a
command at all** ("Unknown slash command"), no board appears, and nothing is written to the wallet.
That is the symptom to look for. It also needs an interactive terminal — the board is drawn on the
`terminal` surface only, so a headless run (`claude -p`) never shows it.

Run with `claude --debug` if `/slot` exists but the board does not: a hook that fails is skipped and
the debug log says which one and why.

## Playing

| | |
| --- | --- |
| `/slot` | opens the board above the prompt |
| click the board | gives it focus, so it takes the keys |
| space or enter | spins |
| `+` / `-` | steps the line bet through 1, 2, 5, 10 |
| Esc | hands the keys back to the prompt (the board stays up) |
| `/slot stop` | closes the board; the balance is where you left it |
| `/slot reset` | puts the balance back to 1000 and leaves the line bet alone |
| `/slot stats` | prints the paytable and the RTP these reels actually pay |

A spin costs the line bet × 5 lines. Wins read left to right from reel 1, three of a kind or more.
`W` is wild on reels 2–4, joins any symbol, and pays nothing on its own.

**What Claude pays.** Every turn Claude finishes credits the wallet 10, whether or not the board is
open — with the board open a green `+10` flashes on it for a moment, and with the board closed the
credits are simply there the next time you open it. A turn you interrupt does not pay, and a
subagent's turn is part of the turn that started it rather than another one. Nothing is posted to
the transcript and no toast is raised.

A spin costs its stake the moment the reels start turning, so closing the board or ending the
session mid-spin does not get you the spin for free — and the win, if there is one, is paid when the
last reel lands.

**One wallet per machine.** The wallet is the plugin's own store, which is one file per machine and
not per project, so two Claude Code sessions open at once are playing the same balance. Every write
re-reads the store, applies what changed and writes it back — a board never sends a balance it
worked out itself — so spinning in both at the same time loses nothing. `/slot reset` is the one
exception: it overrules the balance outright, in every session.

## The maths

RTP is **94.949%** — counted, not sampled: every one of the 24⁵ = 7,962,624 ways the reels can land
is equally likely, and `node --test` walks all of them on every run. `/slot stats` prints that same
number from the same function, so the table you read and the number the suite pins cannot drift
apart. The hit rate is 50.51%, mostly the small three-of-a-kinds.

Pay per line at a line bet of 1, for 3 / 4 / 5 of a kind:

| ★ | ◆ | ♠ | ♥ | K | Q |
| --- | --- | --- | --- | --- | --- |
| 10 / 50 / 250 | 6 / 25 / 100 | 4 / 15 / 60 | 3 / 10 / 40 | 2 / 6 / 25 | 2 / 5 / 20 |

## Working on it

```sh
claude --plugin-dir .          # load this checkout for one session; saving a file reloads it
node --test                    # the game rules and the exact RTP
npx oxlint@1.83.0 hooks tests --deny-warnings
claude plugin validate .claude-plugin/plugin.json   # what the engine sees this plugin hook and call
```

The `claude-code` types are generated per machine and per build by `/plugin-types` (into
`.claude/types`, which is not in version control), so `tsc --noEmit` only runs after that command;
CI lints and tests instead. `hooks/games/slot.ts` holds the rules with nothing on screen in them,
`hooks/boards/slot.tsx` draws the board, and `hooks/register.tsx` is the one hooks module and owns
the wallet.

MIT.
