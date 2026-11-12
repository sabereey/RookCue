import {
  reviewRecommendationSchema,
  type ReviewRecommendation,
  type ReviewSignal,
} from "../domain/schema.js";

const weights: Record<ReviewSignal, number> = {
  "architecture-change": 3,
  "rule-change": 3,
  "failure-or-rework": 3,
  "unfamiliar-technology": 2,
  "transferable-learning": 2,
  "ai-heavy": 1,
};

const reasons: Record<ReviewSignal, string> = {
  "architecture-change":
    "Architecture is changing, so a deeper review helps verify the new shape.",
  "rule-change":
    "The rules changed, so the updated behavior needs a deeper pass.",
  "failure-or-rework":
    "Failure or rework surfaced, so the fix path deserves a deeper review.",
  "unfamiliar-technology":
    "Unfamiliar technology raises interpretation risk, so a deeper review is safer.",
  "transferable-learning":
    "There is reusable learning here, so a deeper review can capture it clearly.",
  "ai-heavy":
    "AI did most of the work, so a quick review can confirm the human checks.",
};

export function recommendReview(
  signals: ReviewSignal[],
): ReviewRecommendation {
  const uniqueSignals = unique(signals);
  const score = uniqueSignals.reduce((total, signal) => total + weights[signal], 0);
  const level = score === 0 ? "skip" : score === 1 ? "quick" : "deep";
  const recommendation = {
    level,
    score,
    reasons:
      level === "skip"
        ? []
        : uniqueSignals.map((signal) => reasons[signal]),
    signals: uniqueSignals,
  };

  return reviewRecommendationSchema.parse(recommendation);
}

function unique(signals: ReviewSignal[]): ReviewSignal[] {
  const seen = new Set<ReviewSignal>();
  const uniqueSignals: ReviewSignal[] = [];

  for (const signal of signals) {
    if (seen.has(signal)) {
      continue;
    }

    seen.add(signal);
    uniqueSignals.push(signal);
  }

  return uniqueSignals;
}
