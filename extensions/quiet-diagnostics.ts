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

/** `main.js` renders every extension warning as `Extension package "<path>": <warning>`. */
const SILENCED_STARTUP_WARNING = /^Extension package\b/;

export function isSilencedStartupWarning(message: string): boolean {
  return SILENCED_STARTUP_WARNING.test(message);
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
    if (typeof message === "string" && isSilencedStartupWarning(message)) return undefined;
    return original.call(this, message);
  };
}

const STATE_KEY = Symbol.for("pi-quiet-diagnostics.state");

type PatchState = {
  refCount: number;
  cleanup?: (() => void) | undefined;
  installPromise?: Promise<() => void> | undefined;
  release?: (() => Promise<void>) | undefined;
};

function getState(): PatchState {
  const values = globalThis as typeof globalThis & {
    [STATE_KEY]?: PatchState;
  };
  values[STATE_KEY] ??= { refCount: 0 };
  return values[STATE_KEY];
}

type InteractiveModePrototype = {
  showLoadedResources: ShowLoadedResources;
  showWarning: ShowWarning;
};

async function importInteractiveMode(): Promise<{
  prototype: InteractiveModePrototype;
}> {
  // Import through pi's extension loader (jiti alias / virtualModules) so the
  // class resolves to the running instance under both dist and bundled builds.
  const module = (await import("@earendil-works/pi-coding-agent")) as {
    InteractiveMode?: { prototype: InteractiveModePrototype };
  };
  if (!module.InteractiveMode?.prototype) {
    throw new Error("InteractiveMode missing");
  }
  return module.InteractiveMode;
}

const PATCHES = [
  { name: "showLoadedResources", create: createPatchedShowLoadedResources },
  { name: "showWarning", create: createPatchedShowWarning },
] as const;

async function installPatch(): Promise<() => void> {
  const { prototype } = await importInteractiveMode();

  // Resolve every original first: a newer pi that renamed one of these methods
  // must fail open (nothing patched) instead of half-silencing startup.
  const originals = PATCHES.map(({ name }) => {
    const original = (prototype as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") {
      throw new Error(`InteractiveMode.${name} missing`);
    }
    return original as AnyFunction;
  });

  const patched = PATCHES.map(({ create }, index) => create(originals[index]));
  PATCHES.forEach(({ name }, index) => {
    (prototype as unknown as Record<string, unknown>)[name] = patched[index];
  });

  return () => {
    PATCHES.forEach(({ name }, index) => {
      const holder = prototype as unknown as Record<string, unknown>;
      if (holder[name] === patched[index]) {
        holder[name] = originals[index];
      }
    });
  };
}

export async function retainPatch(): Promise<() => Promise<void>> {
  const state = getState();
  state.refCount++;

  let cleanup = state.cleanup;
  if (!cleanup) {
    const pending = state.installPromise ?? installPatch();
    state.installPromise = pending;
    try {
      cleanup = await pending;
      state.cleanup ??= cleanup;
    } catch (error) {
      state.refCount--;
      throw error;
    } finally {
      if (state.installPromise === pending) state.installPromise = undefined;
    }
  }

  let released = false;
  return async () => {
    if (released) return;
    state.refCount = Math.max(0, state.refCount - 1);
    released = true;
    if (state.refCount > 0) return;

    const currentCleanup = state.cleanup;
    state.cleanup = undefined;
    state.release = undefined;
    currentCleanup?.();
  };
}

function isStaleCtxError(error: unknown): boolean {
  return /stale after session replacement|extension ctx is stale/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // Never throw from session_start — pi paints a red stack into the chat
    // for every failed extension handler, including "ctx is stale after
    // session replacement" races during rebind/init.
    try {
      if (ctx.mode !== "tui") return;

      const state = getState();
      // Patches are process-global. Keep across resume; only reinstall when missing.
      if (state.cleanup && state.release) return;

      state.release = await retainPatch();
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

  pi.on("session_shutdown", async (event) => {
    if (
      (event.reason === "reload" || event.reason === "quit") &&
      getState().release
    ) {
      try {
        await getState().release?.();
      } catch {
        /* ignore */
      }
    }
  });
}
