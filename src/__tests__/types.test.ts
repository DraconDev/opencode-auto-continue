import { describe, it, expect } from "vitest";
import {
  extractSessionId,
  isSyntheticEvent,
  isTextPart,
  isReasoningPart,
  isToolPart,
  isStepFinishPart,
  isFilePart,
  isCompactionPart,
  isStepStartPart,
  type PluginEvent,
  type PartInfo,
} from "../types.js";

describe("types.ts", () => {
  describe("extractSessionId", () => {
    it("should extract sessionID from properties.sessionID", () => {
      const event: PluginEvent = {
        type: "session.status",
        properties: { sessionID: "ses_123" },
      };
      expect(extractSessionId(event)).toBe("ses_123");
    });

    it("should extract sessionID from properties.info.sessionID", () => {
      const event: PluginEvent = {
        type: "session.created",
        properties: { info: { sessionID: "ses_456", id: "ses_456" } },
      };
      expect(extractSessionId(event)).toBe("ses_456");
    });

    it("should extract sessionID from properties.part.sessionID", () => {
      const event: PluginEvent = {
        type: "message.part.updated",
        properties: { part: { sessionID: "ses_789", id: "p1" } },
      };
      expect(extractSessionId(event)).toBe("ses_789");
    });

    it("should return undefined when no sessionID found", () => {
      const event: PluginEvent = {
        type: "unknown.event",
        properties: { foo: "bar" },
      };
      expect(extractSessionId(event)).toBeUndefined();
    });

    it("should return undefined for empty properties", () => {
      const event: PluginEvent = {
        type: "test",
        properties: {},
      };
      expect(extractSessionId(event)).toBeUndefined();
    });
  });

  describe("isSyntheticEvent", () => {
    it("should detect synthetic from properties.synthetic", () => {
      const event: PluginEvent = {
        type: "message.updated",
        properties: { synthetic: true, info: {} },
      };
      expect(isSyntheticEvent(event)).toBe(true);
    });

    it("should detect synthetic from properties.info.synthetic", () => {
      const event: PluginEvent = {
        type: "message.updated",
        properties: { info: { synthetic: true } },
      };
      expect(isSyntheticEvent(event)).toBe(true);
    });

    it("should detect synthetic from properties.part.synthetic", () => {
      const event: PluginEvent = {
        type: "message.part.updated",
        properties: { part: { synthetic: true } },
      };
      expect(isSyntheticEvent(event)).toBe(true);
    });

    it("should detect synthetic from nested parts array", () => {
      const event: PluginEvent = {
        type: "message.updated",
        properties: {
          info: {
            parts: [{ synthetic: true }, { synthetic: false }],
          },
        },
      };
      expect(isSyntheticEvent(event)).toBe(true);
    });

    it("should return false for non-synthetic events", () => {
      const event: PluginEvent = {
        type: "message.updated",
        properties: { info: { role: "user" } },
      };
      expect(isSyntheticEvent(event)).toBe(false);
    });
  });

  describe("Part type guards", () => {
    const basePart: PartInfo = {
      id: "p1",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "text",
      text: "hello",
    };

    it("isTextPart should identify text parts", () => {
      expect(isTextPart({ ...basePart, type: "text" })).toBe(true);
      expect(isTextPart({ ...basePart, type: "tool" })).toBe(false);
    });

    it("isReasoningPart should identify reasoning parts", () => {
      expect(isReasoningPart({ ...basePart, type: "reasoning" })).toBe(true);
      expect(isReasoningPart({ ...basePart, type: "text" })).toBe(false);
    });

    it("isToolPart should identify tool parts", () => {
      expect(isToolPart({ ...basePart, type: "tool" })).toBe(true);
      expect(isToolPart({ ...basePart, type: "text" })).toBe(false);
    });

    it("isStepFinishPart should identify step-finish parts", () => {
      expect(isStepFinishPart({ ...basePart, type: "step-finish", tokens: { input: 100, output: 50 } })).toBe(true);
      expect(isStepFinishPart({ ...basePart, type: "text" })).toBe(false);
    });

    it("isFilePart should identify file parts", () => {
      expect(isFilePart({ ...basePart, type: "file" })).toBe(true);
      expect(isFilePart({ ...basePart, type: "text" })).toBe(false);
    });

    it("isCompactionPart should identify compaction parts", () => {
      expect(isCompactionPart({ ...basePart, type: "compaction" })).toBe(true);
      expect(isCompactionPart({ ...basePart, type: "text" })).toBe(false);
    });

    it("isStepStartPart should identify step-start parts", () => {
      expect(isStepStartPart({ ...basePart, type: "step-start" })).toBe(true);
      expect(isStepStartPart({ ...basePart, type: "text" })).toBe(false);
    });
  });
});
