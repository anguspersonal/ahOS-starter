import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import type { GeminiMessage } from "../lib/gemini.js";
import { TAB_PATHS } from "../lib/router.js";

let fixedMessages: GeminiMessage[] = [];

vi.mock("../lib/chatAction.js", () => ({
  useGeminiChat: () => ({
    messages: fixedMessages,
    isGenerating: false,
    error: null,
    model: "gemini-2.5-flash",
    setModel: () => {},
    apiKey: "k",
    setApiKey: () => {},
    sendMessage: async () => undefined,
    stopGenerating: () => {},
    clearChat: () => {},
  }),
}));

import { ChatView } from "../components/chat/ChatView.js";

function cleanRender(el: React.ReactElement): string {
  return renderToString(el).replace(/<!-- -->/g, "");
}

describe("chatPendingApprovalView", () => {
  it.each(["full", "mini"] as const)(
    "renders waiting for your approval and Approvals link in %s variant",
    (variant) => {
      fixedMessages = [
        {
          id: "m-1",
          role: "model",
          content: "Parked for approval.",
          toolCalls: [
            {
              name: "entity_crud",
              args: { operation: "bulk_delete" },
              status: "pending_approval",
              result: {
                status: "pending_approval",
                decision_id: "d-1",
                action_id: "entity_crud",
              },
            },
          ],
        },
      ];

      const html = cleanRender(<ChatView variant={variant} />);
      expect(html).toContain("waiting for your approval");
      expect(html).not.toContain(">success<");
      expect(html).not.toContain(">failed<");

      const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      const approvalsLinks = anchors.filter((m) => m[2].trim() === "Approvals");
      expect(approvalsLinks).toHaveLength(1);
      const attrs = approvalsLinks[0][1];
      expect(attrs).toContain(`href="${TAB_PATHS.approvals}"`);
      expect(attrs).toContain('target="_blank"');
      expect(attrs).toContain('rel="noopener noreferrer"');
    },
  );

  it("renders >success< and no >Approvals</a> for a success tool call", () => {
    fixedMessages = [
      {
        id: "m-2",
        role: "model",
        content: "Done.",
        toolCalls: [
          {
            name: "entity_crud",
            args: { operation: "get" },
            status: "success",
            result: { entity: { id: "e-1" } },
          },
        ],
      },
    ];

    const html = cleanRender(<ChatView variant="full" />);
    expect(html).toContain(">success<");
    expect(html).not.toContain(">Approvals</a>");
  });
});
