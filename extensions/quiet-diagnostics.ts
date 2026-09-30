import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi paints two kinds of startup noise in the chat:
 *
 * 1. `[Skill conflicts]` / `[Extension issues]` blocks built by
 *    `InteractiveMode.showLoadedResources()` from `ResourceLoader` results.
 * 2. Plain `Warning: ...` chat lines replayed from `startupDiagnostics`
 *    (computed in `main.js` before the TUI exists, so nothing can filter them
 *    at the source).
 *
 * This extension only changes rendering. Resource discovery, precedence, loaded
 * extensions, sessions, and model context are untouched: real problems stay
 * visible (`Failed to load extension`, invalid Skill/Prompt/Theme metadata),
 * while advisory noise is dropped.
 *
 * Lifecycle (v0.3.0): the patch is installed **once, at module load**, and is
 * never removed for the life of the process.
 *
 * Earlier versions installed from the `session_start` handler and released the
 * patch on `session_shutdown`. That left a window — a session switch (`/resume`,
 * `--continue`, `--resume` from a picker) tears the old session down and builds a
 * new one — where a warning could be rendered by a briefly unpatched prototype.
 * A display-only filter has no reason to be transient, so it now stays installed
 * for the process lifetime. Real problems still surface: a failing or missing
 * patch reports through `/quiet-diagnostics` and a one-time startup notification.
 */

type DiagnosticRecord = {
  type?: string;
  collision?: {
    resourceType?: string;
  };
  [key: string]: unknown;
};

type SkillsResult = {
  skills: unknown[];
  diagnostics: DiagnosticRecord[];
};

type ExtensionsResult = {
  extensions: unknown[];
  errors: unknown[];
  warnings?: unknown[];
  [key: string]: unknown;
};

type ResourceLoaderLike = {
  getSkills(): SkillsResult;
  getExtensions(): ExtensionsResult;
};

type ExtensionRunnerLike = {
  getCommandDiagnostics(): DiagnosticRecord[];
  getShortcutDiagnostics(): DiagnosticRecord[];
};

type InteractiveModeLike = {
  session?: {
    resourceLoader?: ResourceLoaderLike;
    extensionRunner?: ExtensionRunnerLike;
  };
  getBuiltInCommandConflictDiagnostics?: (runner: ExtensionRunnerLike) => DiagnosticRecord[];
};

type AnyFunction = (...args: any[]) => any;

export type ShowLoadedResources = (this: InteractiveModeLike, options?: unknown) => unknown;
export type ShowWarning = (this: unknown, message: string) => unknown;

/**
 * Duplicate Skills discovered in several roots are normal (`~/.pi/skills` vs
 * `~/.agents/skills` vs project dirs). Only those collisions are hidden; Skill
 * metadata/path warnings stay visible.
 */
export function filterSkillCollisionDiagnostics<T extends SkillsResult>(result: T): T {
  const diagnostics = result.diagnostics.filter(
    (diagnostic) =>
      !(
        diagnostic.type === "collision" &&
        diagnostic.collision?.resourceType === "skill"
      ),
  );

  if (diagnostics.length === result.diagnostics.length) return result;
  return { ...result, diagnostics };
}

/**
 * `[Extension issues]` is one merged block: `getExtensions().errors` plus every
 * warning source (extension package manifests, built-in replacement, command
 * and shortcut conflicts). Warnings there are advisory, so the block keeps
 * errors only.
 */
export function dropWarningDiagnostics(diagnostics: DiagnosticRecord[]): DiagnosticRecord[] {
  const kept = diagnostics.filter((diagnostic) => diagnostic.type !== "warning");
  return kept.length === diagnostics.length ? diagnostics : kept;
}

/** Advisory extension package warnings (`Host-provided extension packages ...`, replaced built-ins). */
export function dropExtensionWarnings<T extends ExtensionsResult>(result: T): T {
  const warnings = result.warnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return result;
  return { ...result, warnings: [] };
}

/**
 * `main.js` renders every extension warning as
 * `Extension package "<path>": <warning>`. Match on a couple of stable anchors
 * (the `Extension package` prefix and pi's own "must be declared in
 * peerDependencies" text) so a wording tweak upstream doesn't let the noise
 * back in. A leading `Warning: ` is stripped defensively.
 */
const SILENCED_STARTUP_WARNING = /^Extension package\b|Host-provided extension packages must be declared in peerDependencies/;

export function isSilencedStartupWarning(message: string): boolean {
  if (typeof message !== "string") return false;
  return SILENCED_STARTUP_WARNING.test(message.replace(/^Warning:\s*/, ""));
}

type TemporaryOverride = {
  target: object;
  key: string;
  previous: PropertyDescriptor | undefined;
};

function getFunction(target: unknown, key: string): AnyFunction | undefined {
  if (!target || typeof target !== "object") return undefined;
  const value = (target as Record<string, unknown>)[key];
  return typeof value === "function" ? (value as AnyFunction) : undefined;
}

