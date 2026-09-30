import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import {
  createPatchedShowLoadedResources,
  createPatchedShowWarning,
  dropExtensionWarnings,
  dropWarningDiagnostics,
  filterSkillCollisionDiagnostics,
  isSilencedStartupWarning,
} from "./extensions/quiet-diagnostics.ts";

const skillCollision = {
  type: "collision",
  message: "name collision",
  collision: { resourceType: "skill", name: "brainstorming" },
};
const promptCollision = {
  type: "collision",
  message: "prompt collision",
  collision: { resourceType: "prompt", name: "review" },
};
const warning = {
  type: "warning",
  message: "skill path does not exist",
};

describe("filterSkillCollisionDiagnostics", () => {
  it("removes only skill collision diagnostics without mutating the source", () => {
    const source = {
      skills: [{ name: "brainstorming" }],
      diagnostics: [skillCollision, promptCollision, warning],
    };

    const filtered = filterSkillCollisionDiagnostics(source);

    assert.deepEqual(filtered.diagnostics, [promptCollision, warning]);
    assert.deepEqual(source.diagnostics, [skillCollision, promptCollision, warning]);
    assert.strictEqual(filtered.skills, source.skills);
  });

  it("returns the original object when no skill collision exists", () => {
    const source = { skills: [], diagnostics: [warning] };
    assert.strictEqual(filterSkillCollisionDiagnostics(source), source);
  });
});

describe("dropWarningDiagnostics", () => {
  it("keeps errors and drops advisory extension warnings", () => {
    const error = { type: "error", message: "Failed to load extension" };
    const shortcutConflict = { type: "warning", message: "shortcut conflict" };

    assert.deepEqual(dropWarningDiagnostics([error, shortcutConflict]), [error]);
  });

  it("returns the original array when nothing is a warning", () => {
    const diagnostics = [{ type: "error", message: "boom" }];
    assert.strictEqual(dropWarningDiagnostics(diagnostics), diagnostics);
  });
});

describe("dropExtensionWarnings", () => {
  it("drops extension package warnings and keeps errors and extensions", () => {
    const extensions = [{ path: "ext-a" }];
    const errors = [{ path: "ext-b", error: "Failed to load extension" }];
    const source = {
      extensions,
      errors,
      warnings: [
        {
          path: "/pkg/package.json",
          warning: "Host-provided extension packages must be declared in peerDependencies",
        },
      ],
    };

    const filtered = dropExtensionWarnings(source);

    assert.deepEqual(filtered.warnings, []);
    assert.strictEqual(filtered.extensions, extensions);
    assert.strictEqual(filtered.errors, errors);
    assert.equal(source.warnings.length, 1);
  });

  it("returns the original result when there are no warnings", () => {
    const source = { extensions: [], errors: [] };
    assert.strictEqual(dropExtensionWarnings(source), source);
  });
});

describe("isSilencedStartupWarning", () => {
  it("matches replayed extension warnings only", () => {
    assert.equal(
      isSilencedStartupWarning(
        'Extension package "/pkg/package.json": Host-provided extension packages must be declared in peerDependencies',
      ),
      true,
    );
    assert.equal(
      isSilencedStartupWarning('Extension package "/pkg/package.json": something else advisory'),
      true,
    );
    assert.equal(
      isSilencedStartupWarning('Failed to load extension "ext"'),
      false,
    );
    assert.equal(isSilencedStartupWarning("tmux keyboard setup may be slow"), false);
  });

  it("tolerates a leading Warning: prefix and non-string input", () => {
    assert.equal(
      isSilencedStartupWarning('Warning: Extension package "/pkg/package.json": noisy'),
      true,
    );
    assert.equal(isSilencedStartupWarning("Model fallback in use"), false);
    assert.equal(isSilencedStartupWarning(undefined), false);
  });

  it("swallows silenced warnings and forwards everything else", () => {
    const shown = [];
    const patched = createPatchedShowWarning(function (message) {
      shown.push(message);
      return "shown";
    });

    const self = { name: "interactive" };
    assert.equal(
      patched.call(self, 'Extension package "/pkg/package.json": noisy'),
      undefined,
    );
    assert.equal(patched.call(self, "Model fallback in use"), "shown");
    assert.deepEqual(shown, ["Model fallback in use"]);
  });
});

