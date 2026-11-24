# opencode-auto-resume-lite

A minimal, dependency-free **auto-resume watchdog** for [OpenCode](https://opencode.ai).

When a model stalls mid-response — a dropped stream, a silent provider timeout, a hung tool call — OpenCode just sits there until you type "continue" yourself. This plugin watches busy sessions and sends a continuation prompt automatically.

- **No subscriptions, no accounts, no telemetry**
- **~200 lines of TypeScript**, MIT licensed
- **No runtime dependencies** beyond the OpenCode SDK/plugin types
- **Tunable** down to a few seconds

## Install

Clone the repo somewhere permanent:

```sh
git clone https://github.com/BlackSnowPanther/opencode-auto-resume-lite.git
cd opencode-auto-resume-lite
npm install
npm run build
```

Then reference the local package in `~/.config/opencode/opencode.jsonc` (or `opencode.json`):

```jsonc
{
  "plugins": [
    {
      "package": "file:///absolute/path/to/opencode-auto-resume-lite",
      "options": {
        "timeoutMs": 30000,
        "checkIntervalMs": 2000,
        "maxRetries": 5,
        "debug": true
      }
    }
  ]
}
```

Restart OpenCode after changing plugins or option values.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `timeoutMs` | number | `60000` | How long a session may sit `busy` with no activity before it is treated as stalled. |
| `checkIntervalMs` | number | `10000` | How often the watchdog polls OpenCode for session status. |
| `maxRetries` | number | `5` | Maximum continue prompts sent for one stall episode. Resets when the session goes idle. |
| `continuePrompt` | string | see below | Text sent to resume the session. |
| `debug` | boolean | `false` | Log every status transition and stall decision. |

Default continue prompt:

```
Continue from where you left off. If you were in the middle of a tool call, complete it. If you were thinking, finish your thought.
```

## How it works

1. Every `checkIntervalMs`, the plugin calls `session.status()` on the OpenCode server, which returns live `idle` / `busy` / `retry` state for every session.
2. It also listens for `session.status`, `message.*`, and tool events to refresh a per-session "last activity" timestamp.
3. A session that stays `busy` with no activity longer than `timeoutMs` is considered stalled.
4. The plugin sends `continuePrompt` through `session.prompt()` and starts the clock again.
5. After `maxRetries`, it gives up on that episode and stays quiet — it re-arms once the session returns to `idle`.

Because it polls the server instead of relying only on events, it also detects sessions that were already busy before the plugin loaded.

## Tuning

For near-instant recovery:

```jsonc
"options": { "timeoutMs": 5000, "checkIntervalMs": 2000 }
```

Worst case: stall detected within `timeoutMs + checkIntervalMs`.

Tips:

- Keep your provider timeouts **longer** than `timeoutMs` so the plugin gets a chance to nudge the model before the transport gives up.
- If your model legitimately pauses for long reasoning stretches, raise `timeoutMs` instead of disabling the plugin.
- Enable `debug` and check the OpenCode log (`~/.local/share/opencode/log/opencode.log` on Windows) for `[auto-resume]` lines when tuning.

## Development

```sh
npm install
npm run build     # emits dist/index.js + dist/index.d.ts
npm run dev       # watch mode
```

`dist/` is committed so the plugin works straight from a clone without a build step.

## License

MIT © BlackSnowPanther
