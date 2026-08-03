// Resolves effective configured model references for each agent scope.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentEffectiveModelPrimary,
  resolveAgentModelFallbacksOverride,
  resolveEffectiveModelFallbacks,
} from "./agent-scope.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "./model-selection-config.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-shared.js";

export type EffectiveConfiguredModelRoute = {
  agentId: string;
  path: string;
  provider: string;
  modelId: string;
};

function resolveEffectiveSelectedModelRefs(params: { cfg: OpenClawConfig; agentId: string }): {
  complete: boolean;
  values: ReadonlySet<string>;
} {
  const { cfg, agentId } = params;
  const mainPrimaryRaw = resolveAgentEffectiveModelPrimary(cfg, agentId);
  const mainFallbacks =
    resolveAgentModelFallbacksOverride(cfg, agentId) ??
    resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const subagentPrimaryRaw =
    resolveSubagentConfiguredModelSelection({ cfg, agentId }) ?? mainPrimaryRaw;
  const subagentFallbacks =
    resolveEffectiveModelFallbacks({
      cfg,
      agentId,
      sessionKey: `agent:${agentId}:subagent:configured-model-route`,
      hasSessionModelOverride: true,
      modelOverrideSource: "auto",
    }) ?? [];
  const values = new Set<string>();
  for (const raw of [mainPrimaryRaw, ...mainFallbacks, subagentPrimaryRaw, ...subagentFallbacks]) {
    const value = raw?.trim();
    if (value) {
      values.add(value);
    }
  }
  return {
    complete: Boolean(mainPrimaryRaw?.trim() && subagentPrimaryRaw?.trim()),
    values,
  };
}

function configuredRefTargetsAgent(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  path: string;
  agentId: string;
}): boolean {
  const match = /^agents\.list\.(\d+)\./.exec(params.path);
  if (match) {
    const entry = (params.sourceConfigBeforeMigrations ?? params.cfg).agents?.list?.[
      Number(match[1])
    ];
    return Boolean(entry && normalizeAgentId(entry.id) === params.agentId);
  }
  const keyedMatch = /^agents\.entries\.([^.]+)\./.exec(params.path);
  return !keyedMatch || normalizeAgentId(keyedMatch[1] ?? "") === params.agentId;
}

function configuredRefIsEffectiveForAgent(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  path: string;
  value: string;
  agentId: string;
  selectedModelRefs: ReadonlySet<string>;
}): boolean {
  if (!configuredRefTargetsAgent(params)) {
    return false;
  }
  // Defaults may be shadowed by per-agent main/subagent selections. Keep only
  // refs the runtime's inheritance rules leave reachable for this agent.
  if (/^agents\.(?:defaults|list\.\d+)\.(?:model|subagents\.model)(?:\.|$)/.test(params.path)) {
    return params.selectedModelRefs.has(params.value);
  }
  const agent = resolveAgentConfig(params.cfg, params.agentId);
  if (params.path.endsWith(".heartbeat.model")) {
    const heartbeat =
      agent?.heartbeat?.model?.trim() || params.cfg.agents?.defaults?.heartbeat?.model?.trim();
    return heartbeat === params.value;
  }
  if (params.path.endsWith(".utilityModel")) {
    const utilityModel = (agent?.utilityModel ?? params.cfg.agents?.defaults?.utilityModel)?.trim();
    return utilityModel === params.value;
  }
  return true;
}

/** Lists configured model routes that remain reachable in each effective agent scope. */
export function collectEffectiveConfiguredModelRoutes(params: {
  cfg: OpenClawConfig;
  sourceConfigBeforeMigrations?: OpenClawConfig;
}): { complete: boolean; routes: EffectiveConfiguredModelRoute[] } {
  const refs = collectConfiguredModelRefs(params.sourceConfigBeforeMigrations ?? params.cfg);
  const routes: EffectiveConfiguredModelRoute[] = [];
  let complete = true;
  for (const agentId of listAgentIds(params.cfg)) {
    const selected = resolveEffectiveSelectedModelRefs({ cfg: params.cfg, agentId });
    complete &&= selected.complete;
    const primary = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId,
      manifestPlugins: [],
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      agentId,
      defaultProvider: primary.provider,
      manifestPlugins: [],
    });
    for (const ref of refs) {
      if (
        !configuredRefIsEffectiveForAgent({
          cfg: params.cfg,
          sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
          path: ref.path,
          value: ref.value,
          agentId,
          selectedModelRefs: selected.values,
        })
      ) {
        continue;
      }
      const resolved = resolveModelRefFromString({
        cfg: params.cfg,
        raw: ref.value,
        defaultProvider: primary.provider,
        aliasIndex,
        allowManifestNormalization: false,
      });
      if (resolved) {
        routes.push({
          agentId,
          path: ref.path,
          provider: resolved.ref.provider,
          modelId: resolved.ref.model,
        });
      }
    }
  }
  return { complete, routes };
}
