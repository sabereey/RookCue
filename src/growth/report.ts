import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { GrowthSnapshot } from "./schema.js";
import { assessQuality, type QualityAssessment } from "./quality.js";
import { deriveDueQueue, type DueItem } from "./recall.js";
import { recommendGrowth, type GrowthRecommendation } from "./recommendation.js";
import { collectReportSources, type GrowthReportEvent, type GrowthReportCoverage } from "./report-sources.js";
export type { GrowthReportEvent, GrowthReportGap, GrowthReportCoverage } from "./report-sources.js";

export type GrowthReportOptions = { period?: "week" | "month"; from?: string; to?: string };
export type GrowthReportBounds = { period: "week" | "month" | "custom"; from: string; to: string; requestedTo: string; endExclusive: true };
const optionsSchema = z.object({ period: z.enum(["week", "month"]).optional(), from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).strict();

export type GrowthReportSuggestion =
  | { kind: "recall" | "quality"; conceptId: string; revision: string; action: string; reason: string }
  | { kind: "review"; taskId: string; action: string; reason: string; recommendation: GrowthRecommendation };
export type GrowthReport = {
  schemaVersion: 1;
  ruleVersion: "growth-v1";
  generatedAt: string;
  bounds: GrowthReportBounds;
  coverage: GrowthReportCoverage;
  events: GrowthReportEvent[];
  counts: ReturnType<typeof eventCounts>;
  currentQuality: { asOf: string; scope: "current-at-generation"; items: QualityAssessment[] };
  currentDue: { asOf: string; scope: "current-at-generation"; items: DueItem[] };
  nextSuggestions: GrowthReportSuggestion[];
};

/** Deterministic composition of a supplied snapshot; no report or schedule is persisted. */
export function buildGrowthReport(snapshot: GrowthSnapshot, options: GrowthReportOptions, now: Date): GrowthReport {
  const bounds = reportBounds(options, now);
  const generatedAt = now.toISOString();
  const { events, coverage } = collectReportSources(snapshot, bounds.from, bounds.to, now);
  const quality = assessQuality(snapshot);
  const due = deriveDueQueue(snapshot, now).filter((item) => item.isDue);
  const nextSuggestions: GrowthReportSuggestion[] = [
    ...due.map((item) => ({ kind: "recall" as const, conceptId: item.conceptId, revision: item.revision, action: "Inspect the current concept and record an explicit human recall result.", reason: item.reason })),
    ...quality.flatMap((item) => {
      const actions = new Set<string>();
      return item.findings.filter((finding) => { if (actions.has(finding.correctiveAction)) return false; actions.add(finding.correctiveAction); return true; })
        .map((finding) => ({ kind: "quality" as const, conceptId: item.conceptId, revision: item.revision, action: finding.correctiveAction, reason: finding.message }));
    }),
    ...snapshot.tasks.filter((task) => task.status === "active" && Date.parse(task.startedAt) <= now.getTime())
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map((task) => ({ kind: "review" as const, taskId: task.id, action: "Inspect review advice for this active task and choose any level and method explicitly.",
        reason: "Advice uses only this task's stored metadata and related observed history.", recommendation: recommendGrowth(snapshot, { taskId: task.id }, now) })),
  ];
  return { schemaVersion: 1, ruleVersion: "growth-v1", generatedAt, bounds, coverage, events, counts: eventCounts(events),
    currentQuality: { asOf: generatedAt, scope: "current-at-generation", items: quality },
    currentDue: { asOf: generatedAt, scope: "current-at-generation", items: due }, nextSuggestions };
}

function eventCounts(events: GrowthReportEvent[]) {
  const count = (kind: GrowthReportEvent["kind"]) => events.filter((event) => event.kind === kind).length;
  const transitions = events.filter((event) => event.kind === "capability-transition");
  return { promotions: count("concept-promoted"), revisions: count("concept-revised"), completedReviews: count("review-completed"), methodUses: count("method-used"),
    recalls: { recalled: events.filter((event) => event.kind === "recall" && event.result === "recalled").length,
      partial: events.filter((event) => event.kind === "recall" && event.result === "partial").length,
      forgotten: events.filter((event) => event.kind === "recall" && event.result === "forgotten").length },
    deferrals: count("defer"), resumptions: count("resume"), capabilityBaselines: count("capability-baseline"), capabilityTransitions: transitions.length,
    capabilityRises: transitions.filter((event) => event.direction === "rise").length, capabilityDowngrades: transitions.filter((event) => event.direction === "downgrade").length,
    capabilityAssessments: count("capability-assessment") };
}

function reportBounds(options: GrowthReportOptions, now: Date): GrowthReportBounds {
  if (!Number.isFinite(now.getTime())) throw new DomainError("INVALID_GROWTH_REPORT", "Report clock must provide a valid date");
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw new DomainError("INVALID_GROWTH_REPORT", "Report period requires valid ISO timestamps or week/month");
  const input = parsed.data;
  if (input.from !== undefined || input.to !== undefined) {
    if (input.period !== undefined || input.from === undefined || input.to === undefined) throw new DomainError("INVALID_GROWTH_REPORT", "Choose a calendar period or a complete custom range");
    const start = Date.parse(input.from);
    const end = Date.parse(input.to);
    if (start >= end || start >= now.getTime()) throw new DomainError("INVALID_GROWTH_REPORT", "Custom range must be increasing and include observed time before the clock");
    return { period: "custom", from: new Date(start).toISOString(), to: new Date(Math.min(end, now.getTime())).toISOString(), requestedTo: new Date(end).toISOString(), endExclusive: true };
  }
  const period = input.period ?? "week";
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (period === "week") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  else start.setUTCDate(1);
  const end = new Date(start);
  if (period === "week") end.setUTCDate(end.getUTCDate() + 7);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return { period, from: start.toISOString(), to: now.toISOString(), requestedTo: end.toISOString(), endExclusive: true };
}

/** Render report facts without reading source files or using the wall clock. */
export function renderGrowthReport(report: GrowthReport): string {
  const { bounds, counts } = report;
  const lines = ["# Personal growth report", "", `Schema: ${report.schemaVersion}; rules: ${report.ruleVersion}; generated at: ${report.generatedAt}.`,
    `Observed UTC ${bounds.period} period: [${bounds.from}, ${bounds.to}).`,
    `Requested UTC end: ${bounds.requestedTo}; events at the observed end are excluded.`, "",
    "Only dated stored events enter period totals. A baseline is not an improvement; assessments are not level rises. Human observations do not establish mastery or causal method impact.", "",
    "## Observed period totals", "", "| Event | Count |", "| --- | ---: |",
    ...Object.entries(counts).flatMap(([key, value]) => typeof value === "number" ? [`| ${key} | ${value} |`] : Object.entries(value).map(([outcome, total]) => `| recall ${outcome} | ${total} |`)),
    "", "## Source coverage", "", report.coverage.scope,
    `Selected project source: ${report.coverage.selectedProjectSourceId ?? "unknown (no stored source identity)"}.`,
    `Observed source IDs: ${report.coverage.sourceIds.map(markdown).join(", ") || "none"}.`, "",
    "| Source records | Count | IDs |", "| --- | ---: | --- |",
    ...Object.entries(report.coverage.records).map(([key, ids]) => `| ${key} | ${report.coverage.counts[key as keyof typeof report.coverage.counts]} | ${ids.map(markdown).join(", ") || "none"} |`),
    "", "### Coverage limitations", "",
    ...(report.coverage.gaps.length === 0 ? ["No additional gaps detected in the supplied records; coverage remains limited to the selected sources."]
      : report.coverage.gaps.map((gap) => `- ${markdown(gap.code)} (${gap.recordIds.map(markdown).join(", ") || "no records"}): ${markdown(gap.message)}`)),
    "", "## Observed events", "",
    ...(report.events.length === 0 ? ["No dated events were observed in this period."] : ["| UTC time | Event | Source record | Details |", "| --- | --- | --- | --- |",
      ...report.events.map((event) => `| ${event.at} | ${event.kind} | ${markdown(event.source.kind)}:${markdown(event.source.id)}${event.source.historyIndex === undefined ? "" : ` history[${event.source.historyIndex}]`}${event.source.revisionId ? ` revision ${event.source.revisionId}` : ""} | ${eventDetails(event)} |`)]),
    "", `## Current quality at generation time (${report.currentQuality.asOf})`, "",
    "This is the current documentation and evidence quality snapshot, not historical quality at the period end.", "",
    ...(report.currentQuality.items.length === 0 ? ["No active concepts are available for assessment."] : ["| Concept | Quality range | Coverage | Findings |", "| --- | --- | --- | ---: |",
      ...report.currentQuality.items.map((item) => `| ${markdown(item.conceptId)} | ${item.range.min}–${item.range.max}/100 | ${item.coverage} | ${item.findings.length} |`)]),
    "", `## Current due queue at generation time (${report.currentDue.asOf})`, "",
    "This queue uses the generation clock, not the historical period end. Recall feedback is human reported.", "",
    ...(report.currentDue.items.length === 0 ? ["No concepts are currently due in the supplied snapshot."] : ["| Concept | Due at UTC | Reason |", "| --- | --- | --- |",
      ...report.currentDue.items.map((item) => `| ${markdown(item.conceptId)} | ${item.dueAt ?? "unknown; needs baseline"} | ${item.reason}${item.warnings.length ? `; ${item.warnings.map(markdown).join("; ")}` : ""} |`)]),
    "", "## Next suggestions", "",
    ...(report.nextSuggestions.length === 0 ? ["No actionable suggestions can be derived from the available records."] : report.nextSuggestions.map((suggestion) => {
      const target = suggestion.kind === "review" ? suggestion.taskId : suggestion.conceptId;
      const advice = suggestion.kind === "review" ? ` Suggested review level: ${suggestion.recommendation.level}; method: ${suggestion.recommendation.suggestedMethod ?? "none"}; alternatives: ${suggestion.recommendation.alternatives.join(", ") || "none"}. Suggestions require an explicit human choice.` : "";
      return `- ${markdown(target)}: ${markdown(suggestion.action)} ${markdown(suggestion.reason)}${advice}`;
    })), "",
  ];
  return lines.join("\n");
}

function eventDetails(event: GrowthReportEvent): string {
  return [event.conceptId && `concept ${event.conceptId}`, event.sourceId && `source ${event.sourceId}`, event.taskId && `task ${event.taskId}`, event.reviewId && `review ${event.reviewId}`,
    event.templateId && `template ${event.templateId}`, event.result && `human recall ${event.result}`, event.until && `until ${event.until}`,
    event.newLevel && `${event.previousLevel ?? "unknown prior level"} → ${event.newLevel} (${event.direction})`, ...(event.warnings ?? [])].filter((value): value is string => Boolean(value)).map(markdown).join("; ");
}
function markdown(text: string): string { return text.replace(/\\/g, "\\\\").replace(/[|`*_<>\[\]]/g, "\\$&").replace(/[\r\n]+/g, " "); }
