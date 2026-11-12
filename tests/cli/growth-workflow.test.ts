import {portableObservation, portableConcept} from '../fixtures/growth-assets.js';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.setConfig({testTimeout: 30000});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
function run(args: string[]) { return spawnSync(process.env.GROWTH_TEST_BINARY ?? process.execPath, [...(process.env.GROWTH_TEST_BINARY ? [] : ['dist/src/cli.js']), ...args], { encoding: 'utf8' }); }
function ok(args: string[]) { const r = run([...args, '--json']); expect(r.status, r.stdout + r.stderr).toBe(0); expect(r.stdout.trim().split('\n')).toHaveLength(1); const e = JSON.parse(r.stdout); expect(e.ok).toBe(true); return e.data; }
it('reads empty two-project shared roots without creating files and enforces report JSON error contracts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'growth-cli-'));
    roots.push(root);
    const personal = join(root, 'personal');
    for (const project of [join(root, 'a'), join(root, 'b')]) {
        for (const command of ['quality', 'due', 'history', 'recommend'])
            ok(['growth', command, '--project', project, '--personal', personal]);
        for (const format of [['--format', 'json'], ['--format=json']]) {
            const r = run(['growth', 'report', '--project', project, '--personal', personal, ...format, '--from', 'bad', '--to', 'bad']);
            expect(r.status).toBe(2);
            expect(JSON.parse(r.stdout).ok).toBe(false);
        }
        const conflict = run(['growth', 'report', '--project', project, '--personal', personal, '--format', 'markdown', '--json']);
        expect(conflict.status).toBe(64);
        await expect(access(project)).rejects.toThrow();
    }
    await expect(access(personal)).rejects.toThrow();
});
it('requires explicit human feedback fields before mutation', async () => {
    const r = run(['growth', 'recall', '--project', '/tmp/unused-growth-project', '--concept', 'c', '--result', 'recalled', '--json']);
    expect(r.status).toBe(64);
    expect(JSON.parse(r.stdout).ok).toBe(false);
});
it('completes human review/promotion, cross-project capture, voluntary feedback and reloaded history/report', async () => {
    const from = new Date(Date.now() - 60000).toISOString();
    const root = await mkdtemp(join(tmpdir(), 'growth-loop-'));
    roots.push(root);
    const personal = join(root, 'personal'), a = join(root, 'a'), b = join(root, 'b');
    const call = (project: string, args: string[]) => ok([...args, '--project', project, '--personal', personal]);
    // task/review commands historically have no personal option; supply only their supported flags.
    const local = (project: string, args: string[]) => ok([...args, '--project', project]);
    let conceptId = '';
    let revision = '';
    let lastReviewId = '';
    for (const [index, project] of [a, b].entries()) {
        const task = local(project, ['task', 'start', '--title', 'Fixture human task', '--goal', 'Review actual fixture evidence', '--type', 'implementation', ...(conceptId ? ['--concept', conceptId] : [])]);
        expect(task.type).toBe('implementation');
        const legacy = local(project, ['review', 'recommend', '--task', task.id]);
        expect(Object.keys(legacy).sort()).toEqual(['level', 'reasons', 'score', 'signals']);
        const advice = call(project, ['review', 'recommend', '--history', '--task', task.id]);
        expect(advice.history).toBeDefined();
        const review = local(project, ['review', 'start', '--task', task.id, '--level', 'deep']);
        if (index === 0)
            lastReviewId = review.id;
        expect(review.recommendation.history).toEqual(advice.history);
        expect(review.level).toBe('deep');
        for (const phase of ['context', 'reconstruct', 'challenge', 'correct', 'transfer']) {
            if (phase === 'challenge')
                local(project, ['review', 'question', '--review', review.id, '--template', 'five-whys', '--text', 'Why this fixture?']);
            if (phase === 'transfer')
                local(project, ['review', 'transfer', '--review', review.id, '--template', 'feynman', '--text', 'Explain fixture evidence simply', '--evidence', `task:${task.id}`]);
            else if (phase === 'correct')
                local(project, ['review', 'correct', '--review', review.id, '--text', 'Keep traceable evidence', '--evidence', `task:${task.id}`]);
            else
                local(project, ['review', 'respond', '--review', review.id, '--phase', phase, '--text', 'Human fixture answer with evidence', '--evidence', `task:${task.id}`]);
            local(project, ['review', 'advance', '--review', review.id]);
        }
        const skipped = call(project, ['growth', 'capture']);
        expect(skipped.skipped).toEqual([{ taskId: task.id, reviewId: review.id, taskStatus: 'active', reason: 'task-not-completed' }]);
        local(project, ['task', 'complete', '--task', task.id, '--summary', 'Fixture closed']);
        const captured = call(project, ['growth', 'capture']);
        expect(captured.captured).toHaveLength(1);
        expect(captured.captured[0].taskCompletedAt).toMatch(/T/);
        expect(captured.captured[0].templateIds).toEqual(['feynman', 'five-whys']);
        expect(call(project, ['growth', 'capture']).reused).toHaveLength(1);
        if (index === 0) {
            const candidates = call(project, ['knowledge', 'propose', '--review', review.id, '--candidate', JSON.stringify({ principle: 'Retain evidence before reuse.', boundary: 'For human reviewed fixture lessons.', evidence: [{ kind: 'task', id: task.id }] })]);
            const candidate = candidates[0].id;
            call(project, ['knowledge', 'decide', '--candidate', candidate, '--decision', 'approve', '--actor', 'human', '--source', 'Fixture human approval']);
            const concept = call(project, ['knowledge', 'promote', '--candidate', candidate, '--confidence', '0.8']);
            conceptId = concept.id;
            const quality = call(project, ['growth', 'quality', '--concept', conceptId]);
            revision = quality[0].revision;
            expect(revision).toMatch(/^[a-f0-9]{64}$/);
        }
    }
    const feedback = ['--concept', conceptId, '--revision', revision, '--actor', 'human', '--source', 'Actual simulated human fixture response'];
    for (const result of ['forgotten', 'partial', 'recalled']) {
        const args = ['growth', 'recall', ...feedback, '--result', result, '--operation', result];
        expect(call(b, args).reused).toBe(false);
        expect(call(a, args).reused).toBe(true);
    }
    const until = new Date(Date.now() + 86400000).toISOString();
    call(a, ['growth', 'defer', ...feedback, '--until', until, '--operation', 'defer']);
    expect(call(b, ['growth', 'due'])).toEqual([]);
    call(b, ['growth', 'resume', ...feedback, '--operation', 'resume']);
    for (const [operation, level] of [['initial', 'seen'], ['up', 'understood'], ['down', 'seen'], ['noop', 'seen']])
        call(a, ['capability', 'update', '--concept', conceptId, '--level', level!, '--operation', operation!, '--rationale', 'Human fixture assessment', '--evidence', JSON.stringify({ kind: 'explanation', reviewId: lastReviewId, passed: true })]);
    const history = call(a, ['growth', 'history', '--concept', conceptId]);
    expect(history.map((entry: {kind:string;previousLevel:string|null;newLevel:string})=>({kind:entry.kind,previousLevel:entry.previousLevel,newLevel:entry.newLevel}))).toEqual([
      {kind:'assessment',previousLevel:null,newLevel:'seen'},
      {kind:'transition',previousLevel:'seen',newLevel:'understood'},
      {kind:'transition',previousLevel:'understood',newLevel:'seen'},
    ]);
    const report = call(b, ['growth', 'report', '--from', from, '--to', new Date(Date.now()+60000).toISOString()]);
    expect(report.bounds.period).toBe('custom');
    expect(call(b, ['growth', 'report']).bounds.period).toBe('week');
    expect(report.counts.capabilityRises).toBe(1);
    expect(report.counts.capabilityDowngrades).toBe(1);
    expect(call(b, ['growth', 'report', '--period', 'month']).bounds.period).toBe('month');
    expect(report.counts.completedReviews).toBe(2);
    expect(report.counts.recalls.recalled).toBe(1);
    const bundle = call(a, ['personal', 'export', '--out', join(root, 'out')]);
    expect(call(b, ['personal', 'verify', '--bundle', bundle.exportRoot]).valid).toBe(true);
    expect(call(b, ['personal', 'import', '--dry-run', '--bundle', bundle.exportRoot]).unsupported).toEqual([]);
    expect(run(['growth', 'report', '--project', a, '--personal', personal]).stdout).toContain('growth');
}, 60_000);
it('renders concise human due output', async()=>{const root=await mkdtemp(join(tmpdir(),'growth-human-'));roots.push(root);const result=run(['growth','due','--project',join(root,'p'),'--personal',join(root,'k')]);expect(result.status).toBe(0);expect(result.stdout.trim()).toBe('No due concepts.');});

