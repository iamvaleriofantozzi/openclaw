import {
  retainSystemAgentWizardSettlement,
  retireSystemAgentGatewayExecution,
} from "./system-agent-execution-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

export async function disposeSystemAgentSessions(
  sessions: GatewayRequestContext["systemAgentSessions"],
  wizardSessions: GatewayRequestContext["wizardSessions"],
): Promise<void> {
  const ownedWizards = Array.from(wizardSessions.values());
  wizardSessions.clear();
  for (const wizard of ownedWizards) {
    wizard.cancel();
  }
  const wizardSettlement = Promise.all(ownedWizards.map((wizard) => wizard.whenSettled())).then(
    () => undefined,
  );
  // Reject callbacks admitted by this Gateway generation before releasing any
  // session owner. Otherwise a queued callback could repopulate the retired map.
  retireSystemAgentGatewayExecution(sessions);
  // Clear ownership before awaiting disposal so no new request can rediscover
  // a generation whose engines are already releasing QR secrets and timers.
  const ownedSessions = Array.from(sessions.values());
  sessions.clear();
  const persistentApplySettlements = ownedSessions
    .map((session) => session.engine.getPersistentApplySettlement())
    .filter((settlement): settlement is Promise<void> => settlement !== null);
  const mutationSettlement = Promise.all([wizardSettlement, ...persistentApplySettlements]).then(
    () => undefined,
  );
  retainSystemAgentWizardSettlement(mutationSettlement);
  const results = await Promise.allSettled([
    mutationSettlement,
    ...ownedSessions.map((session) => session.engine.dispose()),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Failed to dispose system-agent sessions",
    );
  }
}