describe("createPatchedShowLoadedResources", () => {
  function makeInstance() {
    const skillsResult = { skills: [], diagnostics: [skillCollision, warning] };    const extensionsResult = {
      extensions: [{ path: "ext-a" }],
      errors: [{ path: "ext-b", error: "Failed to load extension" }],
      warnings: [{ path: "/pkg/package.json", warning: "Host-provided extension packages..." }],
    };
    const commandDiagnostics = [{ type: "warning", message: "command conflict" }];
    const shortcutDiagnostics = [{ type: "warning", message: "shortcut conflict" }];
    const builtInConflicts = [
      { type: "warning", message: "Extension command '/review' conflicts with built-in command" },
    ];

    // Like pi: the built-in conflict helper lives on the prototype, so the
    // temporary override must be deleted rather than restored.
    const builtInConflictPrototype = {
      getBuiltInCommandConflictDiagnostics() {
        return builtInConflicts;
      },
    };

    const loader = {
      getSkills: () => skillsResult,
      getExtensions: () => extensionsResult,
    };
    const runner = {
      getCommandDiagnostics: () => commandDiagnostics,
      getShortcutDiagnostics: () => shortcutDiagnostics,
    };
    const instance = Object.create(builtInConflictPrototype);
    instance.session = { resourceLoader: loader, extensionRunner: runner };

    return { instance, loader, runner, skillsResult, extensionsResult, builtInConflicts };
  }

  it("silences startup noise during rendering and restores every accessor afterwards", () => {
    const { instance, loader, runner, skillsResult, extensionsResult, builtInConflicts } =
      makeInstance();
    const originalAccessors = {
      getSkills: loader.getSkills,
      getExtensions: loader.getExtensions,
    };
    const originalRunner = {
      getCommandDiagnostics: runner.getCommandDiagnostics,
      getShortcutDiagnostics: runner.getShortcutDiagnostics,
    };

    let observed;
    const original = function () {
      observed = {
        skills: this.session.resourceLoader.getSkills().diagnostics,
        extensions: this.session.resourceLoader.getExtensions(),
        commands: this.session.extensionRunner.getCommandDiagnostics(),
        shortcuts: this.session.extensionRunner.getShortcutDiagnostics(),
        builtInConflicts: this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner),
        listing: this.session.resourceLoader.getExtensions().extensions,
      };
      return "rendered";
    };

    const patched = createPatchedShowLoadedResources(original);
    assert.equal(patched.call(instance), "rendered");

    assert.deepEqual(observed.skills, [warning]);
    assert.deepEqual(observed.extensions.warnings, []);
    assert.deepEqual(observed.extensions.errors, extensionsResult.errors);
    assert.deepEqual(observed.listing, extensionsResult.extensions);
    assert.deepEqual(observed.commands, []);
    assert.deepEqual(observed.shortcuts, []);
    assert.deepEqual(observed.builtInConflicts, []);

    // Nothing may leak: the same accessors drive autocomplete and tooling.
    assert.strictEqual(loader.getSkills, originalAccessors.getSkills);
    assert.strictEqual(loader.getExtensions, originalAccessors.getExtensions);
    assert.strictEqual(runner.getCommandDiagnostics, originalRunner.getCommandDiagnostics);
    assert.strictEqual(runner.getShortcutDiagnostics, originalRunner.getShortcutDiagnostics);
    assert.strictEqual(loader.getSkills(), skillsResult);
    assert.strictEqual(loader.getExtensions(), extensionsResult);
    assert.equal(
      Object.prototype.hasOwnProperty.call(instance, "getBuiltInCommandConflictDiagnostics"),
      false,
    );
    assert.deepEqual(instance.getBuiltInCommandConflictDiagnostics(runner), builtInConflicts);
  });

  it("restores accessors when native rendering throws", () => {
    const { instance, loader } = makeInstance();
    const originalGetSkills = loader.getSkills;
    const patched = createPatchedShowLoadedResources(function () {
      throw new Error("render failed");
    });

    assert.throws(() => patched.call(instance), /render failed/);
    assert.strictEqual(loader.getSkills, originalGetSkills);
  });

  it("calls the native renderer untouched without a resource loader", () => {
    let called = false;
    const patched = createPatchedShowLoadedResources(function () {
      called = true;
      return "rendered";
    });

    assert.equal(patched.call({}), "rendered");
    assert.equal(called, true);
  });
});

