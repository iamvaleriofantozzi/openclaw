import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
// OpenClaw gateway methods host the setup/repair conversation for clients.
import {
  buildSystemAgentInferenceUnavailableErrorDetails,
  buildSystemAgentSessionInvalidatedErrorDetails,
  ErrorCodes,
  errorShape,
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupVerifyParams,
  type SystemAgentChatQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
} from "../../system-agent/greeting.js";
import { isSystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { buildNewAgentWelcome } from "../../system-agent/new-agent-welcome.js";
import { buildOnboardingWelcome } from "../../system-agent/onboarding-welcome.js";
import {
  appendTranscriptReset,
  appendTranscriptTurn,
  readTranscriptTail,
} from "../../system-agent/transcript-store.js";
import { resolveUserPath } from "../../utils.js";
import { WizardSession } from "../../wizard/session.js";
import { listVisiblePendingApprovalRequests } from "./approval-shared.js";
import { sanitizeSystemAgentChatParams } from "./system-agent-chat-params.js";
import { queueDelegatedSystemAgentApproval } from "./system-agent-delegated-approval.js";
import {
  assertSystemAgentGatewayExecutionActive,
  runSystemAgentGatewayTask,
} from "./system-agent-execution-lifecycle.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * `openclaw.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw setup`. Structured setup owns
 * the pre-inference phase; a new chat session starts only after a live model
 * turn succeeds.
 *
 * The bounded session map owns only in-flight wizard and approval state. The
 * sanitized conversation is a durable machine-wide logbook; `reset: true`
 * replaces the in-memory session without deleting that transcript.
 */
export type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

const MAX_SYSTEM_AGENT_SESSIONS = 8;
const SYSTEM_AGENT_SEED_HISTORY_LIMIT = 30;
const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;
const PROVIDER_AUTH_SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const PROVIDER_PREPARE_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const systemAgentSessionQueues = new WeakMap<
  Map<string, SystemAgentChatSession>,
  KeyedAsyncQueue
>();

function getSystemAgentSessionQueue(
  sessions: Map<string, SystemAgentChatSession>,
): KeyedAsyncQueue {
  let queue = systemAgentSessionQueues.get(sessions);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    systemAgentSessionQueues.set(sessions, queue);
  }
  return queue;
}

function acknowledgeDeliveredSystemAgentWelcome(session: SystemAgentChatSession): void {
  const auditSequence = session.welcomeAuditSequence;
  if (auditSequence === undefined) {
    return;
  }
  acknowledgeSystemAgentGreetingDelivery({ auditSequence });
  delete session.welcomeAuditSequence;
}

function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Delegation is the host-only, cross-connection owner asserted by the regular-agent
    // tool path. Keep its agent/session tuple authoritative across gateway reconnects.
    return delegationKey;
  }
  // Authenticated users survive reconnects and may span paired devices. Otherwise
  // bind to the verified device, with the server-issued connection as a last resort.
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}

let systemAgentSetupActivationInProgress = false;

class SystemAgentSetupActivationBusyError extends Error {}

/** Admit one setup mutation without queueing work past a caller timeout. */
export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  if (systemAgentSetupActivationInProgress) {
    throw new SystemAgentSetupActivationBusyError(
      "OpenClaw setup is already in progress; try again when it finishes.",
    );
  }
  systemAgentSetupActivationInProgress = true;
  try {
    return await task();
  } finally {
    systemAgentSetupActivationInProgress = false;
  }
}

async function evictOldestSession(
  sessions: Map<string, SystemAgentChatSession>,
  context: GatewayRequestContext,
  incomingOwnerKey: string,
): Promise<boolean> {
  if (sessions.size < MAX_SYSTEM_AGENT_SESSIONS) {
    return true;
  }
  const protectedQrSessionByOwner = new Map<string, { sessionKey: string; lastUsedAt: number }>();
  for (const [sessionKey, session] of sessions) {
    // A new session from the same owner supersedes its abandoned credential
    // prompt; protecting it here would lock that owner out at map capacity.
    if (session.ownerKey === incomingOwnerKey || !session.engine.hasPendingQrCode()) {
      continue;
    }
    const current = protectedQrSessionByOwner.get(session.ownerKey);
    if (!current || session.lastUsedAt >= current.lastUsedAt) {
      protectedQrSessionByOwner.set(session.ownerKey, {
        sessionKey,
        lastUsedAt: session.lastUsedAt,
      });
    }
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    // Keep one live credential prompt per owner. Older QR sessions are abandoned
    // once the same owner starts a newer one and must not exhaust the global map.
    if (protectedQrSessionByOwner.get(session.ownerKey)?.sessionKey === key) {
      continue;
    }
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey === undefined) {
    return false;
  }
  const oldest = sessions.get(oldestKey);
  if (oldest?.pendingApproval) {
    context.systemAgentApprovalManager?.expire(oldest.pendingApproval.id, "session-evicted");
  }
  await oldest?.engine.dispose();
  sessions.delete(oldestKey);
  return true;
}

