import { describe, expect, it } from "vitest";

import { DEFAULT_UI_LANGUAGE, MESSAGES, messages, stagedMilestones } from "../src/i18n";

/** Recursively collect string-keyed paths of an object. */
function paths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  if (Array.isArray(value)) return value.map((_, i) => `${prefix}[${i}]`);
  return Object.entries(value).flatMap(([key, child]) => paths(child, `${prefix}.${key}`));
}

/** Recursively collect leaf values (non-object, non-function). */
function leafValues(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [value];
  if (Array.isArray(value)) return value.flatMap(leafValues);
  return Object.values(value).flatMap(leafValues);
}

describe("i18n tables", () => {
  it("zh and en expose identical key structures", () => {
    expect(paths(MESSAGES.en)).toEqual(paths(MESSAGES.zh));
  });

  it("every plain leaf is a non-empty string in both languages", () => {
    for (const table of [MESSAGES.zh, MESSAGES.en]) {
      const leaves = leafValues(table).filter((leaf) => typeof leaf !== "function");
      expect(leaves.length).toBeGreaterThan(0);
      for (const leaf of leaves) {
        expect(typeof leaf === "string" && leaf.length > 0).toBe(true);
      }
    }
  });

  it("falls back to the default language for unknown values", () => {
    expect(DEFAULT_UI_LANGUAGE).toBe("zh");
    expect(messages("zh")).toBe(MESSAGES.zh);
    expect(messages("en")).toBe(MESSAGES.en);
  });
});

describe("stagedMilestones", () => {
  it("maps the ADR-003 amendment timings onto the localized texts", () => {
    for (const language of ["zh", "en"] as const) {
      const milestones = stagedMilestones(language);
      expect(milestones.map((m) => m.afterMs)).toEqual([8_000, 20_000, 40_000, 90_000]);
      expect(milestones.map((m) => m.text)).toEqual(MESSAGES[language].stagedMilestones);
    }
  });

  it("texts differ between languages (actually localized)", () => {
    expect(MESSAGES.zh.stagedMilestones).not.toEqual(MESSAGES.en.stagedMilestones);
  });
});
