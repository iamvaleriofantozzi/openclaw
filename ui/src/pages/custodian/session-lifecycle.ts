import {
  readSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatParams,
} from "@openclaw/gateway-protocol";
import { inferBasePathFromPathname, routeIdFromPath } from "../../app-route-paths.ts";
import type {
  ApplicationGatewayConnection,
  ApplicationGatewaySnapshot,
} from "../../app/gateway.ts";

export type CustodianSessionVariant = "onboarding" | "new-agent" | "caretaker";

export function readCustodianGatewayProcessInstanceId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const processInstanceId = (value as Record<string, unknown>).processInstanceId;
  return typeof processInstanceId === "string" && processInstanceId.length > 0
    ? processInstanceId
    : undefined;
}

export function resolveCustodianSessionOwnership(params: {
  connection: ApplicationGatewayConnection;
  snapshot: ApplicationGatewaySnapshot;
  previousHelloOwnerKey: string;
}): { helloOwnerKey: string; sessionOwnerKey: string } {
  let helloOwnerKey = params.previousHelloOwnerKey;
  if (params.snapshot.hello) {
    // Presence projects the Gateway's authenticatedUserId as email. The profile id
    // can stay unchanged when the authenticated alias changes, but session ownership cannot.
    const authenticatedUserId = params.snapshot.selfUser?.email?.trim() ?? "";
    const authenticatedDeviceId = params.snapshot.client?.authenticatedDeviceId?.trim() ?? "";
    // Match the Gateway owner precedence. An empty key means the session is
    // connection-bound and therefore cannot survive a browser-client replacement.
    helloOwnerKey = authenticatedUserId
      ? `user:${authenticatedUserId}`
      : authenticatedDeviceId
        ? `device:${authenticatedDeviceId}`
        : "";
  }
  const { gatewayUrl, token, password, bootstrapToken } = params.connection;
  return {
    helloOwnerKey,
    sessionOwnerKey: JSON.stringify([gatewayUrl, token, password, bootstrapToken, helloOwnerKey]),
  };
}

export function sessionVariant(
  onboarding: boolean,
  newAgentIntent: boolean,
): CustodianSessionVariant {
  return onboarding ? "onboarding" : newAgentIntent ? "new-agent" : "caretaker";
}

export function custodianChatParams(
  variant: CustodianSessionVariant,
  message?: string,
): Pick<SystemAgentChatParams, "welcomeVariant" | "message" | "context"> {
  const variantParams = variant === "caretaker" ? {} : { welcomeVariant: variant };
  if (message === undefined) {
    return variantParams;
  }
  const pathname = window.location.pathname;
  const page = routeIdFromPath(pathname, inferBasePathFromPathname(pathname));
  return { ...variantParams, message, ...(page ? { context: { page } } : {}) };
}

export function isCustodianSessionInvalidatedError(error: unknown): boolean {
  const details =
    error && typeof error === "object" ? (error as { details?: unknown }).details : undefined;
  return readSystemAgentSessionInvalidatedErrorDetails(details) !== undefined;
}
