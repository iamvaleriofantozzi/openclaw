// Telegram tests cover button types plugin behavior.
import { buildApprovalResolutionRef } from "openclaw/plugin-sdk/approval-reference-runtime";
import { describe, expect, it } from "vitest";
import { parseTelegramApprovalCallbackData } from "./approval-callback-data.js";
import {
  buildTelegramPresentationButtons,
  parseTelegramInlineButtons,
  resolveTelegramInlineButtons,
} from "./button-types.js";
import { describeTelegramInteractiveButtonBehavior } from "./button-types.test-helpers.js";
import {
  buildTelegramOpaqueCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";

describeTelegramInteractiveButtonBehavior();

describe("parseTelegramInlineButtons", () => {
  const callbackData = "😀".repeat(16);
  const nativeButtons = [[{ text: "  Native  ", callback_data: callbackData, style: "primary" }]];

  it.each([
    { name: "native rows", value: nativeButtons },
    { name: "JSON-encoded rows", value: JSON.stringify(nativeButtons) },
  ])("parses $name and validates the UTF-8 callback boundary", ({ value }) => {
    expect(parseTelegramInlineButtons(value)).toEqual([
      [{ text: "Native", callback_data: callbackData, style: "primary" }],
    ]);
  });

  it("strips private assistant scaffolding from visible native button labels", () => {
    expect(
      parseTelegramInlineButtons([
        [
          { text: "<think>private reasoning</think>Approve", callback_data: "approve" },
          {
            text: "<relevant-memories>private context</relevant-memories>Decline",
            callback_data: "decline",
          },
          {
            text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>private runtime context<<<END_OPENCLAW_INTERNAL_CONTEXT>>>Review",
            callback_data: "review",
          },
        ],
      ]),
    ).toEqual([
      [
        { text: "Approve", callback_data: "approve" },
        { text: "Decline", callback_data: "decline" },
        { text: "Review", callback_data: "review" },
      ],
    ]);
  });

  it("preserves opaque callback bytes without trimming or adding typed-action envelopes", () => {
    const whitespaceBoundaryCallback = ` ${"😀".repeat(15)}ab `;
    expect(
      parseTelegramInlineButtons([
        [
          { text: "Space", callback_data: " " },
          { text: "Newline", callback_data: "\n" },
          { text: "Whitespace", callback_data: " next " },
          { text: "Opaque", callback_data: "acme:task|prod" },
          { text: "Boundary", callback_data: whitespaceBoundaryCallback },
        ],
      ]),
    ).toEqual([
      [
        { text: "Space", callback_data: " " },
        { text: "Newline", callback_data: "\n" },
        { text: "Whitespace", callback_data: " next " },
        { text: "Opaque", callback_data: "acme:task|prod" },
        { text: "Boundary", callback_data: whitespaceBoundaryCallback },
      ],
    ]);
  });

  it.each([
    { name: "typed approval", value: "tga1:e:o:plugin:request" },
    { name: "malformed typed approval", value: "tga1:" },
    { name: "whitespace-disguised typed approval", value: " tga1:e:o:request " },
    { name: "typed question", value: "tgq1:ask_0123456789abcdef0123456789abcdef:0" },
    { name: "malformed typed question", value: "tgq1:" },
    { name: "whitespace-disguised typed question", value: " \ntgq1:ask_id:0\t " },
    { name: "native command envelope", value: "tgcmd:/status" },
    { name: "whitespace-disguised native command", value: " tgcmd:/status " },
    { name: "opaque typed envelope", value: buildTelegramOpaqueCallbackData("custom:value") },
    { name: "malformed opaque envelope", value: "tgcb1:" },
    { name: "whitespace-disguised opaque envelope", value: " \ntgcb1:fake:value\t " },
    { name: "arbitrary slash command", value: "/status" },
    { name: "whitespace-disguised slash command", value: " \n/status\t " },
    { name: "slash approval", value: "/approve request allow-always" },
    { name: "slashless approval alias", value: "approve request always" },
    { name: "case-insensitive approval", value: " APPROVE@bot request DeNy " },
    { name: "plugin-binding approval", value: "pluginbind:request:a" },
    { name: "malformed plugin-binding approval", value: " pluginbind: " },
    { name: "managed multiselect", value: "OC_MULTI|toggle|env|prod" },
    { name: "malformed managed multiselect", value: "OC_MULTI|" },
    { name: "whitespace-disguised managed multiselect", value: " OC_MULTI|clear " },
    { name: "managed select", value: "OC_SELECT|env|prod" },
    { name: "whitespace-disguised managed select", value: "\nOC_SELECT|env|prod " },
    { name: "model selection", value: "mdl_sel_openai/gpt-5" },
    { name: "malformed model selection", value: "mdl_" },
    { name: "whitespace-disguised model selection", value: " mdl_prov\n" },
    { name: "commands pagination", value: "commands_page_2:private-agent" },
    { name: "malformed commands pagination", value: "commands_page_" },
    { name: "whitespace-disguised commands pagination", value: " commands_page_2\n" },
  ])("rejects $name impersonation from model-authored callback buttons", ({ value }) => {
    expect(() =>
      parseTelegramInlineButtons([[{ text: "System control", callback_data: value }]]),
    ).toThrow(/reserved Telegram runtime namespace; use typed presentation actions/);
  });

  it("keeps explicit empty rows ahead of interactive and presentation buttons", () => {
    expect(
      resolveTelegramInlineButtons({
        buttons: parseTelegramInlineButtons([]),
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
        },
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Portable", value: "portable" }] }],
        },
      }),
    ).toEqual([]);
  });

  it.each([
    { name: "invalid JSON", value: "[", message: /valid JSON button rows/ },
    { name: "non-array JSON", value: "{}", message: /array of button rows/ },
    { name: "malformed row", value: [{ text: "OK" }], message: /buttons\[0\].*array/ },
    { name: "empty row", value: [[]], message: /buttons\[0\].*non-empty/ },
    { name: "malformed button", value: [[null]], message: /buttons\[0\]\[0\].*object/ },
    {
      name: "empty text",
      value: [[{ text: " ", callback_data: "ok" }]],
      message: /\.text must be a non-empty string/,
    },
    {
      name: "private-only text",
      value: [[{ text: "<think>private reasoning</think>", callback_data: "ok" }]],
      message: /\.text must be a non-empty string/,
    },
    {
      name: "private-only runtime context",
      value: [
        [
          {
            text: "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>private runtime context<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
            callback_data: "ok",
          },
        ],
      ],
      message: /\.text must be a non-empty string/,
    },
    {
      name: "empty callback",
      value: [[{ text: "OK", callback_data: "" }]],
      message: /\.callback_data must be a non-empty string/,
    },
    {
      name: "65-byte UTF-8 callback",
      value: [[{ text: "OK", callback_data: `${callbackData}x` }]],
      message: /at most 64 UTF-8 bytes/,
    },
    {
      name: "65-byte callback with leading whitespace",
      value: [[{ text: "OK", callback_data: ` ${callbackData}` }]],
      message: /at most 64 UTF-8 bytes/,
    },
    {
      name: "unsupported style",
      value: [[{ text: "OK", callback_data: "ok", style: "secondary" }]],
      message: /\.style must be danger, success, or primary/,
    },
    {
      name: "unsupported field",
      value: [[{ text: "OK", callback_data: "ok", url: "https://example.com" }]],
      message: /\.url is unsupported/,
    },
  ])("rejects $name with actionable button coordinates", ({ value, message }) => {
    expect(() => parseTelegramInlineButtons(value)).toThrow(message);
  });
});

