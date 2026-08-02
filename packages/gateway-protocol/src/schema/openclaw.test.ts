import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupVerifyParams,
} from "../index.js";
import {
  type SystemAgentChatQuestion,
  type SystemAgentChatPresentation,
  type SystemAgentChatResult,
  SystemAgentChatParamsSchema,
  SystemAgentChatResultSchema,
  SystemAgentChatQuestionSchema,
  SystemAgentChatHistoryResultSchema,
  SystemAgentSetupDetectResultSchema,
  SystemAgentSetupVerifyResultSchema,
} from "./openclaw.js";

const QR_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const QR_DATA_URL_PREFIX = "data:image/png;base64,";

function qrDataUrlWithLength(length: number): string {
  return `${QR_DATA_URL_PREFIX}${"A".repeat(length - QR_DATA_URL_PREFIX.length)}`;
}

describe("OpenClaw chat params protocol", () => {
  it("keeps presentation capabilities out of the request shape", () => {
    expect(Value.Check(SystemAgentChatParamsSchema, { sessionId: "setup-session" })).toBe(true);
    expect(
      Value.Check(SystemAgentChatParamsSchema, {
        sessionId: "setup-session",
        capabilities: { qrCodePng: true },
      }),
    ).toBe(false);
  });
});

describe("OpenClaw chat params protocol", () => {
  const base = { sessionId: "session-1", message: "What about this page?" };

  it("accepts the additive page context and remains backward compatible", () => {
    expect(validateSystemAgentChatParams(base)).toBe(true);
    expect(validateSystemAgentChatParams({ ...base, context: { page: "channels" } })).toBe(true);
    expect(
      validateSystemAgentChatParams({ ...base, context: { page: "/settings/channels" } }),
    ).toBe(true);
  });

  it("rejects unsafe page ids and unknown context fields", () => {
    expect(validateSystemAgentChatParams({ ...base, context: { page: "channels?tab=all" } })).toBe(
      false,
    );
    expect(validateSystemAgentChatParams({ ...base, context: { page: "a".repeat(65) } })).toBe(
      false,
    );
    expect(
      validateSystemAgentChatParams({
        ...base,
        context: { page: "channels", source: "client" },
      }),
    ).toBe(false);
  });
});

describe("OpenClaw chat question protocol", () => {
  const question = {
    id: "onboarding-next-step",
    header: "Next step",
    question: "What would you like to do first?",
    options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
  };

  it("accepts the additive exit skip action and rejects unknown actions", () => {
    expect(Value.Check(SystemAgentChatQuestionSchema, question)).toBe(true);
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "exit" })).toBe(
      true,
    );
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "dismiss" })).toBe(
      false,
    );
  });

  it("accepts a single non-skippable acknowledgement action", () => {
    const acknowledgement = {
      ...question,
      options: [{ label: "Continue" }],
    };
    expect(Value.Check(SystemAgentChatQuestionSchema, acknowledgement)).toBe(false);
    expect(
      Value.Check(SystemAgentChatQuestionSchema, { ...acknowledgement, allowSkip: true }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatQuestionSchema, { ...acknowledgement, allowSkip: false }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatQuestionSchema, {
        ...acknowledgement,
        allowSkip: false,
        isOther: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatQuestionSchema, {
        ...acknowledgement,
        allowSkip: false,
        skipAction: "exit",
      }),
    ).toBe(false);
  });

  it("preserves source-compatible optional-field reads on acknowledgements", () => {
    const readLegacyFields = (value: SystemAgentChatQuestion) => [value.isOther, value.skipAction];
    const acknowledgement: SystemAgentChatQuestion = {
      ...question,
      options: [{ label: "Continue" }],
      allowSkip: false,
    };

    expect(readLegacyFields(acknowledgement)).toEqual([undefined, undefined]);
  });
});

