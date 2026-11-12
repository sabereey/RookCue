import { z } from "zod";

export const reviewTemplateIdSchema = z.enum([
  "five-whys",
  "aar",
  "kpt",
  "feynman",
]);

export type ReviewTemplateId = z.infer<typeof reviewTemplateIdSchema>;

export function renderChallengeQuestion(
  templateId: ReviewTemplateId | undefined,
  prompt: string,
): string {
  if (!templateId) {
    return prompt;
  }

  switch (templateId) {
    case "five-whys":
      return [
        "5 Whys challenge",
        "",
        `Starting point: ${prompt}`,
        "",
        "Answer by tracing the cause chain:",
        "1. Why did this happen?",
        "2. Why was that possible?",
        "3. Why did the earlier condition exist?",
        "4. Why was it not caught or corrected earlier?",
        "5. What root rule, assumption, or system condition should change?",
      ].join("\n");
    case "aar":
      return [
        "AAR challenge",
        "",
        `Focus: ${prompt}`,
        "",
        "Answer these prompts:",
        "- What was expected?",
        "- What actually happened?",
        "- What explains the gap?",
        "- What should be repeated or changed next time?",
      ].join("\n");
    case "kpt":
      return [
        "KPT challenge",
        "",
        `Focus: ${prompt}`,
        "",
        "Answer as Keep / Problem / Try:",
        "- Keep: what should continue?",
        "- Problem: what created friction or risk?",
        "- Try: what experiment should be attempted next?",
      ].join("\n");
    case "feynman":
      return [
        "Feynman challenge",
        "",
        `Concept: ${prompt}`,
        "",
        "Explain it simply:",
        "- What is the idea in plain language?",
        "- What part is still vague?",
        "- What concrete example proves you understand it?",
      ].join("\n");
  }
}

export function renderTransferAnswer(
  templateId: ReviewTemplateId | undefined,
  principle: string,
): string {
  if (!templateId) {
    return principle;
  }

  switch (templateId) {
    case "five-whys":
      return [
        "5 Whys transfer",
        "",
        `Principle: ${principle}`,
        "",
        "Root cause transfer:",
        "- What root condition does this principle address?",
        "- What signal would tell you to apply it again?",
      ].join("\n");
    case "aar":
      return [
        "AAR transfer",
        "",
        `Principle: ${principle}`,
        "",
        "Transfer notes:",
        "- Repeat when the expected/actual gap appears again.",
        "- Adapt when the context or evidence shape changes.",
      ].join("\n");
    case "kpt":
      return [
        "KPT transfer",
        "",
        `Principle: ${principle}`,
        "",
        "Transfer notes:",
        "- Keep: what behavior should continue?",
        "- Problem: what risk does the principle avoid?",
        "- Try: what next experiment validates it?",
      ].join("\n");
    case "feynman":
      return [
        "Feynman transfer",
        "",
        `Principle: ${principle}`,
        "",
        "Simple explanation: state the principle so it can be taught without the original task context.",
        "Concrete example: name a future situation where this principle should change behavior.",
      ].join("\n");
  }
}
