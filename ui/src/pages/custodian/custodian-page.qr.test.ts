/* @vitest-environment jsdom */

import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  CUSTODIAN_QR_DATA_URL,
  createContext,
  createCustodianQrPresentation,
  mountPage,
} from "./custodian-page.test-harness.ts";
import { CustodianQrExpiry } from "./custodian-qr.ts";

describe("custodian page QR presentation", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders a setup QR image without exposing its payload text", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Scan this code, then continue.",
        action: "none",
        presentation: createCustodianQrPresentation(),
      })
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Device linked.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() =>
      expect(page.querySelector<HTMLImageElement>(".custodian__qr-code img")).not.toBeNull(),
    );

    const image = page.querySelector<HTMLImageElement>(".custodian__qr-code img");
    expect(image?.getAttribute("src")).toBe(CUSTODIAN_QR_DATA_URL);
    expect(image?.getAttribute("alt")).toBe("Setup QR code");
    expect(page.textContent).not.toContain(CUSTODIAN_QR_DATA_URL);
    expect(page.querySelector(".option-card__skip")).toBeNull();

    page.querySelector<HTMLButtonElement>("[data-option-value]")?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await page.updateComplete;
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl !== undefined)).toBe(false);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ message: "Continue" });
  });

  it("retires the delivered QR image and action at its advertised deadline", async () => {
    vi.useFakeTimers();
    const expiresAtMs = Date.now() + 60_000;
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Scan this code, then continue.",
      action: "none",
      presentation: createCustodianQrPresentation(CUSTODIAN_QR_DATA_URL, expiresAtMs),
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;
    expect(page.querySelector(".custodian__qr-code")).not.toBeNull();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    await page.updateComplete;

    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(page.textContent).toContain("This setup QR code expired.");
    expect(page.store.messages.some((message) => message.qrDataUrl !== undefined)).toBe(false);
  });

  it("retires an already-expired QR synchronously", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    const onExpire = vi.fn();
    const expiry = new CustodianQrExpiry();

    expiry.schedule(Date.now(), onExpire);

    expect(onExpire).toHaveBeenCalledOnce();
    expect(expiry.expiresAtMs).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rearms a long QR expiry without retiring it at the timer limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T00:00:00Z"));
    const onExpire = vi.fn();
    const expiry = new CustodianQrExpiry();

    expiry.schedule(Date.now() + MAX_TIMER_TIMEOUT_MS + 5_000, onExpire);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);

    expect(onExpire).not.toHaveBeenCalled();
    expect(expiry.expiresAtMs).toBe(Date.now() + 5_000);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(expiry.expiresAtMs).toBeUndefined();
  });

  it.each([
    "https://attacker.example/qr.png",
    "data:image/png;base64,",
    "data:image/png;base64,A",
    "data:image/png;base64,AA=A",
    "data:image/png;base64,Zm9v",
    `data:image/png;base64,${"A".repeat(16_384)}`,
  ])("rejects an invalid QR image URL before rendering it", async (qrDataUrl) => {
    const request = vi.fn().mockResolvedValue({
      sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
      reply: "Continue setup.",
      action: "none",
      presentation: createCustodianQrPresentation(qrDataUrl),
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(page.textContent).toContain("Continue setup."));
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.querySelector("openclaw-option-card")).toBeNull();
    expect(page.store.wizardInputPending).toBe(false);
    expect(page.store.messages.some((message) => message.qrDataUrl !== undefined)).toBe(false);
  });

  it("restores QR bytes when acknowledgement delivery is explicitly unsent", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Scan this code.",
        action: "none",
        presentation: createCustodianQrPresentation(),
      })
      .mockRejectedValueOnce(new Error("request was not sent"));
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    page.querySelector<HTMLButtonElement>("[data-option-value]")?.click();

    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector(".custodian__qr-code")).not.toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl === CUSTODIAN_QR_DATA_URL)).toBe(
      true,
    );
  });

  it("keeps QR bytes scrubbed when acknowledgement delivery is uncertain", async () => {
    let rejectAcknowledgement!: (error: Error) => void;
    const acknowledgement = new Promise<never>((_resolve, reject) => {
      rejectAcknowledgement = reject;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Scan this code.",
        action: "none",
        presentation: createCustodianQrPresentation(),
      })
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return acknowledgement;
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    page.querySelector<HTMLButtonElement>("[data-option-value]")?.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl !== undefined)).toBe(false);

    rejectAcknowledgement(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "history persistence failed after send",
      }),
    );
    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector(".custodian__qr-code")).toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl !== undefined)).toBe(false);
  });

  it("starts a fresh session after an acknowledgement response is lost", async () => {
    let rejectAcknowledgement!: (error: Error) => void;
    const acknowledgement = new Promise<never>((_resolve, reject) => {
      rejectAcknowledgement = reject;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "qr-session",
        reply: "Scan this code.",
        action: "none",
        presentation: createCustodianQrPresentation(),
      })
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return acknowledgement;
      })
      .mockResolvedValueOnce({
        sessionId: "fresh-session",
        reply: "Fresh welcome.",
        action: "none",
      })
      .mockResolvedValueOnce({
        sessionId: "fresh-session",
        reply: "Safe next turn.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    page.querySelector<HTMLButtonElement>("[data-option-value]")?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    rejectAcknowledgement(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "response was lost after acknowledgement dispatch",
      }),
    );

    await waitForFast(() => expect(page.textContent).toContain("Fresh welcome."));
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(page.store.questionReplyUncertain).toBe(false);
    expect(page.querySelector(".custodian__qr-code")).toBeNull();

    await expect(page.store.send("typed after lost acknowledgement")).resolves.toBe("sent");
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      sessionId: "fresh-session",
      message: "typed after lost acknowledgement",
    });
    expect(page.textContent).toContain("Safe next turn.");
  });

  it.each([
    {
      label: "INVALID_REQUEST",
      error: { code: "INVALID_REQUEST", message: "invalid acknowledgement" },
    },
    {
      label: "FORBIDDEN",
      error: { code: "FORBIDDEN", message: "acknowledgement forbidden" },
    },
    ...["startup-sidecars", "gateway-suspending", "gateway-restarting"].map((reason) => ({
      label: reason,
      error: {
        code: "UNAVAILABLE" as const,
        message: "openclaw.chat was rejected before dispatch",
        retryable: true,
        details: { method: "openclaw.chat", reason },
      },
    })),
  ] as const)("restores the QR and action after a sent $label rejection", async ({ error }) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "control-ui-onboarding-00000000-0000-4000-8000-000000000001",
        reply: "Scan this code.",
        action: "none",
        presentation: createCustodianQrPresentation(),
      })
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        options?.onSent?.();
        return Promise.reject(new GatewayRequestError(error));
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.querySelector(".custodian__qr-code")).not.toBeNull());

    page.querySelector<HTMLButtonElement>("[data-option-value]")?.click();

    await waitForFast(() => expect(page.querySelector('[role="alert"]')).not.toBeNull());
    expect(page.querySelector(".custodian__qr-code")).not.toBeNull();
    expect(page.querySelector("openclaw-option-card")).not.toBeNull();
    expect(page.store.messages.some((message) => message.qrDataUrl === CUSTODIAN_QR_DATA_URL)).toBe(
      true,
    );
  });
});
