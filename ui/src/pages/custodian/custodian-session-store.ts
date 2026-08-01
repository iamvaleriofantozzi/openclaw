import {
  readSystemAgentInferenceUnavailableErrorDetails,
  type SystemAgentChatParams,
  type SystemAgentChatResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { buildAgentMainSessionKey, normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { pathForCustodianAgentHandoff } from "./custodian-navigation.ts";
import { CustodianQrExpiry, parseCustodianQrPresentation } from "./custodian-qr.ts";
import * as eventNudgeState from "./event-nudge.ts";
import {
  custodianChatParams,
  isCustodianSessionInvalidatedError,
  readCustodianGatewayProcessInstanceId,
  resolveCustodianSessionOwnership,
  type CustodianSessionVariant,
} from "./session-lifecycle.ts";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";
import {
  createCustodianSessionId,
  createCustodianTranscriptMessages,
  custodianErrorMessage,
  expireCustodianQrPresentation,
  hasUnresolvedCustodianQuestion,
  readCustodianTranscript,
  restoreCustodianQrCodes,
  retireCustodianQrPresentation,
  retireCustodianQuestions,
  scrubCustodianQrCodes,
  type CustodianMessage,
} from "./transcript.ts";

const SYSTEM_AGENT_CHAT_TIMEOUT_MS = 190_000;
const SILENT_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

type StoreListener = () => void;
type ConfiguredInferenceState = "unresolved" | "required" | "ready";
type CustodianSetupIssue = "missing" | "unavailable";

/** One process-local conversation owner shared by the full page and dock surface. */
export class CustodianSessionStore {
  messages: CustodianMessage[] = [];
  input = "";
  sending = false;
  sensitive = false;
  wizardInputPending = false;
  questionReplyUncertain = false;
  error: string | null = null;
  setupIssue: CustodianSetupIssue | null = null;
  dismissedQuestions = new Set<string>();
  answeredQuestions = new Set<string>();
  activeClient: GatewayBrowserClient | null = null;
  chatAvailable = false;
  eventNudge: eventNudgeState.CustodianEventNudge | null = null;
  eventNudgePending: eventNudgeState.CustodianEventNudge | null = null;
  channelOnboardingNudgeClosed = false;
  earlierBoundaryAfterId: number | null = null;
  abandonedTurnOutcomeUnknown = false;

  private context: ApplicationContext | null = null;
  private variant: CustodianSessionVariant = "caretaker";
  private sessionVariant: CustodianSessionVariant | null = null;
  private sessionId = createCustodianSessionId();
  private requestEpoch = 0;
  private nextMessageId = 1;
  private retryParams: SystemAgentChatParams | null = null;
  private sessionClient: GatewayBrowserClient | null = null;
  private sessionOwnershipKey: string | null = null;
  private sessionStarted = false;
  private lastHelloOwnerKey = "";
  private lastGatewayProcessInstanceId: string | undefined;
  private configuredInferenceState: ConfiguredInferenceState = "unresolved";
  private eventNudgeClosed = false;
  private gatewayCleanup: (() => void) | null = null;
  private agentCleanup: (() => void) | null = null;
  private eventCleanup: (() => void) | null = null;
  private readonly qrExpiry = new CustodianQrExpiry();
  private readonly listeners = new Set<StoreListener>();

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(context: ApplicationContext, variant: CustodianSessionVariant): void {
    const contextChanged = this.context !== context;
    const variantChanged = this.variant !== variant;
    if (!contextChanged && !variantChanged) {
      return;
    }
    if (contextChanged) {
      this.gatewayCleanup?.();
      this.agentCleanup?.();
      this.eventCleanup?.();
      this.context = context;
      this.gatewayCleanup = context.gateway.subscribe(() => {
        this.synchronizeClient();
        this.emit();
      });
      this.agentCleanup = context.agents.subscribe(() => {
        this.synchronizeClient();
        this.emit();
      });
      this.eventCleanup = context.gateway.subscribeEvents((event) => {
        if (this.variant !== "caretaker" || this.eventNudgeClosed) {
          return;
        }
        [this.eventNudge, this.eventNudgePending] = eventNudgeState.reconcileCustodianEventNudge(
          this.eventNudge,
          this.eventNudgePending,
          event,
        );
        this.emit();
      });
    }
    this.variant = variant;
    this.synchronizeClient();
    this.emit();
  }

  setInput(value: string): void {
    this.input = value;
    this.emit();
  }

  hasRealUserTurn(): boolean {
    return this.messages.some((message) => message.role === "user");
  }

  get activeVariant(): CustodianSessionVariant {
    return this.variant;
  }

  hasUnresolvedQuestion(): boolean {
    return hasUnresolvedCustodianQuestion(
      this.messages,
      this.dismissedQuestions,
      this.answeredQuestions,
      this.wizardInputPending,
      this.questionReplyUncertain,
    );
  }

  canRetry(): boolean {
    return this.retryParams !== null && this.retryParams.message === undefined;
  }

  get setupRequired(): boolean {
    return this.setupIssue !== null;
  }

  retry(): void {
    const client = this.activeClient;
    const params = this.retryParams;
    if (client && params && params.message === undefined && this.chatAvailable && !this.sending) {
      void this.initializeSession(client, params);
    }
  }

  async send(
    text = this.input,
    display?: string,
    questionReply = this.hasUnresolvedQuestion(),
  ): Promise<eventNudgeState.CustodianSendOutcome> {
    // Trim decides emptiness only; sensitive values may carry meaningful whitespace.
    const message = this.sensitive ? text : text.trim();
    const client = this.activeClient;
    const questionState = [this.answeredQuestions, this.questionReplyUncertain] as const;
    if (questionReply) {
      this.questionReplyUncertain = true;
    }
    if (!message.trim() || !client || !this.chatAvailable || this.sending || this.setupRequired) {
      this.emit();
      return "rejected";
    }
    const displayText = this.sensitive ? t("custodian.sensitiveReply") : (display ?? message);
    this.abandonedTurnOutcomeUnknown = false;
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    const qrSnapshot = scrubCustodianQrCodes(this.messages);
    const qrExpiresAtMs = this.qrExpiry.expiresAtMs;
    this.qrExpiry.clear();
    this.messages = qrSnapshot.messages;
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "user",
        text: displayText,
        at: Date.now(),
        question: null,
      },
    ];
    this.input = "";
    this.emit();
    const reply = this.requestReply(client, {
      sessionId: this.sessionId,
      ...custodianChatParams(this.variant, message),
    });
    const replyEpoch = this.requestEpoch;
    const { outcome } = await reply;
    if (questionReply && this.requestEpoch === replyEpoch) {
      if (outcome === "unknown" && qrSnapshot.qrDataUrls.size > 0) {
        // The acknowledgement may have advanced to a prompt the UI never received.
        // Retire that session so later text cannot answer the unseen prompt.
        this.abandonedTurnOutcomeUnknown = true;
        this.rotateVolatileSession(client, this.variant);
        return outcome;
      }
      this.questionReplyUncertain = eventNudgeState.questionUncertainty(questionState[1], outcome);
      if (outcome === "rejected") {
        this.answeredQuestions = questionState[0];
        this.messages = restoreCustodianQrCodes(this.messages, qrSnapshot.qrDataUrls);
        if (qrSnapshot.qrDataUrls.size > 0 && qrExpiresAtMs !== undefined) {
          this.scheduleQrExpiry(qrExpiresAtMs);
        }
      }
      this.emit();
    }
    return outcome;
  }

  async sendEventNudge(): Promise<void> {
    const nudge = this.eventNudge;
    if (!nudge || this.sensitive || this.hasUnresolvedQuestion()) {
      return;
    }
    this.eventNudgePending = nudge;
    this.emit();
    const outcome = await this.send(nudge.message);
    if (this.eventNudgePending === nudge) {
      this.eventNudgePending = null;
      const consumed = eventNudgeState.shouldConsumeNudge(this.eventNudge, nudge, outcome);
      [this.eventNudgeClosed, this.eventNudge] = [consumed, consumed ? null : this.eventNudge];
      this.emit();
    }
  }

  dismissEventNudge(): void {
    [this.eventNudge, this.eventNudgeClosed] = [null, true];
    this.emit();
  }

  dismissChannelOnboardingNudge(): void {
    this.channelOnboardingNudgeClosed = true;
    this.emit();
    this.context?.replace("custodian");
  }

  openChannelsFromOnboarding(): void {
    this.channelOnboardingNudgeClosed = true;
    this.emit();
    this.context?.navigate("channels");
  }

  async dismissQuestion(message: CustodianMessage): Promise<void> {
    const question = message.question;
    if (!question) {
      return;
    }
    if (question.skipAction === "exit") {
      this.exitSetup();
      return;
    }
    const outcome = await this.send(
      question.isOther ? t("optionCard.skip") : "cancel",
      t("optionCard.skip"),
      true,
    );
    if (outcome !== "rejected" && this.messages.includes(message)) {
      this.dismissedQuestions = new Set(this.dismissedQuestions).add(
        `${message.id}:${question.id}`,
      );
      this.emit();
    }
  }

  answerQuestion(message: CustodianMessage, label: string): void {
    const question = message.question;
    if (!question) {
      return;
    }
    const option = question.options.find((candidate) => candidate.label === label);
    void this.send(option?.reply ?? label, label, true);
  }

  exitSetup(): void {
    this.context?.navigate("chat");
  }

  openModelSetup(): void {
    this.context?.navigate("model-setup");
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private currentSessionOwnershipKey(): string {
    const context = this.context;
    if (!context) {
      return "";
    }
    const ownership = resolveCustodianSessionOwnership({
      connection: context.gateway.connection,
      snapshot: context.gateway.snapshot,
      previousHelloOwnerKey: this.lastHelloOwnerKey,
    });
    this.lastHelloOwnerKey = ownership.helloOwnerKey;
    return ownership.sessionOwnerKey;
  }

  private startSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
    loadTranscript: boolean,
    resetExisting = false,
  ): void {
    if (!resetExisting) {
      this.sessionId = createCustodianSessionId();
    }
    this.sessionVariant = variant;
    this.sessionClient = client;
    this.sessionOwnershipKey = this.currentSessionOwnershipKey();
    this.sessionStarted = true;
    void this.initializeSession(
      client,
      {
        sessionId: this.sessionId,
        ...custodianChatParams(variant),
        ...(resetExisting ? { reset: true } : {}),
      },
      loadTranscript,
    );
  }

  private abandonPendingUserTurn(pendingParams: SystemAgentChatParams | null): void {
    if (pendingParams?.message === undefined) {
      return;
    }
    this.retryParams = null;
    // The gateway may already have acted, so keep the warning without retaining replayable text.
    this.abandonedTurnOutcomeUnknown = true;
  }

  private scheduleQrExpiry(expiresAtMs: number): void {
    this.qrExpiry.schedule(expiresAtMs, () => {
      const result = expireCustodianQrPresentation(this.messages);
      this.messages = result.messages;
      if (!result.expired) {
        return;
      }
      this.wizardInputPending = false;
      this.questionReplyUncertain = false;
      this.emit();
    });
  }

  private retireVolatileSessionPresentation(): void {
    this.answeredQuestions = retireCustodianQuestions(this.messages, this.answeredQuestions);
    this.messages = retireCustodianQrPresentation(this.messages);
    this.qrExpiry.clear();
    this.sensitive = this.wizardInputPending = this.questionReplyUncertain = false;
  }

  private rotateVolatileSession(
    client: GatewayBrowserClient,
    variant: CustodianSessionVariant,
  ): void {
    this.retireVolatileSessionPresentation();
    this.retryParams = null;
    this.input = "";
    this.error = null;
    this.setupIssue = null;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.startSession(client, variant, false);
  }

  private synchronizeClient(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    const client = snapshot.phase === "connected" ? snapshot.client : null;
    const gatewayProcessInstanceId = readCustodianGatewayProcessInstanceId(
      snapshot.hello?.snapshot,
    );
    const gatewayProcessIdentityMatches =
      gatewayProcessInstanceId !== undefined &&
      this.lastGatewayProcessInstanceId !== undefined &&
      gatewayProcessInstanceId === this.lastGatewayProcessInstanceId;
    const gatewayRestarted =
      this.sessionStarted &&
      ((gatewayProcessInstanceId !== undefined &&
        this.lastGatewayProcessInstanceId !== undefined &&
        gatewayProcessInstanceId !== this.lastGatewayProcessInstanceId) ||
        (client !== null &&
          this.activeClient === null &&
          client === this.sessionClient &&
          !gatewayProcessIdentityMatches));
    if (gatewayProcessInstanceId !== undefined) {
      this.lastGatewayProcessInstanceId = gatewayProcessInstanceId;
    }
    const chatSupported =
      client !== null && isGatewayMethodAdvertised(snapshot, "openclaw.chat") === true;
    const configuredInferenceState = this.resolveConfiguredInferenceState();
    const inferenceStateChanged = configuredInferenceState !== this.configuredInferenceState;
    this.configuredInferenceState = configuredInferenceState;
    const variantChanged = this.sessionStarted && this.sessionVariant !== this.variant;
    const ownershipKey = this.currentSessionOwnershipKey();
    const clientReplaced =
      this.sessionStarted &&
      client !== null &&
      this.sessionClient !== null &&
      client !== this.sessionClient;
    // The browser client reconnects in place, but the Gateway gives an anonymous
    // connection a new owner id, so its previous process-local session is unusable.
    const connectionBoundClientReconnected =
      this.sessionStarted &&
      client !== null &&
      this.activeClient === null &&
      client === this.sessionClient &&
      !this.lastHelloOwnerKey;
    const abandonedTurnClientReconnected =
      this.sessionStarted &&
      client !== null &&
      this.activeClient === null &&
      client === this.sessionClient &&
      this.abandonedTurnOutcomeUnknown;
    const ownershipChanged =
      this.sessionOwnershipKey !== null && ownershipKey !== this.sessionOwnershipKey;
    if (
      client === this.activeClient &&
      !variantChanged &&
      !clientReplaced &&
      !connectionBoundClientReconnected &&
      !abandonedTurnClientReconnected &&
      !ownershipChanged &&
      !gatewayRestarted &&
      this.chatAvailable === (chatSupported && configuredInferenceState !== "unresolved") &&
      !inferenceStateChanged
    ) {
      return;
    }
    const requestWasPending = this.sending && this.retryParams !== null;
    const pendingParams = requestWasPending ? this.retryParams : null;
    const retryableInitialization =
      this.retryParams?.message === undefined ? this.retryParams : null;
    this.activeClient = client;
    this.requestEpoch += 1;
    this.sending = false;
    this.chatAvailable = false;
    if (variantChanged || ownershipChanged || gatewayRestarted) {
      // A different operator, route mode, or Gateway process cannot inherit
      // process-local wizard state from the previous owner.
      [this.eventNudge, this.eventNudgePending] = [null, null];
      if (variantChanged || ownershipChanged) {
        this.eventNudgeClosed = false;
      }
      if (variantChanged || ownershipChanged) {
        this.abandonedTurnOutcomeUnknown = false;
      } else {
        this.abandonPendingUserTurn(pendingParams);
      }
      if (variantChanged && !ownershipChanged && !gatewayRestarted && client && chatSupported) {
        this.clearConversation();
        this.chatAvailable = true;
        this.startSession(client, this.variant, false, true);
        return;
      }
      this.sessionStarted = false;
      this.clearConversation();
    } else if (
      client &&
      (clientReplaced || connectionBoundClientReconnected || abandonedTurnClientReconnected)
    ) {
      if (!chatSupported) {
        this.sessionStarted = false;
        this.abandonPendingUserTurn(pendingParams);
        // The replacement cannot continue this process-local prompt, so do not
        // leave credential bytes or an unusable acknowledgement visible.
        this.retireVolatileSessionPresentation();
        this.error = t("custodian.unsupportedGateway");
        return;
      }
      this.chatAvailable = true;
      const abandonedUserTurn =
        pendingParams?.message !== undefined || this.abandonedTurnOutcomeUnknown;
      this.abandonPendingUserTurn(pendingParams);
      if (abandonedUserTurn || !gatewayProcessIdentityMatches || !this.lastHelloOwnerKey) {
        // The lost response may have advanced the Gateway into a prompt the UI
        // never rendered. A fresh session prevents later input acknowledging it.
        this.rotateVolatileSession(client, this.variant);
        return;
      }
      // The Gateway binds the live session to operator/device identity, not the socket instance.
      // Rebinding preserves model context and avoids turning a reconnect into a durable reset.
      this.sessionClient = client;
      this.sessionOwnershipKey = ownershipKey;
      this.error = retryableInitialization ? this.error : null;
      if (retryableInitialization) {
        void this.initializeSession(client, retryableInitialization, false);
      }
      return;
    } else if (requestWasPending) {
      if (pendingParams?.message === undefined) {
        this.error = t("custodian.connectionChanged");
      }
      this.abandonPendingUserTurn(pendingParams);
    }
    if (!client) {
      return;
    }
    if (!chatSupported) {
      this.error = t("custodian.unsupportedGateway");
      return;
    }
    if (configuredInferenceState === "unresolved") {
      return;
    }
    this.chatAvailable = true;
    if (configuredInferenceState === "required") {
      this.sessionStarted = false;
      this.clearConversation();
      this.setupIssue = "missing";
      return;
    }
    if (inferenceStateChanged) {
      this.setupIssue = null;
    }
    if (this.sessionStarted) {
      if (!this.retryParams) {
        this.error = requestWasPending ? this.error : null;
      }
      return;
    }
    this.clearConversation();
    this.startSession(client, this.variant, true);
  }

  private resolveConfiguredInferenceState(): ConfiguredInferenceState {
    const context = this.context;
    if (!context || context.gateway.snapshot.phase !== "connected") {
      return "unresolved";
    }
    const agentsList = context.agents.state.agentsList;
    if (!agentsList) {
      return "unresolved";
    }
    const selectedId = normalizeAgentId(
      context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
    );
    const selectedAgent = agentsList.agents.find(
      (agent) => normalizeAgentId(agent.id) === selectedId,
    );
    if (!selectedAgent) {
      return "unresolved";
    }
    return selectedAgent.model?.primary?.trim() ? "ready" : "required";
  }

  private async initializeSession(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    loadTranscript = true,
  ): Promise<void> {
    const epoch = ++this.requestEpoch;
    this.sending = true;
    this.error = null;
    this.retryParams = params;
    this.emit();
    if (loadTranscript) {
      await this.refreshTranscriptHistory(client, epoch);
    }
    if (epoch !== this.requestEpoch || client !== this.activeClient) {
      return;
    }
    await this.requestReply(client, params);
  }

  private async refreshTranscriptHistory(
    client: GatewayBrowserClient,
    epoch: number,
  ): Promise<void> {
    const context = this.context;
    if (
      !context ||
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.chat.history") !== true
    ) {
      return;
    }
    const turns = await readCustodianTranscript(client);
    if (turns === null || epoch !== this.requestEpoch || client !== this.activeClient) {
      return;
    }
    const transcript = createCustodianTranscriptMessages(turns, this.nextMessageId);
    this.messages = transcript.messages;
    this.nextMessageId = transcript.nextMessageId;
    this.earlierBoundaryAfterId = this.messages.at(-1)?.id ?? null;
    this.emit();
  }

  private clearConversation(): void {
    this.messages = [];
    this.dismissedQuestions = new Set();
    this.answeredQuestions = new Set();
    this.retryParams = null;
    this.error = null;
    this.setupIssue = null;
    this.input = "";
    this.qrExpiry.clear();
    this.sensitive = this.wizardInputPending = this.questionReplyUncertain = false;
    this.earlierBoundaryAfterId = null;
  }

  private appendAssistant(
    reply: string,
    question: CustodianStructuredQuestion | null,
    qrDataUrl?: string,
  ): void {
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "assistant",
        text: reply,
        at: Date.now(),
        question,
        ...(qrDataUrl ? { qrDataUrl } : {}),
      },
    ];
  }

  private async requestReply(
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
  ): Promise<eventNudgeState.CustodianSendResult> {
    const context = this.context;
    if (!context) {
      return { outcome: "rejected", delivery: "unsent" };
    }
    const epoch = ++this.requestEpoch;
    let delivery: eventNudgeState.CustodianSendDelivery = "unsent";
    this.sending = true;
    this.error = null;
    if (params.message !== undefined) {
      this.setupIssue = null;
    }
    this.retryParams = params;
    this.emit();
    try {
      const result = await client.request<SystemAgentChatResult>("openclaw.chat", params, {
        timeoutMs: SYSTEM_AGENT_CHAT_TIMEOUT_MS,
        onSent: () => {
          delivery = "sent";
        },
      });
      delivery = "received";
      if (epoch !== this.requestEpoch || client !== this.activeClient) {
        return { outcome: "sent", delivery };
      }
      this.sessionId = result.sessionId;
      this.sensitive = result.sensitive === true;
      const presentation = result.presentation;
      this.retryParams = null;
      const qrPresentation = parseCustodianQrPresentation(presentation);
      // Presentation is an atomic wire contract. A malformed bundle degrades
      // to prose instead of leaving an acknowledgement for an unseen QR code.
      this.wizardInputPending =
        qrPresentation !== null ||
        (presentation === undefined && result.wizardInputPending === true);
      this.setupIssue = null;
      const question =
        qrPresentation?.question ??
        (presentation === undefined ? parseCustodianQuestion(result.question) : null);
      const qrDataUrl = qrPresentation?.dataUrl;
      const silentReply = SILENT_REPLY_PATTERN.test(result.reply);
      if (!silentReply || question || qrDataUrl) {
        this.appendAssistant(silentReply ? "" : result.reply, question, qrDataUrl);
      }
      if (qrPresentation) {
        this.scheduleQrExpiry(qrPresentation.expiresAtMs);
      }
      if (result.action === "open-agent") {
        let sessionKey = context.gateway.snapshot.sessionKey?.trim();
        if (result.agentId) {
          const roster = await context.agents.refreshList();
          if (epoch !== this.requestEpoch || client !== this.activeClient) {
            return { outcome: "sent", delivery };
          }
          sessionKey = buildAgentMainSessionKey({
            agentId: result.agentId,
            mainKey: roster?.mainKey,
          });
          selectApplicationSession({
            selection: context.agentSelection,
            gateway: context.gateway,
            sessionKey,
            agentId: result.agentId,
          });
        }
        if (result.agentDraft === "hatch" && sessionKey) {
          context.navigate("chat", {
            pathname: pathForCustodianAgentHandoff(context, sessionKey),
            search: `?draft=${encodeURIComponent(t("custodian.hatchDraft"))}`,
          });
        } else {
          this.exitSetup();
        }
      } else if (result.action === "exit") {
        this.exitSetup();
      }
      return { outcome: "sent", delivery };
    } catch (error) {
      if (epoch === this.requestEpoch && client === this.activeClient) {
        this.error = custodianErrorMessage(error);
        const details =
          error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
        this.setupIssue =
          readSystemAgentInferenceUnavailableErrorDetails(details) !== undefined
            ? this.configuredInferenceState === "required"
              ? "missing"
              : "unavailable"
            : null;
        if (params.message !== undefined && isCustodianSessionInvalidatedError(error)) {
          // Retained transcript rows are display context only; the next turn needs a fresh id.
          this.rotateVolatileSession(client, this.variant);
          this.error = t("custodian.sessionRestarted", { error: custodianErrorMessage(error) });
        }
      }
      if (params.message !== undefined && this.retryParams === params) {
        // User turns have no idempotency key and are never replayed after an ambiguous failure.
        this.retryParams = null;
      }
      return {
        outcome: eventNudgeState.classifyCustodianSendFailure(error, delivery),
        delivery,
      };
    } finally {
      if (epoch === this.requestEpoch) {
        this.sending = false;
      }
      this.emit();
    }
  }
}

export const custodianSessionStore = new CustodianSessionStore();
