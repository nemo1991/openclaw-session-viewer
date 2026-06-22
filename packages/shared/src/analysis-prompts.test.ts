import { describe, it, expect } from "vitest";
import { ANALYSIS_TEMPLATES, getTemplateByKey } from "./analysis-prompts.js";

describe("ANALYSIS_TEMPLATES", () => {
  it("has 4 templates", () => {
    expect(ANALYSIS_TEMPLATES).toHaveLength(4);
  });

  it("all templates have unique keys", () => {
    const keys = new Set(ANALYSIS_TEMPLATES.map((t) => t.key));
    expect(keys.size).toBe(ANALYSIS_TEMPLATES.length);
  });

  it("all non-custom templates have defaultPrompt", () => {
    const nonCustom = ANALYSIS_TEMPLATES.filter((t) => t.key !== "custom");
    for (const t of nonCustom) {
      expect(t.defaultPrompt).toBeDefined();
      expect(t.defaultPrompt).toContain("{{context}}");
    }
  });

  it("custom template has no defaultPrompt", () => {
    const custom = getTemplateByKey("custom");
    expect(custom).toBeDefined();
    expect(custom!.defaultPrompt).toBeUndefined();
  });

  it("summary template is in Chinese", () => {
    const summary = getTemplateByKey("summary");
    expect(summary!.label).toBe("会话摘要");
  });

  it("all templates are streamable", () => {
    for (const t of ANALYSIS_TEMPLATES) {
      expect(t.streamable).toBe(true);
    }
  });
});

describe("getTemplateByKey", () => {
  it("returns template for valid key", () => {
    expect(getTemplateByKey("summary")).toBeDefined();
    expect(getTemplateByKey("code-changes")).toBeDefined();
    expect(getTemplateByKey("errors")).toBeDefined();
    expect(getTemplateByKey("custom")).toBeDefined();
  });

  it("returns undefined for invalid key", () => {
    expect(getTemplateByKey("nonexistent")).toBeUndefined();
  });
});