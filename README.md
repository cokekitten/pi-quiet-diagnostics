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
  it at the source). Matching anchors: the `Extension package` prefix and Pi's
  own `Host-provided extension packages must be declared in peerDependencies`
  text, so a wording tweak upstream does not let the noise back in.

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

## Lifecycle

The patch is installed **once, at module load**, and stays installed for the
life of the process. It is never released.

0.2.x installed from the `session_start` handler and restored on
`session_shutdown`. A session switch (`pi -c`, `pi -r`, `/resume`, fork) tears
the old session down and builds a new one, which opened a window where a
warning could reach the chat through a briefly unpatched prototype. A
display-only filter has no reason to be transient, so 0.3.0 installs it as early
as possible and leaves it alone. `/reload` re-evaluates the module, but the
patched functions carry a marker so nothing is ever double-wrapped.

## Self check

```
/quiet-diagnostics
```

Reports whether the patch is active, the run mode, the cwd, and the
`session_start` reasons seen so far. Use it when warnings appear in one
session but not another — it answers "is this extension even loaded here?"
(usually: an old copy of this package, an install that is not user-scoped, or
the project being untrusted) in one keypress.

## Root cause of the `typebox` warnings

The most common warnings come from third-party packages that ship a
host-provided dependency (`typebox`) in `dependencies` instead of
`peerDependencies` with a `"*"` range — Pi warns once per package, on every
start. Pi provides `typebox` itself, so moving that one entry to
`peerDependencies` in the offending `package.json` removes the warning at the
source (this survives any pi upgrade and any resume path).

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
warnings). It fails open and reports through `/quiet-diagnostics` if Pi changes
the internal module path or either method, but a Pi upgrade may still require
an extension update. Verified against pi 0.99.1.

## Development

Package entry: `package.json` -> `pi.extensions` -> `./extensions/quiet-diagnostics.ts`.

```bash
npm test
```

## License

MIT
