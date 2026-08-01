import type { SystemAgentChatPresentation } from "@openclaw/gateway-protocol";
import { QR_PNG_DATA_URL_MAX_LENGTH } from "@openclaw/gateway-protocol/schema";
import { parseCustodianQuestion, type CustodianStructuredQuestion } from "./structured-question.ts";

const QR_PNG_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/u;

function parseCustodianQrPngDataUrl(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= QR_PNG_DATA_URL_MAX_LENGTH &&
    QR_PNG_DATA_URL_PATTERN.test(value)
    ? value
    : undefined;
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
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.expiresAtMs = undefined;
        onExpire();
      },
      Math.max(0, expiresAtMs - Date.now()),
    );
  }
}