describe("OpenClaw chat result protocol", () => {
  const question = {
    id: "setup-qr",
    header: "Scan QR code",
    question: "Scan the code, then continue.",
    options: [{ label: "Continue" }],
    allowSkip: false,
  } satisfies SystemAgentChatPresentation["question"];

  it("accepts the shared bounded PNG data URL contract", () => {
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        sessionId: "setup-session",
        reply: "Scan this QR code, then continue.",
        action: "none",
        presentation: {
          kind: "qr",
          wizardInputPending: true,
          dataUrl: QR_DATA_URL,
          expiresAtMs: 1_800_000,
          question,
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        sessionId: "setup-session",
        reply: "Scan this QR code, then continue.",
        action: "none",
        presentation: {
          kind: "qr",
          wizardInputPending: true,
          dataUrl: "not-a-data-url",
          expiresAtMs: 1_800_000,
          question,
        },
      }),
    ).toBe(false);
    for (const dataUrl of [
      QR_DATA_URL_PREFIX,
      `${QR_DATA_URL_PREFIX}A`,
      `${QR_DATA_URL_PREFIX}A===`,
      `${QR_DATA_URL_PREFIX}AAAA=`,
      `${QR_DATA_URL_PREFIX}AA=A`,
      `${QR_DATA_URL_PREFIX}AA A`,
    ]) {
      expect(
        Value.Check(SystemAgentChatResultSchema, {
          sessionId: "setup-session",
          reply: "Scan this QR code, then continue.",
          action: "none",
          presentation: {
            kind: "qr",
            wizardInputPending: true,
            dataUrl,
            expiresAtMs: 1_800_000,
            question,
          },
        }),
      ).toBe(false);
    }
    const result = {
      sessionId: "setup-session",
      reply: "Scan this QR code, then continue.",
      action: "none",
      presentation: {
        kind: "qr",
        wizardInputPending: true,
        dataUrl: qrDataUrlWithLength(16_384),
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        question,
      },
    };
    expect(Value.Check(SystemAgentChatResultSchema, result)).toBe(true);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...result,
        presentation: {
          ...result.presentation,
          dataUrl: qrDataUrlWithLength(16_385),
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...result,
        presentation: {
          ...result.presentation,
          expiresAtMs: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toBe(false);
  });

  it("rejects partial or skippable QR presentation bundles", () => {
    const base = {
      sessionId: "setup-session",
      reply: "Scan this QR code, then continue.",
      action: "none",
    };
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...base,
        presentation: { kind: "qr", dataUrl: QR_DATA_URL },
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...base,
        presentation: {
          kind: "qr",
          wizardInputPending: false,
          dataUrl: QR_DATA_URL,
          expiresAtMs: 1_800_000,
          question,
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...base,
        presentation: {
          kind: "qr",
          wizardInputPending: true,
          dataUrl: QR_DATA_URL,
          expiresAtMs: 1_800_000,
          question: {
            ...question,
            options: [{ label: "Continue" }, { label: "Cancel" }],
            allowSkip: true,
          },
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...base,
        wizardInputPending: true,
        presentation: {
          kind: "qr",
          wizardInputPending: true,
          dataUrl: QR_DATA_URL,
          expiresAtMs: 1_800_000,
          question,
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...base,
        question,
        presentation: {
          kind: "qr",
          wizardInputPending: true,
          dataUrl: QR_DATA_URL,
          expiresAtMs: 1_800_000,
          question,
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentChatResultSchema, {
        ...base,
        action: "open-agent",
        presentation: {
          kind: "qr",
          wizardInputPending: true,
          dataUrl: QR_DATA_URL,
          expiresAtMs: 1_800_000,
          question,
        },
      }),
    ).toBe(false);
    expect(Value.Check(SystemAgentChatResultSchema, base)).toBe(true);
  });

  it("models the atomic QR bundle in the public TypeScript type", () => {
    const validPresentation = {
      sessionId: "setup-session",
      reply: "Scan this QR code, then continue.",
      action: "none",
      presentation: {
        kind: "qr",
        wizardInputPending: true,
        dataUrl: QR_DATA_URL,
        expiresAtMs: 1_800_000,
        question,
      },
    } satisfies SystemAgentChatResult;
    expectTypeOf(validPresentation).toMatchTypeOf<SystemAgentChatResult>();

    type NavigationQrResult = Omit<typeof validPresentation, "action"> & {
      action: "open-agent";
    };
    expectTypeOf<NavigationQrResult>().not.toMatchTypeOf<SystemAgentChatResult>();

    type MultiOptionQrResult = Omit<typeof validPresentation, "presentation"> & {
      presentation: Omit<SystemAgentChatPresentation, "question"> & {
        question: Omit<SystemAgentChatPresentation["question"], "options"> & {
          options: [{ label: string }, { label: string }];
        };
      };
    };
    expectTypeOf<MultiOptionQrResult>().not.toMatchTypeOf<SystemAgentChatResult>();
  });
});

describe("OpenClaw chat history protocol", () => {
  it("accepts the default request and bounds explicit limits", () => {
    expect(validateSystemAgentChatHistoryParams({})).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 1 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 500 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 0 })).toBe(false);
    expect(validateSystemAgentChatHistoryParams({ limit: 501 })).toBe(false);
  });

  it("accepts ordered role, text, and timestamp turns only", () => {
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [
          { role: "user", text: "status", at: 1 },
          { role: "assistant", text: "healthy", at: 2 },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [{ role: "tool", text: "hidden", at: 1 }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup detection protocol", () => {
  it("accepts additive presentation metadata and older results without installs", () => {
    const result = {
      candidates: [
        {
          kind: "provider-auto:ollama",
          brandId: "ollama",
          label: "Ollama",
          detail: "available locally",
          modelRef: "ollama/qwen3",
          recommended: false,
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      unavailableCandidates: [
        {
          id: "gemini-cli",
          brandId: "google-gemini-cli",
          label: "Gemini CLI",
          detail: "installed; login status unavailable",
          reason: "Reconnect through OpenClaw or use a Gemini API key.",
          authOptionId: "google-gemini-cli",
          manualProviderId: "gemini-api-key",
        },
      ],
      manualProviders: [
        {
          id: "ollama",
          brandId: "ollama",
          groupLabel: "Ollama",
          label: "Ollama",
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      authOptions: [],
      prepareOptions: [
        {
          id: "lmstudio",
          brandId: "lmstudio",
          label: "LM Studio",
          hint: "Local/self-hosted LM Studio server",
          actionLabel: "Connect server",
          icon: "https://cdn.simpleicons.org/lmstudio",
          website: "https://lmstudio.ai/download",
        },
      ],
      recommendedInstalls: [
        {
          id: "ollama",
          brandId: "ollama",
          label: "Ollama",
          hint: "Run open models locally",
          website: "https://ollama.com/download",
          icon: "https://cdn.simpleicons.org/ollama",
        },
      ],
      workspace: "/tmp/work",
      setupComplete: false,
    };

    expect(Value.Check(SystemAgentSetupDetectResultSchema, result)).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        candidates: result.candidates.map(({ brandId: _brandId, ...candidate }) => candidate),
        unavailableCandidates: result.unavailableCandidates.map(
          ({ brandId: _brandId, ...candidate }) => candidate,
        ),
        manualProviders: result.manualProviders.map(
          ({ brandId: _brandId, groupLabel: _groupLabel, ...provider }) => provider,
        ),
        prepareOptions: result.prepareOptions.map(({ brandId: _brandId, ...option }) => option),
        recommendedInstalls: result.recommendedInstalls.map(
          ({ brandId: _brandId, ...install }) => install,
        ),
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: undefined,
        prepareOptions: undefined,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: [{ ...result.recommendedInstalls[0], website: "http://example.test" }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup verification protocol", () => {
  it("accepts only an empty request", () => {
    expect(validateSystemAgentSetupVerifyParams({})).toBe(true);
    expect(validateSystemAgentSetupVerifyParams({ modelRef: "openai/gpt-5.5" })).toBe(false);
  });

  it("accepts the structured success and failure results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
        error: "no configured model",
      }),
    ).toBe(true);
  });

  it("rejects mixed or incomplete results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
        error: "stale failure",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "ok",
        error: "contradictory result",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
      }),
    ).toBe(false);
  });
});
