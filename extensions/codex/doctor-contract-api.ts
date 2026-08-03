import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
/**
 * Doctor contract hooks for Codex plugin config migrations and session-route
 * ownership warnings.
 */
import {
  collectAuthoredProviderRequestParams,
  collectEffectiveConfiguredModelRoutes,
  resolveModelRuntimePolicy,
} from "openclaw/plugin-sdk/runtime-doctor";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";
import { detectWindowsSpawnCommandInlineArgs } from "openclaw/plugin-sdk/windows-spawn";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasRetiredDynamicToolsProfile(value: unknown): boolean {
  return Object.hasOwn(asRecord(value) ?? {}, "codexDynamicToolsProfile");
}

function hasLegacyPluginDestructivePolicy(value: unknown): boolean {
  const codexPlugins = asRecord(value);
  if (!codexPlugins) {
    return false;
  }
  if (codexPlugins.allow_destructive_actions === "on-request") {
    return true;
  }
  const plugins = asRecord(codexPlugins.plugins);
  return Object.values(plugins ?? {}).some(
    (plugin) => asRecord(plugin)?.allow_destructive_actions === "on-request",
  );
}

function hasRetiredOnFailureApprovalPolicy(value: unknown): boolean {
  return asRecord(value)?.approvalPolicy === "on-failure";
}

type CodexConfigWarning = {
  path: string;
  message: string;
  fixHint?: string;
};

function collectAuthoredRequestParamWarnings(cfg: OpenClawConfig): CodexConfigWarning[] {
  const warnings: CodexConfigWarning[] = [];
  const seen = new Set<string>();
  for (const route of collectEffectiveConfiguredModelRoutes({ cfg }).routes) {
    const runtimeId = resolveModelRuntimePolicy({
      config: cfg,
      provider: route.provider,
      modelId: route.modelId,
      agentId: route.agentId,
    }).policy?.id;
    if (
      route.provider.trim().toLowerCase() !== "openai" ||
      runtimeId?.trim().toLowerCase() !== "codex"
    ) {
      continue;
    }
    for (const requestParam of collectAuthoredProviderRequestParams({
      config: cfg,
      provider: route.provider,
      modelId: route.modelId,
      agentId: route.agentId,
    })) {
      if (seen.has(requestParam.path)) {
        continue;
      }
      seen.add(requestParam.path);
      warnings.push({
        path: requestParam.path,
        message:
          `Explicit native Codex route ${route.path} cannot reproduce authored request parameter ` +
          `"${requestParam.key}" for ${route.provider}/${route.modelId}.`,
        fixHint:
          'Remove this parameter or set the affected route\'s agentRuntime.id to "openclaw". ' +
          "Keep model-scoped params.fastMode when native priority mode is intended.",
      });
    }
  }
  return warnings;
}

function collectCustomCommandWarning(cfg: OpenClawConfig): CodexConfigWarning[] {
  const pluginConfig = asRecord(asRecord(cfg.plugins?.entries?.codex)?.config);
  const appServer = asRecord(pluginConfig?.appServer);
  const command = typeof appServer?.command === "string" ? appServer.command.trim() : "";
  if (!command) {
    return [];
  }
  const inlineArgs = detectWindowsSpawnCommandInlineArgs(command);
  return [
    {
      path: "plugins.entries.codex.config.appServer.command",
      message:
        `Custom Codex app-server command bypasses the managed ${CODEX_APP_SERVER_VERSION} binary. ` +
        "Doctor did not execute the configured command or determine its version.",
      fixHint:
        (inlineArgs
          ? `Set command to only "${inlineArgs.executable}" and move "${inlineArgs.arguments}" to appServer.args; then remove`
          : "Remove") +
        ` the command override to use managed Codex ${CODEX_APP_SERVER_VERSION}, ` +
        `or explicitly verify and update the custom binary to exactly ${CODEX_APP_SERVER_VERSION}.`,
    },
  ];
}

/** Static Codex compatibility warnings for explicit diagnostic surfaces. */
export function collectConfigWarnings({ cfg }: { cfg: OpenClawConfig }): CodexConfigWarning[] {
  return [...collectAuthoredRequestParamWarnings(cfg), ...collectCustomCommandWarning(cfg)];
}