it('preserves exact Both archives through native-selected CLI without duplicate active observations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'growth-cli-both-'));roots.push(root);
 const a=join(root,'a'),b=join(root,'b'),project=join(root,'project'),remote=join(root,'remote');const path='growth/observations/op.json';
 const cli=(personal:string,args:string[])=>ok([...args,'--personal',personal,'--project',project]);
 await mkdir(join(a,'growth/observations'),{recursive:true});await writeFile(join(a,path),JSON.stringify(portableObservation));
 cli(a,['cloud','backup','--remote',remote,'--passphrase','fixture']);cli(b,['cloud','sync','--apply','--remote',remote,'--passphrase','fixture']);
 const remoteBytes=JSON.stringify({...portableObservation,source:'remote fixture'}),localBytes=JSON.stringify({...portableObservation,source:'local fixture'});
 await writeFile(join(a,path),remoteBytes);cli(a,['cloud','backup','--remote',remote,'--passphrase','fixture']);await writeFile(join(b,path),localBytes);
 const result=cli(b,['cloud','conflict','resolve','--path',path,'--strategy','both','--remote',remote,'--passphrase','fixture']);
 const archive=result.writtenLocal.find((p:string)=>p!==path);expect(await readFile(join(b,archive),'utf8')).toBe(localBytes);expect(await readFile(join(b,path),'utf8')).toBe(remoteBytes);
 expect(cli(b,['growth','report']).coverage.counts.observations).toBe(1);
 const bundle=cli(b,['personal','export','--out',join(root,'out')]);expect(cli(b,['personal','verify','--bundle',bundle.exportRoot]).valid).toBe(true);
 cli(a,['cloud','sync','--apply','--remote',remote,'--passphrase','fixture']);expect(await readFile(join(a,archive),'utf8')).toBe(localBytes);
});