function persistEngineHistory(engine: SystemAgentChatSession["engine"], startIndex: number): void {
  const at = Date.now();
  for (const turn of engine.historySince(startIndex)) {
    // Engine history is authoritative here: sensitive user text has already
    // been replaced by the mask marker before it crosses this boundary.
    appendTranscriptTurn({ ...turn, at });
  }
}

export const systemAgentHandlers: GatewayRequestHandlers = {
  "openclaw.approval.list": async ({ respond, client, context }) => {
    const manager = context.systemAgentApprovalManager;
    respond(
      true,
      manager ? listVisiblePendingApprovalRequests({ manager, client }) : [],
      undefined,
    );
  },
  "openclaw.chat.history": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentChatHistoryParams,
        "openclaw.chat.history",
        respond,
      )
    ) {
      return;
    }
    respond(
      true,
      { turns: readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT) },
      undefined,
    );
  },
  /** Structured onboarding: list reusable AI access on this host. */
  "openclaw.setup.detect": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupDetectParams,
        "openclaw.setup.detect",
        respond,
      )
    ) {
      return;
    }
    // Detection is read-only and may load native provider code. Keep it outside
    // the mutation lane and off the Gateway event loop so health stays live.
    const { detectSetupInferenceIsolated } =
      await import("../../system-agent/setup-inference-detection.js");
    respond(true, await detectSetupInferenceIsolated(), undefined);
  },
  /** Re-run the exact current default-agent inference route without mutating setup. */
  "openclaw.setup.verify": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupVerifyParams,
        "openclaw.setup.verify",
        respond,
      )
    ) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const { verifySetupInference } = await import("../../system-agent/setup-inference.js");
      respond(true, await verifySetupInference({ runtime: defaultRuntime }), undefined);
    }, context.systemAgentSessions);
  },
  /** Start one provider-owned OAuth/device-code login over the shared wizard transport. */
  "openclaw.setup.auth.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.auth.start",
        respond,
      )
    ) {
      return;
    }
    if (context.findRunningWizard()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = params.sessionId;
    const session = new WizardSession(
      async (prompter, signal) => {
        // Match setup.activate's lock order: setup admission before the Gateway
        // queue. Both stay held for the session, so a relaunched client cannot
        // start competing setup work while this server-owned flow can commit.
        const result = await runExclusiveSystemAgentSetupActivation(async () =>
          runSystemAgentGatewayTask(async () => {
            const { activateSetupInference } =
              await import("../../system-agent/setup-inference.js");
            return await activateSetupInference({
              kind: "provider-auth",
              authChoice: params.authChoice,
              ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
              surface: "gateway",
              runtime: {
                ...defaultRuntime,
                exit: (code: number | undefined): never => {
                  throw new Error(`setup step exited with code ${String(code)}`);
                },
              },
              prompter,
              signal,
              isCancelled: () => signal.aborted,
              onCommitStarted: () => session.lockCancellation(),
            });
          }, context.systemAgentSessions),
        );
        if (!result.ok) {
          throw new Error(result.error);
        }
      },
      { timeoutMs: PROVIDER_AUTH_SESSION_TIMEOUT_MS },
    );
    context.wizardSessions.set(sessionId, session);
    // Return ownership immediately so the client can cancel while provider auth waits.
    respond(true, { sessionId, done: false, status: "running" }, undefined);
  },
  /** Run one provider-owned prepare flow over the shared wizard transport. */
  "openclaw.setup.prepare.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.prepare.start",
        respond,
      )
    ) {
      return;
    }
    if (context.findRunningWizard()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = params.sessionId;
    const session = new WizardSession(
      async (prompter, signal) => {
        await runExclusiveSystemAgentSetupActivation(async () =>
          runSystemAgentGatewayTask(async () => {
            const [{ applyAuthChoiceLoadedPluginProvider }, setupShared] = await Promise.all([
              import("../../plugins/provider-auth-choice.js"),
              import("../../wizard/setup.shared.js"),
            ]);
            const snapshot = await setupShared.readSetupConfigFileSnapshot();
            if (!snapshot.valid) {
              throw new Error("Config is invalid. Run `openclaw doctor` before preparing a model.");
            }
            // Match the classic wizard: mutate the authored shape, not runtimeConfig,
            // so setup never writes resolved runtime defaults into openclaw.json.
            const baseConfig = snapshot.exists ? snapshot.sourceConfig : {};
            const workspaceDir = params.workspace?.trim()
              ? resolveUserPath(params.workspace.trim())
              : undefined;
            const applied = await applyAuthChoiceLoadedPluginProvider({
              authChoice: params.authChoice,
              config: baseConfig,
              prompter,
              runtime: {
                ...defaultRuntime,
                exit: (code: number | undefined): never => {
                  throw new Error(`setup step exited with code ${String(code)}`);
                },
              },
              setDefaultModel: false,
              preserveExistingDefaultModel: true,
              ...(workspaceDir ? { workspaceDir } : {}),
              signal,
              isRemote: true,
              beforePersistentEffect: () => {
                signal.throwIfAborted();
                session.lockCancellation();
              },
            });
            if (!applied || applied.retrySelection) {
              throw new Error(`Provider prepare method is unavailable: ${params.authChoice}`);
            }
            signal.throwIfAborted();
            session.lockCancellation();
            await setupShared.writeWizardConfigFile(applied.config, {
              allowConfigSizeDrop: false,
              baseSnapshot: snapshot,
              ...(snapshot.hash ? { baseHash: snapshot.hash } : {}),
              migrationBaseConfig: baseConfig,
            });
          }, context.systemAgentSessions),
        );
      },
      { timeoutMs: PROVIDER_PREPARE_SESSION_TIMEOUT_MS },
    );
    context.wizardSessions.set(sessionId, session);
    respond(true, { sessionId, done: false, status: "running" }, undefined);
  },
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. A failed attempt never
   * commits a broken model, managed plugin install, or setup state.
   */
  "openclaw.setup.activate": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupActivateParams,
        "openclaw.setup.activate",
        respond,
      )
    ) {
      return;
    }
    try {
      await runExclusiveSystemAgentSetupActivation(async () => {
        await runSystemAgentGatewayTask(async () => {
          const { activateSetupInference } = await import("../../system-agent/setup-inference.js");
          const runtime = {
            ...defaultRuntime,
            // Setup runs inside the gateway process; a failing sub-step must reject
            // the RPC, never exit the daemon.
            exit: (code: number | undefined): never => {
              throw new Error(`setup step exited with code ${String(code)}`);
            },
          };
          const result = await activateSetupInference({
            kind: params.kind,
            ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
            ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
            ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
            ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
            surface: "gateway",
            runtime,
          });
          respond(true, result, undefined);
        }, context.systemAgentSessions);
      });
    } catch (error) {
      if (!(error instanceof SystemAgentSetupActivationBusyError)) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true }),
      );
    }
  },
  "openclaw.chat": async ({ params: rawParams, respond, client, context }) => {
    const params = sanitizeSystemAgentChatParams(rawParams);
    if (!assertValidParams(params, validateSystemAgentChatParams, "openclaw.chat", respond)) {
      return;
    }
    const sessions = context.systemAgentSessions;
    await runSystemAgentGatewayTask(async () => {
      const sessionId = params.sessionId;
      // Initialization, resets, and turns share one per-session queue. Without
      // it, concurrent first messages can create competing engines and lose
      // conversation state when the later initializer replaces the first.
      await getSystemAgentSessionQueue(sessions).enqueue(sessionId, async () => {
        assertSystemAgentGatewayExecutionActive(sessions);
        const ownerKey = resolveSystemAgentSessionOwnerKey({
          delegation: params.delegation,
          client,
        });
        if (!ownerKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw caller identity unavailable."),
          );
          return;
        }
        const boundSession = sessions.get(sessionId);
        if (boundSession && boundSession.ownerKey !== ownerKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw session belongs to another caller."),
          );
          return;
        }
        const supportsQrCode = hasGatewayClientCap(
          client?.connect.caps,
          GATEWAY_CLIENT_CAPS.SYSTEM_AGENT_QR_CODE,
        );
        if (boundSession && !params.reset && boundSession.supportsQrCode !== supportsQrCode) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "OpenClaw client capabilities changed; reset the session to continue.",
            ),
          );
          return;
        }
        if (params.reset) {
          const existing = sessions.get(sessionId);
          sessions.delete(sessionId);
          if (existing?.pendingApproval) {
            context.systemAgentApprovalManager?.expire(
              existing.pendingApproval.id,
              "session-reset",
            );
          }
          await existing?.engine.dispose();
          assertSystemAgentGatewayExecutionActive(sessions);
        }
        let session = sessions.get(sessionId);
        let greetingAuditSequence: number | undefined;
        const welcomeOnly = params.message === undefined || !params.message.trim();
        if (!session) {
          const inference = params.delegation
            ? await import("../../system-agent/inference-fallback.js").then(
                ({ verifySystemAgentInferenceWithFallback }) =>
                  verifySystemAgentInferenceWithFallback({
                    requestingAgentId: params.delegation?.agentId,
                    runtime: defaultRuntime,
                  }),
              )
            : await import("../../system-agent/setup-inference.js").then(
                ({ verifySetupInference }) =>
                  verifySetupInference({ runtime: defaultRuntime, bindSession: true }),
              );
          assertSystemAgentGatewayExecutionActive(sessions);
          if (!inference.ok) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                `OpenClaw requires working inference: ${inference.error}`,
                {
                  details: buildSystemAgentInferenceUnavailableErrorDetails(),
                },
              ),
            );
            return;
          }
          // The gateway surface must never install/restart its own daemon; the
          // engine's setup path honors this via surface: "gateway".
          const engine = new SystemAgentChatEngine({
            surface: "gateway",
            supportsQrCode,
            verifiedInference: inference.binding,
            operatorApprovalOnly: params.delegation !== undefined,
          });
          // `reset: true` keeps the durable logbook but deliberately starts
          // model context clean; only ordinary fresh sessions receive its tail.
          if (!params.reset) {
            engine.seedHistory(
              readTranscriptTail(SYSTEM_AGENT_SEED_HISTORY_LIMIT, { afterLastReset: true }).map(
                ({ role, text }) => ({ role, text }),
              ),
            );
          }
          const welcomeHistoryStart = engine.historyLength();
          let welcome: string;
          let welcomeQuestion: SystemAgentChatQuestion | undefined;
          try {
            if (params.welcomeVariant === "onboarding") {
              const onboardingWelcome = await buildOnboardingWelcome({ engine });
              welcome = onboardingWelcome.text;
              welcomeQuestion = onboardingWelcome.question;
            } else if (params.welcomeVariant === "new-agent") {
              welcome = buildNewAgentWelcome({ engine });
            } else {
              const overview = await engine.loadOverview();
              const facts = loadSystemAgentGreetingFacts();
              greetingAuditSequence = facts.auditSequence;
              welcome = (
                await resolveSystemAgentGreeting({
                  overview,
                  facts,
                  planner: (plannerParams) => engine.planGreeting(plannerParams),
                  allowInference: welcomeOnly,
                })
              ).text;
              welcomeQuestion = buildSystemAgentGreetingQuestion(overview, facts);
              engine.noteAssistantMessage(welcome);
            }
          } catch (error) {
            await engine.dispose().catch(() => undefined);
            if (!isSystemAgentInferenceUnavailableError(error)) {
              throw error;
            }
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
            return;
          }
          try {
            assertSystemAgentGatewayExecutionActive(sessions);
          } catch (error) {
            await engine.dispose().catch(() => undefined);
            throw error;
          }
          if (!(await evictOldestSession(sessions, context, ownerKey))) {
            await engine.dispose().catch(() => undefined);
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "OpenClaw chat is waiting for QR acknowledgements; try again after one completes.",
                { retryable: true },
              ),
            );
            return;
          }
          try {
            assertSystemAgentGatewayExecutionActive(sessions);
          } catch (error) {
            await engine.dispose().catch(() => undefined);
            throw error;
          }
          if (params.reset) {
            appendTranscriptReset();
          }
          persistEngineHistory(engine, welcomeHistoryStart);
          session = {
            engine,
            welcome,
            ...(welcomeQuestion ? { welcomeQuestion } : {}),
            ...(greetingAuditSequence !== undefined
              ? { welcomeAuditSequence: greetingAuditSequence }
              : {}),
            lastUsedAt: Date.now(),
            ownerKey,
            supportsQrCode,
          };
          sessions.set(sessionId, session);
          if (welcomeOnly) {
            respond(
              true,
              {
                sessionId,
                reply: session.welcome,
                action: "none",
                ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
              },
              undefined,
            );
            acknowledgeDeliveredSystemAgentWelcome(session);
            return;
          }
        }
        session.lastUsedAt = Date.now();
        // Inline check (not `welcomeOnly`) so TS narrows params.message below.
        if (params.message === undefined || !params.message.trim()) {
          respond(
            true,
            {
              sessionId,
              reply: session.welcome,
              action: "none",
              ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
            },
            undefined,
          );
          acknowledgeDeliveredSystemAgentWelcome(session);
          return;
        }
        const historyStart = session.engine.historyLength();
        let reply: Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
        try {
          reply =
            params.delegation === undefined && params.context
              ? await session.engine.handle(params.message, { uiContext: params.context })
              : await session.engine.handle(params.message);
        } catch (error) {
          persistEngineHistory(session.engine, historyStart);
          if (!isSystemAgentInferenceUnavailableError(error)) {
            throw error;
          }
          // A failed inference turn invalidates this conversation. Remove the
          // exact engine before cleanup so a retry must pass the live gate and
          // cannot resume partial proposal or CLI-session state.
          // Initialization failures stay unmarked because no live session existed.
          if (sessions.get(sessionId)?.engine === session.engine) {
            sessions.delete(sessionId);
          }
          try {
            await session.engine.dispose();
          } catch {
            // The inference error is authoritative; cleanup stays best-effort.
          }
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, error.message, {
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            }),
          );
          return;
        }
        persistEngineHistory(session.engine, historyStart);
        // The TUI-only "open-tui" handoff becomes a client-visible "open-agent"
        // signal: the app should move the user to their normal agent chat.
        const action =
          reply.action === "open-tui"
            ? "open-agent"
            : reply.action === "open-setup"
              ? "none"
              : reply.action;
        const delegation = params.delegation;
        let proposalId: string | undefined;
        if (delegation) {
          const proposal = session.engine.getPendingOperatorProposal();
          if (proposal) {
            proposalId = queueDelegatedSystemAgentApproval({
              context,
              sessions,
              session,
              sessionId,
              delegation,
              proposal,
            });
          }
        }
        const presentation =
          session.supportsQrCode &&
          reply.qrDataUrl &&
          reply.qrExpiresAtMs !== undefined &&
          reply.wizardInputPending === true &&
          reply.question &&
          reply.question.options.length === 1 &&
          reply.question.allowSkip === false
            ? {
                kind: "qr" as const,
                dataUrl: reply.qrDataUrl,
                expiresAtMs: reply.qrExpiresAtMs,
                wizardInputPending: true as const,
                question: reply.question,
              }
            : undefined;
        respond(
          true,
          {
            sessionId,
            reply:
              reply.text ||
              (action === "open-agent"
                ? "Setup here is done — continue with your agent."
                : "Nothing to change."),
            action,
            ...(action === "open-agent" && reply.agentDraft
              ? { agentDraft: reply.agentDraft }
              : {}),
            ...(action === "open-agent" &&
            reply.handoff?.kind === "open-tui" &&
            reply.handoff.agentId
              ? { agentId: reply.handoff.agentId }
              : {}),
            ...(reply.sensitive === true ? { sensitive: true } : {}),
            ...(reply.wizardInputPending === true && !presentation
              ? { wizardInputPending: true }
              : {}),
            ...(reply.question && !presentation ? { question: reply.question } : {}),
            ...(presentation ? { presentation } : {}),
            ...(proposalId ? { needsApproval: true, proposalId } : {}),
          },
          undefined,
        );
      });
    }, sessions);
  },
};