/** Legacy Codex config keys that doctor should report or repair. */
export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "codex", "config"],
    message:
      'plugins.entries.codex.config.codexDynamicToolsProfile is retired; Codex app-server always keeps Codex-native workspace tools native. Run "openclaw doctor --fix".',
    match: hasRetiredDynamicToolsProfile,
  },
  {
    path: ["plugins", "entries", "codex", "config", "codexPlugins"],
    message:
      'plugins.entries.codex.config.codexPlugins.allow_destructive_actions="on-request" was renamed to "auto". Run "openclaw doctor --fix".',
    match: hasLegacyPluginDestructivePolicy,
  },
  {
    path: ["plugins", "entries", "codex", "config", "appServer"],
    message:
      'plugins.entries.codex.config.appServer.approvalPolicy="on-failure" was retired by Codex 0.143; use "on-request". Run "openclaw doctor --fix".',
    match: hasRetiredOnFailureApprovalPolicy,
  },
];

/**
 * Removes retired Codex plugin config keys while preserving unrelated config.
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const rawEntry = asRecord(cfg.plugins?.entries?.codex);
  const rawPluginConfig = asRecord(rawEntry?.config);
  const rawCodexPlugins = asRecord(rawPluginConfig?.codexPlugins);
  const rawAppServer = asRecord(rawPluginConfig?.appServer);
  const shouldRemoveDynamicToolsProfile =
    rawPluginConfig !== null && hasRetiredDynamicToolsProfile(rawPluginConfig);
  const shouldRewriteDestructivePolicy = hasLegacyPluginDestructivePolicy(rawCodexPlugins);
  const shouldRewriteApprovalPolicy = hasRetiredOnFailureApprovalPolicy(rawAppServer);
  if (
    !rawPluginConfig ||
    (!shouldRemoveDynamicToolsProfile &&
      !shouldRewriteDestructivePolicy &&
      !shouldRewriteApprovalPolicy)
  ) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg) as OpenClawConfig & {
    plugins?: Record<string, unknown>;
  };
  const nextPlugins = asRecord(nextConfig.plugins);
  const nextEntries = asRecord(nextPlugins?.entries);
  const nextEntry = asRecord(nextEntries?.codex);
  const nextPluginConfig = asRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  if (shouldRemoveDynamicToolsProfile) {
    delete nextPluginConfig.codexDynamicToolsProfile;
    changes.push(
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    );
  }

  if (shouldRewriteDestructivePolicy) {
    const nextCodexPlugins = asRecord(nextPluginConfig.codexPlugins);
    if (nextCodexPlugins?.allow_destructive_actions === "on-request") {
      nextCodexPlugins.allow_destructive_actions = "auto";
    }
    const nextPluginPolicies = asRecord(nextCodexPlugins?.plugins);
    for (const plugin of Object.values(nextPluginPolicies ?? {})) {
      const nextPlugin = asRecord(plugin);
      if (nextPlugin?.allow_destructive_actions === "on-request") {
        nextPlugin.allow_destructive_actions = "auto";
      }
    }
    changes.push(
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    );
  }

  if (shouldRewriteApprovalPolicy) {
    const nextAppServer = asRecord(nextPluginConfig.appServer);
    if (nextAppServer?.approvalPolicy === "on-failure") {
      nextAppServer.approvalPolicy = "on-request";
    }
    changes.push(
      'Renamed plugins.entries.codex.config.appServer.approvalPolicy="on-failure" to "on-request".',
    );
  }

  return {
    config: nextConfig,
    changes,
  };
}

/** Session/auth ownership metadata used by doctor route-state checks. */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "codex",
    label: "Codex",
    providerIds: ["codex", "codex-cli", "openai-codex"],
    runtimeIds: ["codex", "codex-cli"],
    cliSessionKeys: ["codex-cli"],
    authProfilePrefixes: ["codex:", "codex-cli:", "openai-codex:"],
  },
];

export { stateMigrations } from "./src/migration/session-binding-sidecars.js";