// Catches implicit read-time migration, invented legacy history, non-atomic upgrade or duplicate retry history.
it('preserves persisted v1 bytes on reads and explicitly upgrades once with portable history', async () => {
 const root=await mkdtemp(join(tmpdir(),'growth-cli-v1-')); roots.push(root);
 const project=join(root,'project'),personal=join(root,'personal');
 const cli=(args:string[])=>ok([...args,'--project',project,'--personal',personal]);
 const at='2026-07-03T00:00:00.000Z';
 const record={conceptId:'c',level:'seen',evidence:[{kind:'explanation',reviewId:'review',passed:true}],updatedAt:at};
 const legacy=JSON.stringify({version:1,records:[record]},null,2)+'\n';
 await mkdir(join(personal,'concepts'),{recursive:true});
 await mkdir(join(project,'.growth-memory/reviews'),{recursive:true});
 await writeFile(join(personal,'concepts/c.json'),JSON.stringify(portableConcept));
 await writeFile(join(personal,'capabilities.json'),legacy);
 await writeFile(join(project,'.growth-memory/reviews/review.json'),JSON.stringify({id:'review',taskId:'task',level:'quick',selectedBy:'human',status:'completed',phase:'complete',startedAt:at,entries:[{id:'entry',actor:'human',kind:'response',content:'Synthetic persisted human explanation',at,evidence:[]}]}));
 for (const args of [['capability','list'],['growth','quality'],['growth','due'],['growth','report']]) cli(args);
 const baseline=cli(['growth','history','--concept','c']);
 expect(baseline).toMatchObject([{kind:'baseline',previousLevel:null,newLevel:'seen',warnings:['history-gap','unknown-content']}]);
 expect(baseline[0].contentFingerprint).toBeUndefined();
 expect(await readFile(join(personal,'capabilities.json'),'utf8')).toBe(legacy);
 const update=['capability','update','--concept','c','--level','understood','--operation','legacy-upgrade','--rationale','Synthetic human requested assessment','--evidence',JSON.stringify(record.evidence[0])];
 const assessed=cli(update); expect(assessed.level).toBe('understood');
 const bytes=await readFile(join(personal,'capabilities.json'),'utf8');
 expect(JSON.parse(bytes)).toMatchObject({version:2,history:[{kind:'baseline',returnedRecord:record},{kind:'transition',operationId:'legacy-upgrade',input:{rationale:'Synthetic human requested assessment'}}]});
 expect(cli(update)).toEqual(assessed);
 expect(await readFile(join(personal,'capabilities.json'),'utf8')).toBe(bytes);
 expect(cli(['growth','history','--concept','c'])).toHaveLength(2);
 const exported=cli(['personal','export','--out',join(root,'out')]);
 expect(cli(['personal','verify','--bundle',exported.exportRoot]).valid).toBe(true);
 expect(await readFile(join(exported.exportRoot,'capabilities.json'),'utf8')).toBe(bytes);
});
