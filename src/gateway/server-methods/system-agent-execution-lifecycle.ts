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
const activeSystemAgentMutationSettlements = new WeakMap<
  GatewayRequestContext["systemAgentSessions"],
  Set<Promise<void>>
>();
let retiredSystemAgentMutationSettlement: Promise<void> = Promise.resolve();

async function waitForRetiredSystemAgentMutationSettlement(): Promise<void> {
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
    await Promise.race([retiredSystemAgentMutationSettlement, timeout]);
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
): Promise<void> {
  retiredSystemAgentSessionMaps.add(sessions);
  systemAgentGatewayExecutionQueues.delete(sessions);
  const settlements = Array.from(activeSystemAgentMutationSettlements.get(sessions) ?? []);
  activeSystemAgentMutationSettlements.delete(sessions);
  return Promise.all(settlements).then(() => undefined);
}

export function retainRetiredSystemAgentMutationSettlement(settlement: Promise<void>): void {
  const previous = retiredSystemAgentMutationSettlement;
  retiredSystemAgentMutationSettlement = Promise.all([previous, settlement]).then(() => undefined);
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
  // A persistent writer that crossed its commit boundary cannot be cancelled.
  // Preserve the cross-generation fence until every retired writer has settled.
  await waitForRetiredSystemAgentMutationSettlement();
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

export async function runSystemAgentGatewayMutationTask<T>(
  task: () => Promise<T>,
  sessions: GatewayRequestContext["systemAgentSessions"],
): Promise<T> {
  return await runSystemAgentGatewayTask(async () => {
    let settleMutation: (() => void) | undefined;
    const settlement = new Promise<void>((resolve) => {
      settleMutation = resolve;
    });
    const activeSettlements =
      activeSystemAgentMutationSettlements.get(sessions) ?? new Set<Promise<void>>();
    activeSettlements.add(settlement);
    activeSystemAgentMutationSettlements.set(sessions, activeSettlements);
    try {
      return await task();
    } finally {
      settleMutation?.();
      activeSettlements.delete(settlement);
      if (activeSettlements.size === 0) {
        activeSystemAgentMutationSettlements.delete(sessions);
      }
    }
  }, sessions);
}
