# Changelog

## 0.3.0

- Install the patch at **module load** instead of from the `session_start`
  handler, and **never release it**. 0.2.x restored the prototype on
  `session_shutdown`, which opened a window during session switches
  (`pi -c`, `pi -r`, `/resume`, fork) where a warning could be rendered
  unpatched.
- Patched functions carry a marker, so `/reload` (which re-evaluates the
  module) can no longer stack a second wrapper.
- The replayed-warning filter matches on stable anchors (the
  `Extension package` prefix and pi's `... must be declared in
  peerDependencies` text) and tolerates a leading `Warning: ` prefix.
- New `/quiet-diagnostics` command: reports whether the patch is active, the
  run mode, the cwd, and the `session_start` reasons seen so far.
- Dropped the non-TUI guard: patching `InteractiveMode.prototype` is inert in
  RPC / print mode, so one code path now covers every mode.
- Documented the actual root cause of the `typebox` warnings (third-party
  packages declaring a host-provided dependency in `dependencies`).

## 0.2.0

- Renamed from `pi-skill-conflict-filter` to `pi-quiet-diagnostics`; expanded
  from Skill collisions only to all advisory extension warnings.
- Patched `showWarning` in addition to `showLoadedResources`, so replayed
  `Warning: Extension package ...` chat lines are silenced too.
- Errors stay visible: `[Extension issues]` keeps its `error` entries, and
  invalid Skill / Prompt / Theme metadata is untouched.
