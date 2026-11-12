import { describe, expect, it } from "vitest";

import { recommendReview } from "../../src/review/recommendation.js";
import type { ReviewSignal } from "../../src/domain/schema.js";

describe("review/recommendation", () => {
  it.each([
    { signals: [], level: "skip", score: 0 },
    { signals: ["ai-heavy"], level: "quick", score: 1 },
    {
      signals: ["unfamiliar-technology", "ai-heavy"],
      level: "deep",
      score: 3,
    },
    { signals: ["architecture-change"], level: "deep", score: 3 },
    { signals: ["failure-or-rework"], level: "deep", score: 3 },
  ] as const)(
    "recommends an explainable level for %o",
    ({ signals, level, score }) => {
      const recommendation = recommendReview([...signals] as ReviewSignal[]);

      expect(recommendation).toMatchObject({
        level,
        score,
        signals,
      });

      if (level === "skip") {
        expect(recommendation.reasons).toEqual([]);
        return;
      }

      expect(recommendation.reasons.length).toBeGreaterThan(0);
      for (const reason of recommendation.reasons) {
        expect(reason).toEqual(expect.any(String));
        expect(reason.trim()).not.toHaveLength(0);
      }
    },
  );

  it("counts duplicate signals only once and preserves first-seen order", () => {
    expect(
      recommendReview([
        "ai-heavy",
        "architecture-change",
        "ai-heavy",
        "architecture-change",
      ]),
    ).toMatchObject({
      level: "deep",
      score: 4,
      signals: ["ai-heavy", "architecture-change"],
    });
  });
});
