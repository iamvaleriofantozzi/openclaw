/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  CUSTODIAN_QR_DATA_URL as QR_DATA_URL,
  createContext,
  createCustodianQrPresentation as qrPresentation,
  mountPage,
} from "./custodian-page.test-harness.ts";

function gatewayClient(
  request: ReturnType<typeof vi.fn>,
  authenticatedDeviceId: string | null = "stable-control-ui-device",
): GatewayBrowserClient {
  return { request, authenticatedDeviceId } as unknown as GatewayBrowserClient;
}

describe("custodian page connection lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("keeps the live session across a device-token rotation and client replacement", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [{ role: "assistant", text: "Earlier state", at: 1 }] };
      }
      if (method === "openclaw.chat") {
        chatCalls += 1;
        return {
          sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
          reply: chatCalls === 1 ? "Live welcome" : "Fresh session welcome",
          action: "none",
          ...(chatCalls === 1
            ? {
                presentation: qrPresentation(),
              }
            : {}),
        };
      }
      throw new Error(`unexpected request ${method}`);
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    setGatewaySnapshot({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "old-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 60_000, processInstanceId: "gateway-process-1" },
      },
    });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());
    setGatewaySnapshot({
      client: gatewayClient(request),
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "rotated-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });
    await page.updateComplete;

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(page.querySelector(".custodian__qr-code")).not.toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl === QR_DATA_URL)).toBe(true);
    expect(page.textContent).toContain("Earlier state");
    expect(page.textContent).toContain("Live welcome");
  });

  it("resumes interrupted initialization after a two-phase client replacement", async () => {
    let resolveOriginalWelcome!: (value: SystemAgentChatResult) => void;
    const originalWelcome = new Promise<SystemAgentChatResult>((resolve) => {
      resolveOriginalWelcome = resolve;
    });
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [] };
      }
      chatCalls += 1;
      return chatCalls === 1
        ? await originalWelcome
        : { sessionId: "resumed-session", reply: "Resumed welcome", action: "none" as const };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    setGatewaySnapshot({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 60_000, processInstanceId: "gateway-process-1" },
      },
    });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      client: gatewayClient(request),
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Resumed welcome"));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[2]?.[1]).toEqual(request.mock.calls[1]?.[1]);
    expect(page.store.sending).toBe(false);
    expect(page.querySelector('[role="alert"]')).toBeNull();

    resolveOriginalWelcome({
      sessionId: "stale-session",
      reply: "Stale welcome",
      action: "none",
    });
    await page.updateComplete;
    expect(page.textContent).not.toContain("Stale welcome");
  });

  it("starts fresh when a same-owner replacement abandons a user turn", async () => {
    let resolveLostTurn!: (value: SystemAgentChatResult) => void;
    const lostTurn = new Promise<SystemAgentChatResult>((resolve) => {
      resolveLostTurn = resolve;
    });
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [] };
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return { sessionId: "live-session", reply: "Welcome", action: "none" as const };
      }
      if (chatCalls === 2) {
        return await lostTurn;
      }
      return { sessionId: "fresh-session", reply: "Fresh welcome", action: "none" as const };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    setGatewaySnapshot({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 60_000, processInstanceId: "gateway-process-1" },
      },
    });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome"));

    const pendingTurn = page.store.send("connect telegram");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      client: gatewayClient(request),
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Fresh welcome"));
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[3]?.[1]).not.toMatchObject({ sessionId: "live-session" });
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("message");

    resolveLostTurn({
      sessionId: "live-session",
      reply: "Scan this unseen code",
      action: "none",
      presentation: qrPresentation(),
    });
    await expect(pendingTurn).resolves.toBe("sent");
    await page.updateComplete;
    expect(page.textContent).not.toContain("Scan this unseen code");
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
  });

  it("starts fresh when a same-owner client reconnects in place after abandoning a user turn", async () => {
    let resolveLostTurn!: (value: SystemAgentChatResult) => void;
    const lostTurn = new Promise<SystemAgentChatResult>((resolve) => {
      resolveLostTurn = resolve;
    });
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [] };
      }
      chatCalls += 1;
      if (chatCalls === 1) {
        return { sessionId: "live-session", reply: "Welcome", action: "none" as const };
      }
      if (chatCalls === 2) {
        return await lostTurn;
      }
      return { sessionId: "fresh-session", reply: "Fresh welcome", action: "none" as const };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    setGatewaySnapshot({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 60_000, processInstanceId: "gateway-process-1" },
      },
    });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome"));
    const sameClient = context.gateway.snapshot.client;

    const pendingTurn = page.store.send("connect telegram");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      client: sameClient,
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Fresh welcome"));
    expect(request.mock.calls[3]?.[1]).not.toMatchObject({ sessionId: "live-session" });
    expect(request.mock.calls[3]?.[1]).not.toHaveProperty("message");
    resolveLostTurn({
      sessionId: "live-session",
      reply: "Scan this unseen code",
      action: "none",
      presentation: qrPresentation(),
    });
    await expect(pendingTurn).resolves.toBe("sent");
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
  });

  it("starts fresh when a connection-bound client is replaced on the same process", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [] };
      }
      chatCalls += 1;
      return {
        sessionId: chatCalls === 1 ? "connection-bound-session" : "replacement-session",
        reply: chatCalls === 1 ? "Connection-bound setup" : "Fresh replacement welcome",
        action: "none",
        ...(chatCalls === 1 ? { presentation: qrPresentation() } : {}),
      };
    });
    const { context, setGatewaySnapshot } = createContext(
      request,
      ["openclaw.chat", "openclaw.chat.history"],
      { authenticatedDeviceId: null },
    );
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    setGatewaySnapshot({
      client: gatewayClient(request, null),
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Fresh replacement welcome"));
    expect(page.textContent).toContain("Connection-bound setup");
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[2]?.[1]).not.toMatchObject({
      sessionId: "connection-bound-session",
    });
  });

  it("starts fresh when a connection-bound client reconnects in place", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [] };
      }
      chatCalls += 1;
      return {
        sessionId: chatCalls === 1 ? "connection-bound-session" : "reconnected-session",
        reply: chatCalls === 1 ? "Connection-bound setup" : "Fresh reconnect welcome",
        action: "none",
        ...(chatCalls === 1 ? { presentation: qrPresentation() } : {}),
      };
    });
    const { context, setGatewaySnapshot } = createContext(
      request,
      ["openclaw.chat", "openclaw.chat.history"],
      { authenticatedDeviceId: null },
    );
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Fresh reconnect welcome"));
    expect(page.textContent).toContain("Connection-bound setup");
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[2]?.[1]).not.toMatchObject({
      sessionId: "connection-bound-session",
    });
  });

  it("starts fresh when a same-profile reconnect authenticates a different user alias", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [] };
      }
      chatCalls += 1;
      return {
        sessionId:
          chatCalls === 1 ? "engine-session-owned-by-alice" : "engine-session-owned-by-bob",
        reply: chatCalls === 1 ? "Alice secret setup" : "Bob fresh welcome",
        action: "none",
        ...(chatCalls === 1 ? { presentation: qrPresentation() } : {}),
      };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    setGatewaySnapshot({ selfUser: { id: "alice-profile", email: "alice@example.com" } });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    setGatewaySnapshot({ phase: "reconnecting", hello: null, selfUser: null });
    setGatewaySnapshot({
      client: gatewayClient(request),
      phase: "connected",
      selfUser: { id: "alice-profile", email: "bob@example.com" },
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-1" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Bob fresh welcome"));
    expect(page.textContent).not.toContain("Alice secret setup");
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[3]?.[1]).not.toMatchObject({
      sessionId: "engine-session-owned-by-alice",
    });
  });

  it("starts fresh when an older gateway cannot prove process identity", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (_method?: string, _params?: unknown) => {
      chatCalls += 1;
      return {
        sessionId:
          chatCalls === 1 ? "engine-session-without-process-id" : "engine-session-after-reconnect",
        reply: chatCalls === 1 ? "Scan this code." : "Fresh welcome after reconnect.",
        action: "none",
        ...(chatCalls === 1
          ? {
              presentation: qrPresentation(),
            }
          : {}),
      };
    });
    const { context, setGatewaySnapshot } = createContext(request);
    setGatewaySnapshot({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat"] },
        snapshot: { uptimeMs: 60_000 },
      },
    });
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat"] },
        snapshot: { uptimeMs: 1_000 },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Fresh welcome after reconnect."));
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[1]?.[1]).not.toMatchObject({
      sessionId: "engine-session-without-process-id",
    });
  });

  it("retires a pending QR and starts fresh after the Gateway process restarts", async () => {
    let chatCalls = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "openclaw.chat.history") {
        return { turns: [{ role: "assistant", text: "Durable earlier state", at: 1 }] };
      }
      chatCalls += 1;
      return {
        sessionId:
          chatCalls === 1 ? "engine-session-before-restart" : "engine-session-after-restart",
        reply: chatCalls === 1 ? "Scan this code." : "Fresh welcome after restart.",
        action: "none",
        ...(chatCalls === 1
          ? {
              presentation: qrPresentation(),
            }
          : {}),
      };
    });
    const { context, setGatewaySnapshot } = createContext(request, [
      "openclaw.chat",
      "openclaw.chat.history",
    ]);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: ["openclaw.chat", "openclaw.chat.history"] },
        snapshot: { uptimeMs: 61_000, processInstanceId: "gateway-process-2" },
      },
    });

    await waitForFast(() => expect(page.textContent).toContain("Fresh welcome after restart."));
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      sessionId: expect.stringMatching(/^control-ui-onboarding-/),
    });
    expect(request.mock.calls[3]?.[1]).not.toMatchObject({
      sessionId: "engine-session-before-restart",
    });
  });

  it("retires a pending QR when a replacement gateway lacks chat support", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "engine-session-before-replacement",
      reply: "Scan this code.",
      action: "none",
      presentation: qrPresentation(),
    });
    const replacementRequest = vi.fn();
    const { context, setGatewaySnapshot } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    setGatewaySnapshot({
      client: gatewayClient(replacementRequest),
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.admin"] },
        features: { methods: [] },
      },
    });
    await waitForFast(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Update the Gateway"),
    );

    expect(request).toHaveBeenCalledOnce();
    expect(replacementRequest).not.toHaveBeenCalled();
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl !== undefined)).toBe(false);
  });

  it("keeps event nudges dismissed across a Gateway restart", async () => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Everything is healthy.",
      action: "none",
    });
    const { context, emitGatewayEvent, setGatewaySnapshot } = createContext(request);
    setGatewaySnapshot({
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat"] },
        snapshot: { uptimeMs: 60_000, processInstanceId: "gateway-process-1" },
      },
    });
    const { page } = await mountPage(context, { onboarding: false });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    emitGatewayEvent({
      event: "health",
      payload: {
        channels: { telegram: { configured: true, running: true, connected: false } },
      },
    });
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__nudge-dismiss")!.click();
    await page.updateComplete;

    setGatewaySnapshot({ phase: "reconnecting", hello: null });
    setGatewaySnapshot({
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 1,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "stable-device-token",
        },
        features: { methods: ["openclaw.chat"] },
        snapshot: { uptimeMs: 1_000, processInstanceId: "gateway-process-2" },
      },
    });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    emitGatewayEvent({
      event: "health",
      payload: { configReload: { hotReloadStatus: "disabled" }, channels: {} },
    });
    await page.updateComplete;
    expect(page.querySelector(".custodian__nudge")).toBeNull();
  });
});
