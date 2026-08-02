// Telegram plugin module implements button types behavior.
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { reduceLegacyInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  resolveMessagePresentationButtonAction,
  type LegacyInteractiveReply,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import {
  buildTelegramApprovalCallbackData,
  fitsTelegramCallbackData,
  hasTelegramApprovalCallbackPrefix,
  rewriteTelegramApprovalDecisionAlias,
  sanitizeTelegramCallbackData,
} from "./approval-callback-data.js";
import {
  buildTelegramNativeCommandCallbackData,
  buildTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import {
  buildTelegramQuestionCallbackData,
  hasTelegramQuestionCallbackPrefix,
} from "./question-callback-data.js";

export type TelegramButtonStyle = "danger" | "success" | "primary";

type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;
// Callback ingress trims before routing; reserve owner-controlled routes so
// model-authored buttons cannot impersonate commands or runtime controls.
const TELEGRAM_RESERVED_CALLBACK_ROUTE_RE =
  /^(?:\/|tgcmd:|tgcb1:|pluginbind:|OC_MULTI\||OC_SELECT\||mdl_|commands_page_)/u;

function toTelegramButtonStyle(style: unknown): TelegramButtonStyle | undefined {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

/** Parse the shipped native callback contract without rewriting callback envelopes. */
export function parseTelegramInlineButtons(value: unknown): TelegramInlineButtons | undefined {
  if (value === undefined) {
    return undefined;
  }
  let rows = value;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      throw new Error(
        'Telegram buttons must be valid JSON button rows, e.g. [[{"text":"OK","callback_data":"ok"}]].',
      );
    }
  }
  if (!Array.isArray(rows)) {
    throw new Error("Telegram buttons must be an array of button rows or a JSON-encoded array.");
  }
  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length === 0) {
      throw new Error(`Telegram buttons[${rowIndex}] must be a non-empty array of buttons.`);
    }
    return row.map((button, buttonIndex) => {
      const buttonPath = `Telegram buttons[${rowIndex}][${buttonIndex}]`;
      if (!isRecord(button)) {
        throw new Error(`${buttonPath} must be an object with text and callback_data.`);
      }
      const unsupported = Object.keys(button).find(
        (key) => key !== "text" && key !== "callback_data" && key !== "style",
      );
      if (unsupported) {
        throw new Error(
          `${buttonPath}.${unsupported} is unsupported; use text, callback_data, and optional style.`,
        );
      }
      const rawText = normalizeOptionalString(button.text);
      const text =
        rawText &&
        normalizeOptionalString(
          sanitizeForPlainText(sanitizeAssistantVisibleText(rawText), { style: "markdown" }),
        );
      if (!text) {
        throw new Error(`${buttonPath}.text must be a non-empty string.`);
      }
      const callbackData = button.callback_data;
      if (
        typeof callbackData !== "string" ||
        callbackData.length === 0 ||
        !fitsTelegramCallbackData(callbackData)
      ) {
        throw new Error(
          `${buttonPath}.callback_data must be a non-empty string of at most 64 UTF-8 bytes.`,
        );
      }
      const callbackRoute = callbackData.trim();
      if (
        hasTelegramApprovalCallbackPrefix(callbackRoute) ||
        hasTelegramQuestionCallbackPrefix(callbackRoute) ||
        parseExecApprovalCommandText(callbackRoute) !== null ||
        TELEGRAM_RESERVED_CALLBACK_ROUTE_RE.test(callbackRoute)
      ) {
        throw new Error(
          `${buttonPath}.callback_data uses a reserved Telegram runtime namespace; use typed presentation actions for system controls.`,
        );
      }
      const style = toTelegramButtonStyle(button.style);
      if (button.style !== undefined && !style) {
        throw new Error(`${buttonPath}.style must be danger, success, or primary.`);
      }
      return { text, callback_data: callbackData, ...(style ? { style } : {}) };
    });
  });
}

