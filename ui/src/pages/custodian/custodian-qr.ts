import type { SystemAgentChatPresentation } from "@openclaw/gateway-protocol";
import {
  QR_PNG_DATA_URL_MAX_LENGTH,
  QR_PNG_DATA_URL_PREFIX,
} from "@openclaw/gateway-protocol/schema";
import { sanitizeInlineImageDataUrl } from "@openclaw/media-core/inline-image-data-url";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";

function parseCustodianQrPngDataUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > QR_PNG_DATA_URL_MAX_LENGTH ||
    !value.startsWith(QR_PNG_DATA_URL_PREFIX)
  ) {
    return undefined;
  }
  const sanitized = sanitizeInlineImageDataUrl(value);
  return sanitized?.startsWith(QR_PNG_DATA_URL_PREFIX) ? sanitized : undefined;
}

type CustodianQrPresentation = {
  dataUrl: string;
  expiresAtMs: number;
  question: CustodianStructuredQuestion;
};

export function parseCustodianQrPresentation(
  presentation: SystemAgentChatPresentation | undefined,
): CustodianQrPresentation | null {
  const expiresAtMs =
    Number.isSafeInteger(presentation?.expiresAtMs) && (presentation?.expiresAtMs ?? -1) >= 0
      ? presentation?.expiresAtMs
      : undefined;
  const dataUrl =
    expiresAtMs === undefined ? undefined : parseCustodianQrPngDataUrl(presentation?.dataUrl);
  const question = parseCustodianQuestion(presentation?.question);
  return presentation?.kind === "qr" &&
    presentation.wizardInputPending &&
    expiresAtMs !== undefined &&
    dataUrl !== undefined &&
    question?.presentation === "action" &&
    !question.isOther &&
    !question.allowSkip &&
    question.skipAction === undefined
    ? { dataUrl, expiresAtMs, question }
    : null;
}

export class CustodianQrExpiry {
  private timer: ReturnType<typeof setTimeout> | undefined;
  expiresAtMs: number | undefined;

  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.expiresAtMs = undefined;
  }

  schedule(expiresAtMs: number, onExpire: () => void): void {
    this.clear();
    this.expiresAtMs = expiresAtMs;
    // Rearm long deadlines in timer-safe chunks; passing the full wire timestamp
    // delta can overflow setTimeout and retire a still-valid credential immediately.
    const waitForExpiry = () => {
      const remainingMs = Math.max(0, expiresAtMs - Date.now());
      if (remainingMs === 0) {
        this.timer = undefined;
        this.expiresAtMs = undefined;
        onExpire();
        return;
      }
      this.timer = setTimeout(waitForExpiry, Math.min(remainingMs, MAX_TIMER_TIMEOUT_MS));
    };
    waitForExpiry();
  }
}
