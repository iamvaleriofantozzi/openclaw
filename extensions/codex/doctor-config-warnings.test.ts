// Codex doctor config warnings cover static native-route compatibility checks.
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { collectConfigWarnings, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { useAutoCleanupTempDirTracker } from "./src/app-server/test-support.js";

function warningPaths(cfg: OpenClawConfig): string[] {
  return collectConfigWarnings({ cfg }).map((warning) => warning.path);
}

describe("Codex doctor config warnings", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports both issue incompatibilities while preserving model-scoped fastMode", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              params: { fastMode: true, serviceTier: "priority" },
              agentRuntime: { id: "codex" },
            },
            "openai/gpt-5.6-terra": {
              params: { fastMode: true, serviceTier: "priority" },
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
      plugins: {
        entries: {
          codex: {
            config: {
              appServer: {
                command: "/opt/custom/bin/codex",
                serviceTier: "priority",
              },
            },
          },
        },
      },
    };

    const warnings = collectConfigWarnings({ cfg });
    expect(warnings.map((warning) => warning.path)).toEqual([
      "agents.defaults.models.openai/gpt-5.6-sol.params.serviceTier",
      "agents.defaults.models.openai/gpt-5.6-terra.params.serviceTier",
      "plugins.entries.codex.config.appServer.command",
    ]);
    expect(warnings.some((warning) => warning.path.endsWith(".fastMode"))).toBe(false);
    expect(warnings.at(-1)?.message).toContain("managed 0.146.0 binary");
    expect(warnings.at(-1)?.message).toContain("did not execute");
  });

  it("keeps valid model-scoped native run controls warning-free", () => {
    expect(
      warningPaths({
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": {
                params: {
                  fastMode: true,
                  thinking: "high",
                  fastAutoOnSeconds: 30,
                },
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("ignores authored request params on implicit OpenAI routes", () => {
    expect(
      warningPaths({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: {
              "openai/gpt-5.6-sol": { params: { serviceTier: "priority" } },
            },
          },
        },
      }),
    ).toEqual([]);
  });

  it("reports default and fallback route request params once", () => {
    expect(
      warningPaths({
        agents: {
          defaults: {
            params: { serviceTier: "priority" },
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openai/gpt-5.6-sol"],
            },
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
            },
          },
        },
      }),
    ).toEqual(["agents.defaults.params.serviceTier"]);
  });

  it.each([
    {
      name: "keyed agent",
      agents: {
        entries: {
          ops: {
            default: true,
            model: "openai/gpt-5.6-sol",
            params: { serviceTier: "priority" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        },
      },
      path: "agents.entries.ops.params.serviceTier",
    },
    {
      name: "legacy listed agent",
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: "openai/gpt-5.6-sol",
            params: { serviceTier: "priority" },
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      path: "agents.list.0.params.serviceTier",
    },
  ])("reports the exact $name path", ({ agents, path: expectedPath }) => {
    expect(warningPaths({ agents } as OpenClawConfig)).toEqual([expectedPath]);
  });

  it("does not execute a configured custom command", () => {
    const dir = tempDirs.make("openclaw-codex-doctor-");
    const marker = path.join(dir, "executed");
    const command = path.join(dir, "codex");
    fs.writeFileSync(command, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });

    const warnings = collectConfigWarnings({
      cfg: {
        plugins: { entries: { codex: { config: { appServer: { command } } } } },
      },
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.path).toBe("plugins.entries.codex.config.appServer.command");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("preserves inline-command remediation in the plugin-owned warning", () => {
    const command =
      "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
    const warning = collectConfigWarnings({
      cfg: {
        plugins: { entries: { codex: { config: { appServer: { command } } } } },
      },
    })[0];

    expect(warning?.path).toBe("plugins.entries.codex.config.appServer.command");
    expect(warning?.fixHint).toContain('Set command to only "node"');
    expect(warning?.fixHint).toContain("move");
    expect(warning?.fixHint).toContain("to appServer.args");
  });

  it("does not migrate request params or custom command overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              params: { serviceTier: "priority" },
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
      plugins: {
        entries: {
          codex: { config: { appServer: { command: "/opt/custom/bin/codex" } } },
        },
      },
    };

    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  });
});