/**
 * Instance-scoped override: the prototype patch must not leak, because the
 * unpatched accessors are used for real feature work (autocomplete, tool
 * registration, reload).
 */
function overrideFunction(target: unknown, key: string, value: AnyFunction): TemporaryOverride | undefined {
  if (!target || typeof target !== "object") return undefined;
  if (typeof (target as Record<string, unknown>)[key] !== "function") return undefined;

  const previous = Object.getOwnPropertyDescriptor(target, key);
  try {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    return { target: target as object, key, previous };
  } catch {
    return undefined;
  }
}

function restoreOverrides(overrides: Array<TemporaryOverride | undefined>): void {
  for (const override of overrides) {
    if (!override) continue;
    if (override.previous) {
      Object.defineProperty(override.target, override.key, override.previous);
    } else {
      delete (override.target as Record<string, unknown>)[override.key];
    }
  }
}

export function createPatchedShowLoadedResources(
  original: ShowLoadedResources,
): ShowLoadedResources {
  return function patchedShowLoadedResources(this: InteractiveModeLike, options?: unknown) {
    const loader = this.session?.resourceLoader;
    const runner = this.session?.extensionRunner;

    const getSkills = getFunction(loader, "getSkills");
    const getExtensions = getFunction(loader, "getExtensions");
    const getCommandDiagnostics = getFunction(runner, "getCommandDiagnostics");
    const getShortcutDiagnostics = getFunction(runner, "getShortcutDiagnostics");
    const getBuiltInConflicts = getFunction(this, "getBuiltInCommandConflictDiagnostics");

    const overrides = [
      getSkills &&
        overrideFunction(loader, "getSkills", function (this: ResourceLoaderLike) {
          return filterSkillCollisionDiagnostics(getSkills.call(this));
        }),
      getExtensions &&
        overrideFunction(loader, "getExtensions", function (this: ResourceLoaderLike) {
          return dropExtensionWarnings(getExtensions.call(this));
        }),
      getCommandDiagnostics &&
        overrideFunction(runner, "getCommandDiagnostics", function (this: ExtensionRunnerLike) {
          return dropWarningDiagnostics(getCommandDiagnostics.call(this));
        }),
      getShortcutDiagnostics &&
        overrideFunction(runner, "getShortcutDiagnostics", function (this: ExtensionRunnerLike) {
          return dropWarningDiagnostics(getShortcutDiagnostics.call(this));
        }),
      getBuiltInConflicts &&
        overrideFunction(this, "getBuiltInCommandConflictDiagnostics", function (this: InteractiveModeLike, runnerArg: ExtensionRunnerLike) {
          return dropWarningDiagnostics(getBuiltInConflicts.call(this, runnerArg));
        }),
    ];

    if (overrides.every((override) => !override)) {
      return original.call(this, options);
    }

    try {
      return original.call(this, options);
    } finally {
      restoreOverrides(overrides);
    }
  };
}

/** Swallow replayed extension warnings; every other chat warning is untouched. */
export function createPatchedShowWarning(original: ShowWarning): ShowWarning {
  return function patchedShowWarning(this: unknown, message: string) {
    if (isSilencedStartupWarning(message)) return undefined;
    return original.call(this, message);
  };
}

// ---------------------------------------------------------------------------
// Install-once state
//
// Shared across module instances (pi re-evaluates the module on `/reload`)
// via a process-global symbol, so a reload never double-wraps the prototype and
// never leaves it unpatched. The patch is intentionally never released.
// ---------------------------------------------------------------------------

const STATE_KEY = Symbol.for("pi-quiet-diagnostics.state");
const PATCH_MARKER = Symbol.for("pi-quiet-diagnostics.patched");

type PatchStatus = "not-installed" | "installed" | "failed";

type PatchState = {
  status: PatchStatus;
  installPromise?: Promise<PatchStatus> | undefined;
  error?: string;
  /** Ordered log of session_start reasons seen, for `/quiet-diagnostics`. */
  sessionStarts: string[];
};

type InteractiveModePrototype = {
  showLoadedResources: ShowLoadedResources;
  showWarning: ShowWarning;
};

function getState(): PatchState {
  const values = globalThis as typeof globalThis & {
    [STATE_KEY]?: PatchState;
  };
  values[STATE_KEY] ??= { status: "not-installed", sessionStarts: [] };
  return values[STATE_KEY];
}

function isMarkedPatched(fn: unknown): boolean {
  return typeof fn === "function" && Boolean((fn as Record<symbol, unknown>)[PATCH_MARKER]);
}

function markPatched<T extends AnyFunction>(fn: T): T {
  Object.defineProperty(fn, PATCH_MARKER, { value: true, configurable: true });
  return fn;
}

