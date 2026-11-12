export const portableObservation = { version: 1, id: 'op', kind: 'recall', conceptId: 'c', contentFingerprint: 'a'.repeat(64), recordedAt: '2026-10-29T00:00:00.000Z', actor: 'human', source: 'fixture', result: 'recalled' };
export const portableReview = { version: 1, id: 'capture', sourceId: 'source', taskId: 'task', reviewId: 'review', taskType: 'implementation', conceptIds: ['c'], signals: [], level: 'deep', templateIds: ['feynman'], taskCompletedAt: '2026-10-28T23:00:00.000Z', completedAt: '2026-10-29T00:00:00.000Z', capturedAt: '2026-10-29T00:00:00.000Z' };
const baselineRecord = { conceptId: 'c', level: 'seen', evidence: [{ kind: 'explanation', reviewId: 'review', passed: true }], updatedAt: '2026-10-28T00:00:00.000Z' };
const currentRecord = { ...baselineRecord, level: 'understood', updatedAt: '2026-10-29T00:00:00.000Z' };
export const portableCapabilities = { version: 2, records: [currentRecord], history: [
        { kind: 'baseline', operationId: 'baseline-c', conceptId: 'c', previousLevel: null, newLevel: 'seen', evidence: baselineRecord.evidence, at: baselineRecord.updatedAt, returnedRecord: baselineRecord },
        { kind: 'transition', operationId: 'understood-c', conceptId: 'c', previousLevel: 'seen', newLevel: 'understood', evidence: currentRecord.evidence, at: currentRecord.updatedAt, returnedRecord: currentRecord, contentFingerprint: 'a'.repeat(64), input: { conceptId: 'c', level: 'understood', evidence: currentRecord.evidence } },
    ] };
export const portableConcept = {id:'c',reviewId:'review',ordinal:1,principle:'Retain explicit evidence.',boundary:'For fixture tasks.',evidence:[{kind:'task',id:'task'}],status:'approved',confidence:0.8,reviewedAt:'2026-10-29T00:00:00.000Z',taskId:'task',history:[]};
