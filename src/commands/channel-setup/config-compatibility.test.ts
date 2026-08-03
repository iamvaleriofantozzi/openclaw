import { describe, expect, it } from "vitest";
import {
  normalizeExternalChannelSetupConfig,
  prepareExternalChannelAuthConfig,
} from "./config-compatibility.js";

describe("normalizeExternalChannelSetupConfig", () => {
  it("normalizes Tencent 2.0 setup defaults through the host compatibility migration", () => {
    const previous = {
      channels: {
        qqbot: {
          appId: "app-id",
          clientSecret: "secret",
          allowFrom: ["*"],
        },
      },
    };

    const next = normalizeExternalChannelSetupConfig({ cfg: previous, channel: "qqbot" });

    expect(next).toMatchObject({
      channels: {
        qqbot: {
          appId: "app-id",
          clientSecret: "secret",
          dmPolicy: "open",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
    expect(previous.channels.qqbot).toEqual({
      appId: "app-id",
      clientSecret: "secret",
      allowFrom: ["*"],
    });
  });

  it("leaves channels without a host compatibility migration unchanged", () => {
    const cfg = { channels: { telegram: { enabled: true } } };

    expect(normalizeExternalChannelSetupConfig({ cfg, channel: "telegram" })).toBe(cfg);
  });

  it("prepares a safe default-account shell before external QQBot login", () => {
    const cfg = {};

    expect(
      prepareExternalChannelAuthConfig({ cfg, channel: "qqbot", accountId: "default" }),
    ).toMatchObject({
      channels: {
        qqbot: {
          dmPolicy: "open",
          allowFrom: ["openclaw:approval-disabled"],
        },
      },
    });
    expect(cfg).toEqual({});
  });

  it("prepares a safe named-account shell before external QQBot login", () => {
    const cfg = {};

    expect(
      prepareExternalChannelAuthConfig({ cfg, channel: "qqbot", accountId: "ops" }),
    ).toMatchObject({
      channels: {
        qqbot: {
          allowFrom: ["openclaw:approval-disabled"],
          accounts: {
            ops: { allowFrom: ["openclaw:approval-disabled"] },
          },
        },
      },
    });
    expect(cfg).toEqual({});
  });

  it("leaves auth config untouched without a compatibility migration", () => {
    const cfg = { channels: { telegram: {} } };

    expect(
      prepareExternalChannelAuthConfig({ cfg, channel: "telegram", accountId: "default" }),
    ).toBe(cfg);
  });
});
