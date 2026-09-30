# pi-quiet-diagnostics

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that silences advisory startup diagnostics in the interactive TUI.

**Repo:** https://github.com/cokekitten/pi-quiet-diagnostics

Formerly `pi-skill-conflict-filter` (it only hid Skill collisions).

## Why

`quietStartup` hides the startup listing, but Pi still replays diagnostics that
say nothing is broken:

```
[Skill conflicts]        the same Skill name found in several roots
[Extension issues]       extension package / command / shortcut advisories
Warning: Extension package ".../package.json": Host-provided extension packages ...
```

Third-party packages that ship host-provided deps in `dependencies` (e.g.
`typebox`) trigger one warning per package, on every start, in two places.

## Behavior

Hidden:

- Skill diagnostics where `type` is `collision` and `resourceType` is `skill`.
- Every **warning** in `[Extension issues]`: extension package manifest
  warnings, built-in extension replacement, extension command and shortcut
  conflicts.
- Replayed startup warnings of the form `Extension package "<path>": ...`
  (Pi renders each extension warning as one chat line before the TUI can filter
  it at the source).

Kept visible:

- `error` diagnostics, e.g. `Failed to load extension "..."`.
- Invalid Skill / Prompt Template / Theme metadata and path diagnostics, and
  Prompt or Theme collisions.
- Every other chat warning (model fallback, tmux hints, `ctx.ui.notify`
  messages that are not extension package warnings).

Changes display only. Skill discovery, precedence, loaded content, registered
commands and shortcuts, sessions, and model context are untouched — the
accessors are wrapped only while the startup block is rendered and restored
afterwards, so autocomplete and tool registration always see the real data.

## Install

From GitHub:

```bash
pi install git:github.com/cokekitten/pi-quiet-diagnostics
```

Or try it for one run without installing:

```bash
pi -e git:github.com/cokekitten/pi-quiet-diagnostics
```

Local checkout:

```bash
# e.g. in ~/.pi/agent/settings.json packages:
#   "../../dev/pi-expansion/pi-quiet-diagnostics"
pi install /path/to/pi-quiet-diagnostics
# or
pi -e /path/to/pi-quiet-diagnostics
```

After installing, restart pi or run `/reload`.

Run `pi --verbose` (or unset `quietStartup`) to see everything Pi reports.

## Compatibility

This extension monkey-patches Pi's private `InteractiveMode.prototype` methods
`showLoadedResources` (resource blocks) and `showWarning` (replayed startup
warnings). It fails open and shows a warning if Pi changes the internal module
path or either method, but a Pi upgrade may still require an extension update.

## Development

Package entry: `package.json` -> `pi.extensions` -> `./extensions/quiet-diagnostics.ts`.

```bash
npm test
```

## License

MIT
