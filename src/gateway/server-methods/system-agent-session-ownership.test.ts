// System-agent session tests cover caller ownership and response projection.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { SystemAgentChatQuestion } from "../../../packages/gateway-protocol/src/index.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({ verifySetupInference: vi.fn() }));
const delegatedInferenceMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    delegatedInferenceMocks.verifySystemAgentInferenceWithFallback,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
// Ownership tests exercise fresh-session creation; keep the caretaker greeting
// deterministic so identity behavior is the only variable under test.
vi.mock("../../system-agent/greeting.js", () => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  buildSystemAgentGreetingQuestion: vi.fn(() => undefined),
  loadSystemAgentGreetingFacts: vi.fn(() => ({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  })),
  resolveSystemAgentGreeting: vi.fn(async () => ({ text: "welcome text", source: "template" })),
}));

type FakeEngine = {
  supportsQrCode: boolean;
  handle: ReturnType<typeof vi.fn>;
  seedHistory: ReturnType<typeof vi.fn>;
  historyLength: ReturnType<typeof vi.fn>;
  historySince: ReturnType<typeof vi.fn>;
  getPendingOperatorProposal: ReturnType<typeof vi.fn>;
  hasPendingQrCode: ReturnType<typeof vi.fn>;
  resolveOperatorApproval: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  loadOverview: ReturnType<typeof vi.fn>;
  noteAssistantMessage: ReturnType<typeof vi.fn>;
};

const queuedEngineReplies = vi.hoisted(
  () =>
    [] as Array<{
      text: string;
      action: "none";
      qrDataUrl?: string;
      qrExpiresAtMs?: number;
      wizardInputPending?: boolean;
      question?: SystemAgentChatQuestion;
    }>,
);

function makeEngine(supportsQrCode = false): FakeEngine {
  return {
    supportsQrCode,
    handle: vi.fn(
      async () => queuedEngineReplies.shift() ?? { text: "did the thing", action: "none" },
    ),
    seedHistory: vi.fn(),
    historyLength: vi.fn(() => 0),
    historySince: vi.fn(() => []),
    getPendingOperatorProposal: vi.fn(() => null),
    hasPendingQrCode: vi.fn(() => false),
    resolveOperatorApproval: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn(),
  };
}

const createdEngines = vi.hoisted(() => [] as FakeEngine[]);

vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(
    this: FakeEngine,
    options: { supportsQrCode?: boolean },
  ) {
    const engine = makeEngine(options.supportsQrCode === true);
    createdEngines.push(engine);
    Object.assign(this, engine);
  },
}));
vi.mock("../../system-agent/overview.js", () => ({
  formatSystemAgentStartupMessage: vi.fn(() => "welcome text"),
}));

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeClient(params: {
  connId: string;
  deviceId?: string;
  authenticatedUserId?: string;
  supportsQrCode?: boolean;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: "openclaw-control-ui", mode: "webchat" },
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
      caps: params.supportsQrCode ? [GATEWAY_CLIENT_CAPS.SYSTEM_AGENT_QR_CODE] : [],
    },
    ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
  } as GatewayClient;
}

const defaultClient = makeClient({ connId: "conn-test", deviceId: "device-test" });

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(params?: {
  engine?: FakeEngine;
  lastUsedAt?: number;
  ownerKey?: string;
}): SystemAgentChatSession {
  return {
    engine: params?.engine ?? makeEngine(),
    welcome: "welcome text",
    lastUsedAt: params?.lastUsedAt ?? 1,
    ownerKey: params?.ownerKey ?? "device:device-test",
    supportsQrCode: false,
  } as unknown as SystemAgentChatSession;
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = defaultClient,
): Promise<RespondCall> {
  const calls: RespondCall[] = [];
  const respond: RespondFn = (ok, payload, error) => calls.push({ ok, payload, error });
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({
    params,
    client,
    context,
    respond,
  } as never);
  return expectDefined(calls[0], "system-agent response");
}

