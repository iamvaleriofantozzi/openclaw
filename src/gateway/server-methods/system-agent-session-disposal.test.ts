import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { WizardSession } from "../../wizard/session.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution-lifecycle.js";
import { disposeSystemAgentSessions } from "./system-agent-session-disposal.js";
import type { GatewayRequestContext } from "./types.js";

type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

function sessionWithDispose(
  dispose: () => Promise<void>,
  persistentApplySettlement: Promise<void> | null = null,
): SystemAgentChatSession {
  return {
    engine: { dispose, getPersistentApplySettlement: () => persistentApplySettlement },
  } as unknown as SystemAgentChatSession;
}

describe("disposeSystemAgentSessions", () => {
  it("clears and disposes every session before surfacing failures", async () => {
    const releaseFirst = createDeferred();
    const disposeFirst = vi.fn(async () => {
      expect(sessions.size).toBe(0);
      await releaseFirst.promise;
    });
    const disposeSecond = vi.fn(async () => {
      throw new Error("second disposal failed");
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["first", sessionWithDispose(disposeFirst)],
      ["second", sessionWithDispose(disposeSecond)],
    ]);

    const disposal = disposeSystemAgentSessions(sessions, new Map());

    expect(sessions.size).toBe(0);
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(disposeSecond).toHaveBeenCalledOnce();
    releaseFirst.resolve();
    await expect(disposal).rejects.toMatchObject({
      name: "AggregateError",
      message: "Failed to dispose system-agent sessions",
      errors: [expect.objectContaining({ message: "second disposal failed" })],
    });
  });

  it("holds replacement work until a commit-locked wizard settles", async () => {
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const wizard = new WizardSession(async (_prompter, _signal, session) => {
      session.lockCancellation();
      mutationStarted.resolve();
      await releaseMutation.promise;
    });
    await mutationStarted.promise;
    const wizardSessions = new Map([["locked", wizard]]);

    const disposal = disposeSystemAgentSessions(new Map(), wizardSessions);
    expect(wizardSessions.size).toBe(0);
    const replacementTask = vi.fn(async () => "replacement");
    const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
    await Promise.resolve();
    expect(replacementTask).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await expect(disposal).resolves.toBeUndefined();
    await expect(replacement).resolves.toBe("replacement");
  });

  it("holds replacement work until an engine commit settles", async () => {
    const releaseMutation = createDeferred();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["mutating", sessionWithDispose(async () => {}, releaseMutation.promise)],
    ]);

    const disposal = disposeSystemAgentSessions(sessions, new Map());
    const replacementTask = vi.fn(async () => "replacement");
    const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
    await Promise.resolve();
    expect(replacementTask).not.toHaveBeenCalled();

    releaseMutation.resolve();
    await expect(disposal).resolves.toBeUndefined();
    await expect(replacement).resolves.toBe("replacement");
  });

  it("rejects replacement work within a bounded wait when an engine commit stalls", async () => {
    vi.useFakeTimers();
    const releaseMutation = createDeferred();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["mutating", sessionWithDispose(async () => {}, releaseMutation.promise)],
    ]);
    const disposal = disposeSystemAgentSessions(sessions, new Map());
    const replacementTask = vi.fn(async () => "replacement");

    try {
      const replacement = runSystemAgentGatewayTask(replacementTask, new Map());
      const rejection = expect(replacement).rejects.toThrow("try again shortly");
      await vi.runOnlyPendingTimersAsync();

      await rejection;
      expect(replacementTask).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      await disposal;
      vi.useRealTimers();
    }

    await expect(runSystemAgentGatewayTask(replacementTask, new Map())).resolves.toBe(
      "replacement",
    );
  });
});