async function importInteractiveMode(): Promise<InteractiveModePrototype> {
  // Import through pi's extension loader (jiti alias / virtualModules) so the
  // class resolves to the running instance under both dist and bundled builds.
  const module = (await import("@earendil-works/pi-coding-agent")) as {
    InteractiveMode?: { prototype: InteractiveModePrototype };
  };
  if (!module.InteractiveMode?.prototype) {
    throw new Error("InteractiveMode missing");
  }
  return module.InteractiveMode.prototype;
}

const PATCHES = [
  { name: "showLoadedResources", create: createPatchedShowLoadedResources },
  { name: "showWarning", create: createPatchedShowWarning },
] as const;

/**
 * Resolve every original first: a newer pi that renamed one of these methods
 * must fail open (nothing patched) instead of half-silencing startup.
 */
async function installPatch(): Promise<PatchStatus> {
  const prototype = await importInteractiveMode();

  const patchedHolder = prototype as unknown as Record<string, unknown>;

  // Already patched (a `/reload` re-evaluated this module, or two instances
  // raced): do nothing so we never double-wrap.
  if (PATCHES.every(({ name }) => isMarkedPatched(patchedHolder[name]))) {
    return "installed";
  }

  const originals = PATCHES.map(({ name }) => {
    const original = patchedHolder[name];
    if (typeof original !== "function") {
      throw new Error(`InteractiveMode.${name} missing`);
    }
    return original as AnyFunction;
  });

  // Wrap sequentially; if any method is missing we bail out before touching the
  // prototype (originals above already threw in that case).
  PATCHES.forEach(({ name, create }, index) => {
    patchedHolder[name] = markPatched(create(originals[index]));
  });

  return "installed";
}

/**
 * Install the patch once per process. Safe to call from anywhere, at any time,
 * any number of times: concurrent calls share one in-flight promise.
 */
export function ensurePatchInstalled(): Promise<PatchStatus> {
  const state = getState();
  if (state.status === "installed") return Promise.resolve("installed");

  const pending = state.installPromise ?? installPatch();
  state.installPromise = pending;
  return pending.then(
    (status) => {
      state.status = status;
      if (state.installPromise === pending) state.installPromise = undefined;
      return status;
    },
    (error) => {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
      if (state.installPromise === pending) state.installPromise = undefined;
      throw error;
    },
  );
}

function isStaleCtxError(error: unknown): boolean {
  return /stale after session replacement|extension ctx is stale/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function reportFailureOnce(ctx: {
  hasUI?: boolean;
  ui?: { notify(message: string, level?: "info" | "warning" | "error"): void };
}): Promise<void> {
  const state = getState();
  if (state.status !== "failed" || !state.error) return;
  try {
    ctx.ui?.notify?.(`quiet-diagnostics inactive: ${state.error}`, "warning");
  } catch {
    /* ignore notify failures (including stale ctx) */
  }
}

export default function (pi: ExtensionAPI) {
  // Install immediately at module load — before any session, any mode, any
  // TUI. This is the whole point of v0.3.0: no window in which a session switch
  // could render a warning through an unpatched prototype.
  void ensurePatchInstalled().catch(() => {
    /* retried on session_start; reported there once */
  });

  pi.registerCommand("quiet-diagnostics", {
    description: "Show whether the startup-diagnostics patch is active",
    handler: async (_args, ctx) => {
      await ensurePatchInstalled().catch(() => {
        /* status + error already recorded */
      });
      const state = getState();
      const lines = [
        `quiet-diagnostics ${state.status === "installed" ? "active" : state.status}`,
        state.status === "installed"
          ? "Hides advisory startup warnings (skill collisions, extension package/command warnings). Errors stay visible."
          : `inactive (${state.error ?? "unknown error"})`,
        `mode: ${ctx.mode}${ctx.isProjectTrusted?.() === false ? " (project untrusted)" : ""}`,
        `cwd: ${ctx.cwd}`,
        `session starts seen: ${state.sessionStarts.length > 0 ? state.sessionStarts.join(", ") : "none yet"}`,
      ];
      try {
        ctx.ui.notify(lines.join("\n"), state.status === "installed" ? "info" : "warning");
      } catch {
        /* ignore notify failures */
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    // Never throw from session_start — pi paints a red stack into the chat
    // for every failed extension handler, including "ctx is stale after
    // session replacement" races during rebind/init.
    try {
      const state = getState();
      state.sessionStarts.push(String(event.reason ?? "unknown"));
      if (state.sessionStarts.length > 8) state.sessionStarts.shift();

      // Module-load install normally already won the race; this is a cheap
      // retry for the case where the initial import was still in flight or
      // failed, plus a one-time report if it still can't install.
      const status = await ensurePatchInstalled().catch((error) => {
        if (isStaleCtxError(error)) return "failed" as const;
        throw error;
      });

      if (status === "failed") {
        await reportFailureOnce(ctx);
      }
    } catch (error) {
      if (isStaleCtxError(error)) return;
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `quiet-diagnostics: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "warning",
          );
        }
      } catch {
        /* ignore notify failures (including stale ctx) */
      }
    }
  });
}