describe("buildTelegramInteractiveButtons callback limits", () => {
  it("drops buttons whose callback payload exceeds Telegram limits", () => {
    expect(
      resolveTelegramInlineButtons({
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Keep", value: "ok" },
                { label: "Drop", value: `x${"y".repeat(80)}` },
              ],
            },
          ],
        },
      }),
    ).toEqual([[{ text: "Keep", callback_data: "ok", style: undefined }]]);
  });
});

describe("buildTelegramPresentationButtons", () => {
  it("builds inline buttons from presentation blocks", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          { type: "text", text: "Choose" },
          {
            type: "buttons",
            buttons: [{ label: "Approve", value: "/approve req-1 allow-once", style: "success" }],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Approve",
          callback_data: "/approve req-1 allow-once",
          style: "success",
        },
      ],
    ]);
  });

  it("encodes question buttons by record id and option index", () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: ["Staging", "Production"].map((label) => ({
              label,
              action: { type: "question" as const, questionId, optionValue: label },
            })),
          },
        ],
      }),
    ).toEqual([
      [
        { text: "Staging", callback_data: `tgq1:${questionId}:0`, style: undefined },
        { text: "Production", callback_data: `tgq1:${questionId}:1`, style: undefined },
      ],
    ]);
  });

  it("drops presentation buttons whose callback payload exceeds Telegram limits", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Keep",
                action: { type: "command", command: "/codex plugins menu" },
              },
              {
                label: "Drop",
                action: {
                  type: "command",
                  command: `/codex plugins enable ${"x".repeat(80)}`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Keep",
          callback_data: "tgcmd:/codex plugins menu",
          style: undefined,
        },
      ],
    ]);
  });

  it("keeps legacy raw slash-valued callbacks as callbacks", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Raw", value: "/not-a-native-command" }],
          },
        ],
      }),
    ).toEqual([[{ text: "Raw", callback_data: "/not-a-native-command", style: undefined }]]);
  });

  it("marks typed callbacks as opaque callback data", () => {
    const callbackData = buildTelegramOpaqueCallbackData("/not-a-native-command");

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Raw", action: { type: "callback", value: "/not-a-native-command" } },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Raw", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe("/not-a-native-command");
  });

  it("keeps legacy values that look like opaque callback prefixes raw", () => {
    expect(parseTelegramOpaqueCallbackData("tgcb1:inspect:123")).toBeNull();
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Raw", value: "tgcb1:inspect:123" }],
          },
        ],
      }),
    ).toEqual([[{ text: "Raw", callback_data: "tgcb1:inspect:123", style: undefined }]]);
  });

  it("keeps transport-private approval callback prefixes opaque for legacy values", () => {
    const value = "tga1:e:x:not-a-typed-action";
    const callbackData = buildTelegramOpaqueCallbackData(value);

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Plugin", value }],
          },
        ],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramApprovalCallbackData(callbackData)).toBeNull();
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe(value);
  });

  it("keeps transport-private question callback prefixes opaque for legacy values", () => {
    const value = "tgq1:ask_0123456789abcdef0123456789abcdef:0";
    const callbackData = buildTelegramOpaqueCallbackData(value);

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Plugin", value }],
          },
        ],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe(value);
  });

  it("keeps trimmed transport-private question prefixes opaque", () => {
    const value = " tgq1:ask_0123456789abcdef0123456789abcdef:0 ";
    const callbackData = buildTelegramOpaqueCallbackData(value);

    expect(
      buildTelegramPresentationButtons({
        blocks: [{ type: "buttons", buttons: [{ label: "Plugin", value }] }],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe(value);
  });

  it("keeps shortened plugin approval callbacks on the approval bypass path", () => {
    const approvalId = `plugin:${"a".repeat(36)}`;
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Allow", value: `/approve ${approvalId} allow-always` }],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow",
          callback_data: `/approve ${approvalId} always`,
          style: undefined,
        },
      ],
    ]);
  });

  it("keeps typed commands distinct from typed approval callbacks", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow",
                action: { type: "command", command: "/approve req-1 allow-once" },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow",
          callback_data: "tgcmd:/approve req-1 allow-once",
          style: undefined,
        },
      ],
    ]);
  });

  it("shortens legacy allow-always before prefixing and retains the approval overflow path", () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const approvalId = `plugin:${"a".repeat(36)}`;

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Always",
                action: {
                  type: "command",
                  command: `/approve ${uuid} allow-always`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Always",
          callback_data: `tgcmd:/approve ${uuid} always`,
          style: undefined,
        },
      ],
    ]);
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Always",
                action: {
                  type: "command",
                  command: `/approve ${approvalId} allow-always`,
                },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Always",
          callback_data: `/approve ${approvalId} always`,
          style: undefined,
        },
      ],
    ]);
  });

  it("keeps approval-shaped typed callbacks opaque", () => {
    const callbackData = buildTelegramOpaqueCallbackData("/approve plugin:123 allow-once");

    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Plugin",
                action: { type: "callback", value: "/approve plugin:123 allow-once" },
              },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Plugin", callback_data: callbackData, style: undefined }]]);
  });

  it("encodes typed approvals with explicit kind, decision, and exact id", () => {
    const buttons = buildTelegramPresentationButtons({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow",
              action: {
                type: "approval",
                approvalId: "plugin:id/with:delimiters",
                approvalKind: "exec",
                decision: "allow-always",
              },
              style: "success",
            },
          ],
        },
      ],
    });

    expect(buttons).toEqual([
      [
        {
          text: "Allow",
          callback_data: "tga1:e:a:plugin:id/with:delimiters",
          style: "success",
        },
      ],
    ]);
    expect(parseTelegramApprovalCallbackData(buttons?.[0]?.[0]?.callback_data)).toEqual({
      type: "approval",
      approvalId: "plugin:id/with:delimiters",
      approvalKind: "exec",
      decision: "allow-always",
    });
  });

  it("compacts an overlong approval callback and keeps the Review URL", () => {
    const approvalId = "x".repeat(56);
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow",
                action: {
                  type: "approval",
                  approvalId,
                  approvalKind: "exec",
                  decision: "allow-once",
                },
              },
              {
                label: "Review",
                action: { type: "url", url: "https://gateway.example/approve/long-id" },
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow",
          callback_data: `tga1:e:o:${buildApprovalResolutionRef({ approvalId, approvalKind: "exec" })}`,
          style: undefined,
        },
        {
          text: "Review",
          url: "https://gateway.example/approve/long-id",
          style: undefined,
        },
      ],
    ]);
  });

  it("renders typed and legacy URL and Web App actions natively", () => {
    expect(
      buildTelegramPresentationButtons(
        {
          blocks: [
            {
              type: "buttons",
              buttons: [
                { label: "Typed URL", action: { type: "url", url: "https://example.com/typed" } },
                {
                  label: "Typed App",
                  action: { type: "web-app", url: "https://example.com/app" },
                },
                { label: "Legacy URL", url: "https://example.com/legacy" },
                { label: "Legacy App", webApp: { url: "https://example.com/legacy-app" } },
              ],
            },
          ],
        },
        { allowWebAppButtons: true },
      ),
    ).toEqual([
      [
        { text: "Typed URL", url: "https://example.com/typed", style: undefined },
        {
          text: "Typed App",
          web_app: { url: "https://example.com/app" },
          style: undefined,
        },
        { text: "Legacy URL", url: "https://example.com/legacy", style: undefined },
      ],
      [
        {
          text: "Legacy App",
          web_app: { url: "https://example.com/legacy-app" },
          style: undefined,
        },
      ],
    ]);
  });

  it("skips Web App actions unless a direct target was confirmed", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "App", action: { type: "web-app", url: "https://example.com/app" } },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("skips hosted widget actions without a Telegram web app URL", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Hosted widget",
                action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("lets canonical typed actions override deprecated button fields", () => {
    expect(
      buildTelegramPresentationButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Open",
                action: { type: "url", url: "https://example.com/canonical" },
                value: "legacy-callback",
                url: "https://example.com/legacy",
              },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Open", url: "https://example.com/canonical", style: undefined }]]);
  });
});