beforeEach(() => {
  createdEngines.length = 0;
  queuedEngineReplies.length = 0;
  setupInferenceMocks.verifySetupInference.mockResolvedValue({ ok: true, binding: {} });
  delegatedInferenceMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    binding: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});

describe("openclaw.chat session ownership", () => {
  it.each([
    { supportsQrCode: true, includesQrDataUrl: true },
    { supportsQrCode: false, includesQrDataUrl: false },
  ])(
    "projects QR data to capable clients only ($supportsQrCode)",
    async ({ supportsQrCode, includesQrDataUrl }) => {
      const qrDataUrl = "data:image/png;base64,cXItcHJvamVjdGlvbg==";
      queuedEngineReplies.push({
        text: "Scan this code.",
        action: "none",
        qrDataUrl,
        qrExpiresAtMs: 1_800_000,
        wizardInputPending: true,
        question: {
          id: "setup-qr",
          header: "Scan QR code",
          question: "Scan the code, then continue.",
          options: [{ label: "Continue" }],
          allowSkip: false,
        },
      });

      const response = await callChat(
        makeContext(new Map()),
        { sessionId: `qr-projection-${supportsQrCode}`, message: "connect telegram" },
        makeClient({
          connId: `conn-${supportsQrCode}`,
          deviceId: `device-${supportsQrCode}`,
          supportsQrCode,
        }),
      );

      expect(response.ok).toBe(true);
      expect(response.payload).toMatchObject({ reply: "Scan this code." });
      expect(Object.hasOwn(response.payload ?? {}, "presentation")).toBe(includesQrDataUrl);
      if (includesQrDataUrl) {
        expect(response.payload).toMatchObject({
          presentation: {
            kind: "qr",
            dataUrl: qrDataUrl,
            expiresAtMs: 1_800_000,
            wizardInputPending: true,
            question: { allowSkip: false, options: [{ label: "Continue" }] },
          },
        });
        expect(response.payload).not.toHaveProperty("wizardInputPending");
        expect(response.payload).not.toHaveProperty("question");
      } else {
        expect(response.payload).not.toHaveProperty("presentation");
        expect(response.payload).toMatchObject({
          wizardInputPending: true,
          question: { allowSkip: false, options: [{ label: "Continue" }] },
        });
      }
    },
  );

  it("keeps only the newest QR-owning session per owner protected from eviction", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const disposals: Array<ReturnType<typeof vi.spyOn>> = [];
    for (let index = 0; index < 8; index += 1) {
      const session = seededSession({ lastUsedAt: index });
      vi.spyOn(session.engine, "hasPendingQrCode").mockReturnValue(true);
      disposals.push(vi.spyOn(session.engine, "dispose"));
      sessions.set(`qr-${index}`, session);
    }

    const response = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(response.ok).toBe(true);
    expect(sessions.size).toBe(8);
    expect(sessions.has("qr-0")).toBe(false);
    expect(sessions.has("qr-7")).toBe(true);
    expect(sessions.has("new-session")).toBe(true);
    expect(disposals[0]).toHaveBeenCalledOnce();
    for (const dispose of disposals.slice(1)) {
      expect(dispose).not.toHaveBeenCalled();
    }
  });

  it("keeps the session map bounded during concurrent unique initialization", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose").mockImplementation(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }

    const context = makeContext(sessions);
    const first = callChat(context, { sessionId: "new-1" });
    const second = callChat(context, { sessionId: "new-2" });
    await evictionStarted.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    releaseEviction.resolve();
    await Promise.all([first, second]);

    expect(disposeOldest).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect(sessions.has("new-1")).toBe(true);
    expect(sessions.has("new-2")).toBe(true);
  });

  it("keeps one QR-owning session protected for each distinct owner", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const disposals: Array<ReturnType<typeof vi.spyOn>> = [];
    for (let index = 0; index < 8; index += 1) {
      const session = seededSession({ lastUsedAt: index, ownerKey: `device:device-${index}` });
      vi.spyOn(session.engine, "hasPendingQrCode").mockReturnValue(true);
      disposals.push(vi.spyOn(session.engine, "dispose"));
      sessions.set(`qr-${index}`, session);
    }

    const response = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        retryable: true,
      },
    });
    expect(sessions.size).toBe(8);
    expect(sessions.has("new-session")).toBe(false);
    for (const dispose of disposals) {
      expect(dispose).not.toHaveBeenCalled();
    }
  });

  it("replaces the incoming owner's QR session when every owner is protected", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const disposals: Array<ReturnType<typeof vi.spyOn>> = [];
    for (let index = 0; index < 8; index += 1) {
      const session = seededSession({
        lastUsedAt: index,
        ownerKey: index === 3 ? "device:device-test" : `device:device-${index}`,
      });
      vi.spyOn(session.engine, "hasPendingQrCode").mockReturnValue(true);
      disposals.push(vi.spyOn(session.engine, "dispose"));
      sessions.set(`qr-${index}`, session);
    }

    const response = await callChat(makeContext(sessions), { sessionId: "replacement" });

    expect(response.ok).toBe(true);
    expect(sessions.size).toBe(8);
    expect(sessions.has("qr-3")).toBe(false);
    expect(sessions.has("replacement")).toBe(true);
    expect(disposals[3]).toHaveBeenCalledOnce();
    for (const [index, dispose] of disposals.entries()) {
      if (index !== 3) {
        expect(dispose).not.toHaveBeenCalled();
      }
    }
  });

  it("binds a new non-delegated session and rejects another principal", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const owner = makeClient({
      connId: "conn-owner",
      deviceId: "device-owner",
      authenticatedUserId: "owner@example.com",
    });
    const attacker = makeClient({
      connId: "conn-attacker",
      deviceId: "device-attacker",
      authenticatedUserId: "attacker@example.com",
    });

    expect(await callChat(context, { sessionId: "owned-session" }, owner)).toMatchObject({
      ok: true,
    });
    expect(sessions.get("owned-session")?.ownerKey).toBe("user:owner@example.com");
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const turn = await callChat(
      context,
      { sessionId: "owned-session", message: "show status" },
      attacker,
    );
    const approval = await callChat(
      context,
      { sessionId: "owned-session", message: "yes" },
      attacker,
    );
    const reset = await callChat(context, { sessionId: "owned-session", reset: true }, attacker);

    expect(turn).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(approval).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(reset).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(
      expectDefined(createdEngines[0], "created system-agent engine").dispose,
    ).not.toHaveBeenCalled();
  });

  it("lets the same QR-capable authenticated principal resume after reconnecting", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "reconnect" },
      makeClient({
        connId: "conn-old",
        deviceId: "device-old",
        authenticatedUserId: "owner@example.com",
        supportsQrCode: true,
      }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;
    expect(expectDefined(createdEngines[0], "created system-agent engine").supportsQrCode).toBe(
      true,
    );

    const resumed = await callChat(
      context,
      { sessionId: "reconnect", message: "continue" },
      makeClient({
        connId: "conn-new",
        deviceId: "device-new",
        authenticatedUserId: "owner@example.com",
        supportsQrCode: true,
      }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("lets the same paired device resume after reconnecting", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "device-reconnect" },
      makeClient({ connId: "conn-old", deviceId: "device-owner" }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "device-reconnect", message: "continue" },
      makeClient({ connId: "conn-new", deviceId: "device-owner" }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it.each([
    { initial: false, resumed: true },
    { initial: true, resumed: false },
  ])(
    "requires a reset when QR support changes from $initial to $resumed",
    async ({ initial, resumed }) => {
      const sessions = new Map<string, SystemAgentChatSession>();
      const context = makeContext(sessions);
      const owner = {
        deviceId: "device-owner",
        authenticatedUserId: "owner@example.com",
      };
      await callChat(
        context,
        { sessionId: "capability-change" },
        makeClient({ ...owner, connId: "conn-old", supportsQrCode: initial }),
      );
      const original = expectDefined(createdEngines[0], "created system-agent engine");
      expect(original.supportsQrCode).toBe(initial);

      const rejected = await callChat(
        context,
        { sessionId: "capability-change", message: "continue" },
        makeClient({ ...owner, connId: "conn-new", supportsQrCode: resumed }),
      );
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
      expect(original.handle).not.toHaveBeenCalled();

      const reset = await callChat(
        context,
        { sessionId: "capability-change", reset: true },
        makeClient({ ...owner, connId: "conn-new", supportsQrCode: resumed }),
      );
      expect(reset.ok).toBe(true);
      expect(original.dispose).toHaveBeenCalledOnce();
      expect(sessions.get("capability-change")?.supportsQrCode).toBe(resumed);
      expect(expectDefined(createdEngines[1], "reset system-agent engine").supportsQrCode).toBe(
        resumed,
      );
    },
  );

  it("rejects non-delegated chat without a server-authenticated identity", async () => {
    const call = await callChat(makeContext(new Map()), { sessionId: "anonymous" }, null);

    expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("keeps explicit delegation authoritative across connection identities", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const delegation = { agentId: "main", sessionKey: "agent:main:main" };
    await callChat(
      context,
      { sessionId: "delegated", delegation },
      makeClient({ connId: "conn-owner", deviceId: "device-owner" }),
    );
    const handle = expectDefined(createdEngines[0], "created delegated engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "delegated", message: "continue", delegation },
      makeClient({
        connId: "conn-other",
        deviceId: "device-other",
        authenticatedUserId: "other@example.com",
      }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("rejects delegated reuse of a non-delegated session", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["shared", seededSession({ engine })],
    ]);

    const delegated = await callChat(makeContext(sessions), {
      sessionId: "shared",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(delegated).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(engine.handle).not.toHaveBeenCalled();
  });
});

describe("openclaw.chat session responses", () => {
  it("protects another owner's older QR and evicts the oldest eligible session", async () => {
    const qrEngine = makeEngine();
    qrEngine.hasPendingQrCode.mockReturnValue(true);
    const eligibleEngine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["qr-owner", seededSession({ engine: qrEngine, lastUsedAt: 0, ownerKey: "device:qr-owner" })],
      ["eligible", seededSession({ engine: eligibleEngine, lastUsedAt: 1 })],
    ]);
    for (let index = 2; index < 8; index += 1) {
      sessions.set(`newer-${index}`, seededSession({ lastUsedAt: index }));
    }

    const response = await callChat(makeContext(sessions), { sessionId: "new-session" });

    expect(response.ok).toBe(true);
    expect(sessions.size).toBe(8);
    expect(sessions.has("qr-owner")).toBe(true);
    expect(sessions.has("eligible")).toBe(false);
    expect(sessions.has("new-session")).toBe(true);
    expect(qrEngine.dispose).not.toHaveBeenCalled();
    expect(eligibleEngine.dispose).toHaveBeenCalledOnce();
  });

  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: true,
      payload: { sessionId: "s1", reply: "welcome text", action: "none" },
    });
  });

  it("routes messages through the session engine", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(engine.handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("forwards sensitive-input metadata", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "Enter the bot token",
      action: "none",
      sensitive: true,
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({ sensitive: true });
  });

  it("maps the TUI handoff to an open-agent action", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "",
      action: "open-tui",
      handoff: { kind: "open-tui" },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "talk to agent",
    });

    expect(call.payload).toMatchObject({ action: "open-agent" });
    expect(call.payload).not.toHaveProperty("agentDraft");
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("forwards the hatch draft intent with an agent handoff", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "Your agent is hatching.",
      action: "open-tui",
      agentDraft: "hatch",
      handoff: { kind: "open-tui", agentId: "researcher" },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({
      action: "open-agent",
      agentDraft: "hatch",
      agentId: "researcher",
    });
  });
});
