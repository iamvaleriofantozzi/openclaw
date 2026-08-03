// Builds diagnostics for Codex plugin config and provider wiring.
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { collectEffectiveConfiguredModelRoutes } from "../agents/configured-model-routes.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveOpenAIImplicitAgentRuntime } from "../agents/openai-routing.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const CODEX_PLUGIN_ID = "codex";
const OPENAI_PROVIDER_ID = "openai";

type ModelRoute = {
  provider: string;
  modelId: string;
};

function codexPluginEntryEnabled(cfg: OpenClawConfig): boolean | undefined {
  for (const [pluginId, entry] of Object.entries(cfg.plugins?.entries ?? {})) {
    if (normalizeLowercaseStringOrEmpty(pluginId) === CODEX_PLUGIN_ID) {
      return entry?.enabled;
    }
  }
  return undefined;
}

function configuredRuntimeNeedsCodex(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  modelId?: string;
  runtimeId?: string;
}): boolean {
  const runtimeId = normalizeOptionalAgentRuntimeId(params.runtimeId);
  if (runtimeId === CODEX_PLUGIN_ID) {
    return true;
  }
  if (!isDefaultAgentRuntimeId(runtimeId)) {
    return false;
  }
  return (
    resolveOpenAIImplicitAgentRuntime({
      provider: OPENAI_PROVIDER_ID,
      modelId: params.modelId,
      config: params.cfg,
      env: params.env,
    }) === CODEX_PLUGIN_ID
  );
}

/** Resolves effective runtime policy for one canonical provider/model route. */
export function configuredModelRouteNeedsCodex(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentId?: string;
  route: ModelRoute;
}): boolean {
  if (normalizeProviderId(params.route.provider) !== OPENAI_PROVIDER_ID) {
    return false;
  }
  const runtime = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: OPENAI_PROVIDER_ID,
    modelId: params.route.modelId,
    agentId: params.agentId,
  }).policy?.id;
  return configuredRuntimeNeedsCodex({
    cfg: params.cfg,
    env: params.env,
    modelId: params.route.modelId,
    runtimeId: runtime,
  });
}

function configuredProviderPoliciesNeedCodex(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  agentIds: string[],
): boolean {
  for (const agentId of agentIds) {
    const genericPolicy = resolveModelRuntimePolicy({
      config: cfg,
      provider: OPENAI_PROVIDER_ID,
      agentId,
    }).policy;
    if (
      genericPolicy?.id?.trim() &&
      configuredRuntimeNeedsCodex({ cfg, env, runtimeId: genericPolicy.id })
    ) {
      return true;
    }
  }
  for (const [providerId, providerConfig] of Object.entries(cfg.models?.providers ?? {})) {
    if (normalizeProviderId(providerId) !== OPENAI_PROVIDER_ID) {
      continue;
    }
    for (const model of providerConfig.models ?? []) {
      if (!model.agentRuntime?.id?.trim()) {
        continue;
      }
      const parsed = parseModelCatalogRef(model.id);
      const modelId = parsed?.provider === OPENAI_PROVIDER_ID ? parsed.modelId : model.id.trim();
      if (
        modelId &&
        modelId !== "*" &&
        agentIds.some((agentId) =>
          configuredModelRouteNeedsCodex({
            cfg,
            env,
            agentId,
            route: { provider: OPENAI_PROVIDER_ID, modelId },
          }),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function configuredModelRefsNeedCodex(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): { complete: boolean; needsCodex: boolean } {
  const configured = collectEffectiveConfiguredModelRoutes({
    cfg: params.cfg,
    sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
  });
  return {
    complete: configured.complete,
    needsCodex: configured.routes.some((route) =>
      configuredModelRouteNeedsCodex({
        cfg: params.cfg,
        env: params.env,
        agentId: route.agentId,
        route,
      }),
    ),
  };
}

function defaultOpenAiRouteNeedsCodex(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  agentIds: string[],
): boolean {
  return agentIds.some((agentId) => {
    const runtimeId = resolveModelRuntimePolicy({
      config: cfg,
      provider: OPENAI_PROVIDER_ID,
      agentId,
    }).policy?.id;
    return configuredRuntimeNeedsCodex({ cfg, env, runtimeId });
  });
}

function configNeedsCodexForOpenAi(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  sourceConfigBeforeMigrations?: OpenClawConfig,
): boolean {
  const agentIds = listAgentIds(cfg);
  const configuredRefs = configuredModelRefsNeedCodex({
    cfg,
    env,
    sourceConfigBeforeMigrations,
  });
  if (configuredRefs.needsCodex) {
    return true;
  }
  if (configuredProviderPoliciesNeedCodex(cfg, env, agentIds)) {
    return true;
  }
  return configuredRefs.complete ? false : defaultOpenAiRouteNeedsCodex(cfg, env, agentIds);
}

/** Suppresses missing Codex diagnostics when no effective OpenAI route selects it. */
export function shouldSuppressMissingCodexPluginDiagnostics(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  sourceConfigBeforeMigrations?: OpenClawConfig,
): boolean {
  const entryEnabled = codexPluginEntryEnabled(cfg);
  if (entryEnabled === true) {
    return false;
  }
  // A disabled entry is an explicit opt-out; doctor reports selected-route conflicts.
  return (
    entryEnabled === false || !configNeedsCodexForOpenAi(cfg, env, sourceConfigBeforeMigrations)
  );
}
