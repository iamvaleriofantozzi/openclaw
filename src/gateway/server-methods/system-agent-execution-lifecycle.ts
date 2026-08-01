import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import type { GatewayRequestContext } from "./types.js";

const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const SYSTEM_AGENT_RETIRED_SETTLEMENT_WAIT_MS = 1_000;
const systemAgentGatewayExecutionQueues = new WeakMap<
  GatewayRequestContext["systemAgentSessions"],
  KeyedAsyncQueue
>();
const retiredSystemAgentSessionMaps = new WeakSet<GatewayRequestContext["systemAgentSessions"]>();
let retiredSystemAgentWizardSettlement: Promise<void> = Promise.resolve();

async function waitForRetiredSystemAgentWizardSettlement(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          "System-agent setup from the previous Gateway is still finishing; try again shortly.",
        ),
      );
    }, SYSTEM_AGENT_RETIRED_SETTLEMENT_WAIT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([retiredSystemAgentWizardSettlement, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function getSystemAgentGatewayExecutionQueue(
  sessions: GatewayRequestContext["systemAgentSessions"],
): KeyedAsyncQueue {
  const existing = systemAgentGatewayExecutionQueues.get(sessions);
  if (existing) {
    return existing;
  }
  const queue = new KeyedAsyncQueue();
  systemAgentGatewayExecutionQueues.set(sessions, queue);
  return queue;
}

export function retireSystemAgentGatewayExecution(
  sessions: GatewayRequestContext["systemAgentSessions"],
): void {
  retiredSystemAgentSessionMaps.add(sessions);
  systemAgentGatewayExecutionQueues.delete(sessions);
}

export function retainSystemAgentWizardSettlement(settlement: Promise<void>): void {
  const previous = retiredSystemAgentWizardSettlement;
  retiredSystemAgentWizardSettlement = Promise.all([previous, settlement]).then(() => undefined);
}

export function assertSystemAgentGatewayExecutionActive(
  sessions: GatewayRequestContext["systemAgentSessions"],
): void {
  if (retiredSystemAgentSessionMaps.has(sessions)) {
    throw new Error("System-agent Gateway generation has been retired.");
  }
}

export async function runSystemAgentGatewayTask<T>(
  task: () => Promise<T>,
  sessions: GatewayRequestContext["systemAgentSessions"],
): Promise<T> {
  // A wizard that crossed its commit boundary cannot be cancelled. Preserve
  // the old cross-generation mutation fence until that writer has settled.
  await waitForRetiredSystemAgentWizardSettlement();
  assertSystemAgentGatewayExecutionActive(sessions);
  const queue = getSystemAgentGatewayExecutionQueue(sessions);
  // Track every accepted RPC as active, never queued: restart draining snapshots
  // active ids, so a queued OpenClaw request could otherwise outlive its socket.
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
    // Bound expensive detection, activation, and agent turns without hiding
    // accepted work from restart draining. Each Gateway generation owns its
    // queue, so stale work cannot block the replacement server after teardown.
    queue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, async () => {
      assertSystemAgentGatewayExecutionActive(sessions);
      return await task();
    }),
  );
}
