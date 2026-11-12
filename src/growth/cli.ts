import type { Command } from 'commander';
import { z } from 'zod';
import { reviewSignalSchema, taskTypeSchema, type EvidenceRef } from '../domain/schema.js';
import type { GrowthService } from './service.js';
import { renderGrowthReport } from './report.js';
type CommonOptions = {
    project: string;
    personal?: string;
    json?: boolean;
};
type Helpers = {
    createServices(project: string, personal?: string): {
        growthService: GrowthService;
    };
    addProjectOption(command: Command): Command;
    addPersonalOption(command: Command): Command;
    addJsonOption(command: Command): Command;
    respondSuccess(json: boolean, data: unknown): void;
    respondText(json: boolean, data: unknown, text: string): void;
    parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, code: string, message: string): T;
    parseEvidenceTokens(values?: string[]): EvidenceRef[];
    inputError(message: string): Error;
};
/** Register against the host CLI's services, parsers, and output/error contract. */
export function registerGrowthCommands(program: Command, h: Helpers): void {
    const growth = program.command('growth').description('local personal growth advice and human feedback');
    const command = (name: string) => h.addJsonOption(h.addPersonalOption(h.addProjectOption(growth.command(name))));
    const service = (o: CommonOptions) => h.createServices(o.project, o.personal).growthService;
    command('quality').option('--concept <id>', 'inspect one concept').action(async (o: CommonOptions & {concept?: string}) => {
        const items = await service(o).quality(o.concept);
        h.respondText(Boolean(o.json), items, items.length ? items.map(item => `${item.conceptId}: documentation/evidence quality [${item.range.min}, ${item.range.max}]/100; coverage ${item.coverage}; ${item.status}\nRevision: ${item.revision}\n${item.findings.map(f => `${f.message} ${f.correctiveAction}`).join('\n')}`).join('\n') : 'No concepts.');
    });
    command('history').option('--concept <id>', 'inspect one concept').action(async (o: CommonOptions & {concept?: string}) => {
        const items = await service(o).history(o.concept);
        h.respondText(Boolean(o.json), items, items.length ? items.map(item => `${item.conceptId}: ${item.at} ${item.kind} ${item.previousLevel ?? 'unknown'} -> ${item.newLevel}; ${item.warnings.join(', ')}`).join('\n') : 'No capability history.');
    });
    command('due').action(async (o: CommonOptions) => {
        const items = await service(o).due();
        h.respondText(Boolean(o.json), items, items.length ? items.map(item => `${item.conceptId}: ${item.dueAt ?? 'needs baseline'} (${item.reason}); revision ${item.revision}; ${item.warnings.join(', ')}`).join('\n') : 'No due concepts.');
    });
    command('capture').action(async (o: CommonOptions) => {
        const result = await service(o).capture();
        h.respondText(Boolean(o.json), result, `Captured ${result.captured.length}; reused ${result.reused.length}; skipped ${result.skipped.length}.\n${result.skipped.map(s => `${s.taskId}/${s.reviewId}: ${s.taskStatus}, ${s.reason}`).join('\n')}`);
    });
    command('recommend').option('--task <id>', 'task').option('--type <type>', 'explicit task classification').option('--concept <id...>', 'related concepts').option('--signal <signal...>', 'current review signals').action(async (o: CommonOptions & {
        task?: string;
        type?: string;
        concept?: string[];
        signal?: string[];
    }) => {
        const advice = await service(o).recommend({ ...(o.task ? { taskId: o.task } : {}), ...(o.type ? { type: h.parseWithSchema(taskTypeSchema, o.type, 'INVALID_INPUT', 'Invalid task type') } : {}), ...(o.concept ? { conceptIds: o.concept } : {}), ...(o.signal ? { signals: o.signal.map(s => h.parseWithSchema(reviewSignalSchema, s, 'INVALID_INPUT', 'Invalid signal')) } : {}) });
        h.respondText(Boolean(o.json), advice, `${advice.level} (score ${advice.score}); ${advice.history.status}\n${advice.reasons.join('\n')}\n${advice.history.reason}\nSuggested method: ${advice.suggestedMethod ?? 'none'}; alternatives: ${advice.alternatives.join(', ')}\n${advice.methodReasons.join('\n')}`);
    });
    for (const kind of ['recall', 'defer', 'resume'] as const) {
        const c = command(kind).requiredOption('--concept <id>', 'concept').requiredOption('--revision <hash>', 'observed content fingerprint').requiredOption('--operation <id>', 'stable retry identity').requiredOption('--actor <actor>', 'human').requiredOption('--source <text>', 'actual human feedback source').option('--evidence <ref...>', 'existing evidence references');
        if (kind === 'recall')
            c.requiredOption('--result <result>', 'recalled|partial|forgotten');
        if (kind === 'defer')
            c.requiredOption('--until <ISO>', 'future postponement date');
        c.action(async (o: CommonOptions & {
            concept: string;
            revision: string;
            operation: string;
            actor: string;
            source: string;
            result?: string;
            until?: string;
            evidence?: string[];
        }) => {
            const actor = h.parseWithSchema(z.literal('human'), o.actor, 'INVALID_INPUT', 'Actor must be human');
            const result = o.result === undefined ? undefined : h.parseWithSchema(z.enum(['recalled', 'partial', 'forgotten']), o.result, 'INVALID_INPUT', 'Invalid recall result');
            h.respondSuccess(Boolean(o.json), await service(o).record({ kind, conceptId: o.concept, revision: o.revision, operationId: o.operation, actor, source: o.source, ...(result ? { result } : {}), ...(o.until ? { until: o.until } : {}), evidence: h.parseEvidenceTokens(o.evidence) }));
        });
    }
    command('report').option('--period <period>', 'week|month').option('--from <ISO>', 'inclusive UTC start').option('--to <ISO>', 'exclusive UTC end').option('--format <format>', 'markdown|json').action(async (o: CommonOptions & {
        period?: string;
        from?: string;
        to?: string;
        format?: string;
    }) => {
        const format = o.format === undefined ? undefined : h.parseWithSchema(z.enum(['markdown', 'json']), o.format, 'INVALID_INPUT', 'Invalid report format');
        if (format === 'markdown' && o.json)
            throw h.inputError('Explicit markdown format conflicts with --json');
        const period = o.period === undefined ? undefined : h.parseWithSchema(z.enum(['week', 'month']), o.period, 'INVALID_INPUT', 'Invalid period');
        const report = await service(o).report({ ...(period ? { period } : {}), ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}) });
        h.respondText(Boolean(o.json) || format === 'json', report, renderGrowthReport(report));
    });
}
