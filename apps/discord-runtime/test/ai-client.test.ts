import { describe, expect, it } from "vitest";

import { GENERATION_TIMEOUT_MS } from "../src/ai-client";
import { stagedMilestones } from "../src/i18n";

describe("generation timeout", () => {
  it("outlasts the longest staged-status milestone", () => {
    const longestMilestone = Math.max(...stagedMilestones("zh").map((m) => m.afterMs));
    expect(GENERATION_TIMEOUT_MS).toBeGreaterThan(longestMilestone);
  });
});