function resolvePiPackageRoot() {
  const piBin = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
  let dir = dirname(realpathSync(piBin));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("pi package root not found from " + piBin);
    }
    dir = parent;
  }
}

async function loadPiInternals() {
  const root = resolvePiPackageRoot();
  const codingAgent = await import(pathToFileURL(join(root, "dist/index.js")).href);
  const interactive = await import(
    pathToFileURL(join(root, "dist/modes/interactive/interactive-mode.js")).href
  );
  return { codingAgent, InteractiveMode: interactive.InteractiveMode };
}

// Load pi's internals once for the whole file. The patch is process-global and
// never released, so the lifecycle tests share the installed state.
const { codingAgent, InteractiveMode } = await loadPiInternals();

describe("extension lifecycle", () => {
  const extensionPath = join(process.cwd(), "extensions", "quiet-diagnostics.ts");

  async function loadExtension() {
    const loaded = await codingAgent.discoverAndLoadExtensions(
      [extensionPath],
      process.cwd(),
    );
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find(
      (item) => item.resolvedPath === extensionPath,
    );
    assert.ok(extension, "extension should load");
    return extension;
  }

  function notifications() {
    const collected = [];
    return {
      collected,
      ctx: {
        mode: "tui",
        hasUI: true,
        cwd: "/tmp",
        isProjectTrusted: () => true,
        ui: {
          notify(message, level) {
            collected.push({ message, level });
          },
        },
      },
    };
  }

  it("installs the patch at module load, before any session start", async () => {
    const original = {
      showLoadedResources: InteractiveMode.prototype.showLoadedResources,
      showWarning: InteractiveMode.prototype.showWarning,
    };
    // Loading the module runs the default export, which installs synchronously
    // (kicks off an in-flight import resolved against pi's already-loaded
    // module) — the very next session_start must find it installed.
    const extension = await loadExtension();
    const starts = extension.handlers.get("session_start") ?? [];
    assert.equal(starts.length, 1);

    const { collected, ctx } = notifications();
    await starts[0]({ type: "session_start", reason: "startup" }, ctx);

    assert.notStrictEqual(InteractiveMode.prototype.showWarning, original);
    assert.notStrictEqual(InteractiveMode.prototype.showLoadedResources, original.showLoadedResources);
    // No error notifications for a healthy install.
    assert.deepEqual(collected.filter((n) => n.level === "warning"), []);
  });

  it("keeps the patch installed across session switches and reloads", async () => {
    const extension = await loadExtension();
    const starts = extension.handlers.get("session_start") ?? [];
    // No shutdown handler anymore: the patch is intentionally never released.
    assert.equal((extension.handlers.get("session_shutdown") ?? []).length, 0);

    const before = InteractiveMode.prototype.showWarning;
    const { collected, ctx } = notifications();
    for (const reason of ["startup", "resume", "new", "fork", "reload"]) {
      await starts[0]({ type: "session_start", reason }, ctx);
    }
    // Same function object across every switch — never re-wrapped, never removed.
    assert.strictEqual(InteractiveMode.prototype.showWarning, before);
    assert.deepEqual(collected.filter((n) => n.level === "warning"), []);
  });

  it("does not double-wrap when the module is evaluated again (reload)", async () => {
    const before = InteractiveMode.prototype.showWarning;
    const extension = await loadExtension(); // second discoverAndLoadExtensions
    const starts = extension.handlers.get("session_start") ?? [];
    const { ctx } = notifications();
    await starts[0]({ type: "session_start", reason: "reload" }, ctx);
    assert.strictEqual(
      InteractiveMode.prototype.showWarning,
      before,
      "reload must not stack a second wrapper",
    );
  });

  it("exposes a /quiet-diagnostics self-check command", async () => {
    const extension = await loadExtension();
    const command = extension.commands.get("quiet-diagnostics");
    assert.ok(command, "command should be registered");
    const { collected, ctx } = notifications();
    await command.handler("", ctx);
    const info = collected.find((n) => n.message.includes("quiet-diagnostics"));
    assert.ok(info, "command should report state");
    assert.match(info.message, /active/i);
  });
});