function toTelegramInlineButton(
  button: MessagePresentationButton,
  optionIndex: number,
  options?: { allowWebAppButtons?: boolean },
): TelegramInlineButton | undefined {
  const style = toTelegramButtonStyle(button.style);
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return undefined;
  }
  if (action.type === "url") {
    return { text: button.label, url: action.url, style };
  }
  if (action.type === "web-app") {
    return options?.allowWebAppButtons === true && action.url
      ? { text: button.label, web_app: { url: action.url }, style }
      : undefined;
  }
  if (action.type === "approval") {
    const callbackData = buildTelegramApprovalCallbackData(action);
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  if (action.type === "question") {
    const callbackData = buildTelegramQuestionCallbackData({
      questionId: action.questionId,
      optionIndex,
    });
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  if (action.type === "command") {
    const command = rewriteTelegramApprovalDecisionAlias(action.command.trim());
    const nativeCallbackData = command
      ? sanitizeTelegramCallbackData(buildTelegramNativeCommandCallbackData(command))
      : undefined;
    // Historical approval commands may consume the full callback budget. Preserve
    // their authorized raw-command path when tgcmd: is the only overflow.
    const callbackData =
      nativeCallbackData ??
      (parseExecApprovalCommandText(command) ? sanitizeTelegramCallbackData(command) : undefined);
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  // Reserve the full approval prefix, including malformed values, so legacy
  // plugin callbacks cannot be consumed by the approval handler.
  const normalizedCallbackValue = action.value.trim();
  const needsOpaqueEnvelope =
    Boolean(button.action) ||
    hasTelegramApprovalCallbackPrefix(normalizedCallbackValue) ||
    hasTelegramQuestionCallbackPrefix(normalizedCallbackValue);
  const callbackData = sanitizeTelegramCallbackData(
    needsOpaqueEnvelope ? buildTelegramOpaqueCallbackData(action.value) : action.value,
  );
  return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
}

function chunkInteractiveButtons(
  buttons: readonly MessagePresentationButton[],
  rows: TelegramInlineButton[][],
  options?: { allowWebAppButtons?: boolean },
) {
  // Index is position in the question's options; core emits one buttons block in option order.
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons
      .slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE)
      .map((button, offset) => toTelegramInlineButton(button, i + offset, options))
      .filter((button): button is TelegramInlineButton => Boolean(button));
    if (row.length > 0) {
      rows.push(row);
    }
  }
}

/**
 * @deprecated Use buildTelegramPresentationButtons with MessagePresentation.
 */
function buildTelegramInteractiveButtons(
  interactive?: LegacyInteractiveReply,
  options?: { allowWebAppButtons?: boolean },
): TelegramInlineButtons | undefined {
  const rows = reduceLegacyInteractiveReply(
    interactive,
    [] as TelegramInlineButton[][],
    (state, block) => {
      if (block.type === "buttons") {
        chunkInteractiveButtons(block.buttons, state, options);
        return state;
      }
      if (block.type === "select") {
        chunkInteractiveButtons(
          block.options.map((option) => ({
            label: option.label,
            action: option.action,
            value: option.value,
          })),
          state,
        );
      }
      return state;
    },
  );
  return rows.length > 0 ? rows : undefined;
}

/** Convert portable presentation controls to Telegram inline keyboard rows. */
export function buildTelegramPresentationButtons(
  presentation?: MessagePresentation,
  options?: { allowWebAppButtons?: boolean },
): TelegramInlineButtons | undefined {
  const rows: TelegramInlineButton[][] = [];
  for (const block of presentation?.blocks ?? []) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      continue;
    }
    if (block.type === "buttons") {
      chunkInteractiveButtons(block.buttons, rows, options);
      continue;
    }
    chunkInteractiveButtons(
      block.options.map((option) => ({
        label: option.label,
        action: option.action,
        value: option.value,
      })),
      rows,
    );
  }
  return rows.length > 0 ? rows : undefined;
}

/** Resolve Telegram inline buttons, preserving explicit and legacy button precedence. */
export function resolveTelegramInlineButtons(
  params: {
    buttons?: TelegramInlineButtons;
    presentation?: unknown;
    interactive?: unknown;
  },
  options?: { allowWebAppButtons?: boolean },
): TelegramInlineButtons | undefined {
  return (
    params.buttons ??
    buildTelegramInteractiveButtons(normalizeLegacyInteractiveReply(params.interactive), options) ??
    buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation), options)
  );
}
