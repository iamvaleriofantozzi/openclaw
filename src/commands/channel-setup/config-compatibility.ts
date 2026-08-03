// Applies host-owned compatibility migrations to external channel setup output.
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { resolveOfficialExternalChannelCompatibilityMigration } from "../../plugins/official-external-plugin-catalog.js";
import { LEGACY_CONFIG_MIGRATIONS } from "../doctor/shared/legacy-config-migrations.js";

function resolveCompatibilityMigration(channel: ChannelId) {
  const migrationId = resolveOfficialExternalChannelCompatibilityMigration(channel);
  if (!migrationId) {
    return undefined;
  }
  const migration = LEGACY_CONFIG_MIGRATIONS.find((candidate) => candidate.id === migrationId);
  if (!migration) {
    throw new Error(
      `Official external channel ${channel} references unknown compatibility migration ${migrationId}`,
    );
  }
  return migration;
}

function applyCompatibilityMigration(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
}): OpenClawConfig {
  const migration = resolveCompatibilityMigration(params.channel);
  if (!migration) {
    return params.cfg;
  }

  // Setup plugins may return config that shares nested objects with the previous
  // snapshot. Clone before the migration mutates its narrowly owned channel data.
  const next = structuredClone(params.cfg) as OpenClawConfig;
  migration.apply(next as Record<string, unknown>, []);
  return next;
}

export function normalizeExternalChannelSetupConfig(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
}): OpenClawConfig {
  return applyCompatibilityMigration(params);
}

/** Seeds a fail-closed account shell so plugin-owned auth writers cannot default to wildcard access. */
export function prepareExternalChannelAuthConfig(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
}): OpenClawConfig {
  if (!resolveCompatibilityMigration(params.channel)) {
    return params.cfg;
  }

  const next = structuredClone(params.cfg) as OpenClawConfig;
  const channelId = String(params.channel);
  if (isBlockedObjectKey(channelId) || isBlockedObjectKey(params.accountId)) {
    return applyCompatibilityMigration({ cfg: next, channel: params.channel });
  }
  const channels = (next.channels ??= {}) as Record<string, unknown>;
  const existingChannel = channels[channelId];
  const channelConfig =
    existingChannel && typeof existingChannel === "object"
      ? (existingChannel as Record<string, unknown>)
      : {};
  channels[channelId] = channelConfig;
  if (params.accountId !== "default") {
    const existingAccounts = channelConfig.accounts;
    const accounts =
      existingAccounts && typeof existingAccounts === "object"
        ? (existingAccounts as Record<string, unknown>)
        : {};
    channelConfig.accounts = accounts;
    accounts[params.accountId] ??= {};
  }
  return applyCompatibilityMigration({ cfg: next, channel: params.channel });
}
