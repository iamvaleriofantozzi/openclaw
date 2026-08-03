import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { modelKey } from "../shared/model-key.js";
import { listAgentEntriesWithSource, resolveAgentConfig } from "./agent-scope-config.js";

type ModelExtraParamSources = {
  defaultParams?: Record<string, unknown>;
  modelParams?: Record<string, unknown>;
  agentParams?: Record<string, unknown>;
};

export type AuthoredProviderRequestParam = {
  key: string;
  path: string;
  value: unknown;
};

const FAST_MODE_CUTOFF_MODEL_PARAM_KEYS = new Set([
  "fastAutoOnSeconds",
  "fastSeconds",
  "fast_auto_on_seconds",
  "fast_seconds",
]);

// Native harnesses receive recognized values as typed run controls. Other value
// shapes with the same keys remain authored provider request parameters.
function isAgentRuntimeModelParam(key: string, value: unknown): boolean {
  if (key === "thinking") {
    return (
      value === false ||
      value === "disabled" ||
      value === "none" ||
      (typeof value === "string" && normalizeThinkLevel(value) !== undefined)
    );
  }
  if (key === "fastMode" || key === "fast_mode") {
    return normalizeFastMode(value) !== undefined;
  }
  return (
    FAST_MODE_CUTOFF_MODEL_PARAM_KEYS.has(key) &&
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0
  );
}

function legacyModelKey(provider: string, modelId: string): string | undefined {
  const rawKey = `${provider.trim()}/${modelId.trim()}`;
  const canonicalKey = modelKey(provider, modelId);
  return rawKey === canonicalKey ? undefined : rawKey;
}

function resolveModelParamsSource(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
}): { params: Record<string, unknown>; path: string } | undefined {
  const configuredModels = params.config?.agents?.defaults?.models;
  const canonicalKey = params.modelId ? modelKey(params.provider, params.modelId) : undefined;
  const legacyKey = params.modelId ? legacyModelKey(params.provider, params.modelId) : undefined;
  const matchedKey =
    canonicalKey && configuredModels?.[canonicalKey]?.params
      ? canonicalKey
      : legacyKey && configuredModels?.[legacyKey]?.params
        ? legacyKey
        : undefined;
  const matchedParams = matchedKey ? configuredModels?.[matchedKey]?.params : undefined;
  return matchedKey && matchedParams
    ? { params: matchedParams, path: `agents.defaults.models.${matchedKey}.params` }
    : undefined;
}

function resolveAgentParamsSource(params: {
  config?: OpenClawConfig;
  agentId?: string;
}): { params: Record<string, unknown>; path: string } | undefined {
  if (!params.config || !params.agentId) {
    return undefined;
  }
  const resolved = resolveAgentConfig(params.config, params.agentId)?.params;
  if (!resolved) {
    return undefined;
  }
  const listed = listAgentEntriesWithSource(params.config).find(
    ({ entry }) => normalizeAgentId(entry.id) === normalizeAgentId(params.agentId ?? ""),
  );
  if (!listed) {
    return undefined;
  }
  const prefix =
    listed.source.kind === "entries"
      ? `agents.entries.${listed.source.key}`
      : `agents.list.${listed.source.index}`;
  return { params: resolved, path: `${prefix}.params` };
}

/** Resolves the config records merged into one model request. */
export function resolveModelExtraParamSources(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId?: string;
  agentId?: string;
}): ModelExtraParamSources {
  const defaultParams = params.config?.agents?.defaults?.params;
  const modelParams = resolveModelParamsSource(params)?.params;
  const agentParams = resolveAgentParamsSource(params)?.params;
  return { defaultParams, modelParams, agentParams };
}

/** Returns whether embedded OpenClaw would apply authored provider request parameters. */
export function hasAuthoredProviderRequestParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): boolean {
  return collectAuthoredProviderRequestParams(params).length > 0;
}

/** Lists authored request parameters with the exact config paths that supplied them. */
export function collectAuthoredProviderRequestParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
): AuthoredProviderRequestParam[] {
  const sources: Array<{
    params?: Record<string, unknown>;
    path: string;
    acceptsRuntimeControls: boolean;
  }> = [
    {
      params: params.config?.agents?.defaults?.params,
      path: "agents.defaults.params",
      acceptsRuntimeControls: false,
    },
  ];
  const modelSource = resolveModelParamsSource(params);
  if (modelSource) {
    sources.push({ ...modelSource, acceptsRuntimeControls: true });
  }
  const agentSource = resolveAgentParamsSource(params);
  if (agentSource) {
    sources.push({ ...agentSource, acceptsRuntimeControls: false });
  }
  return sources.flatMap((source) =>
    Object.entries(source.params ?? {}).flatMap(([key, value]) =>
      source.acceptsRuntimeControls && isAgentRuntimeModelParam(key, value)
        ? []
        : [{ key, value, path: `${source.path}.${key}` }],
    ),
  );
}
