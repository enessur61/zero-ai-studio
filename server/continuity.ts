import { randomUUID } from 'node:crypto';
import type { ContinuityEvent, ContinuityState, SceneVersion } from '../src/types/continuity.ts';
export function validateContinuityState(value: unknown): ContinuityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Continuity-Daten sind ungültig.');
  const v=value as Partial<ContinuityState>;
  for (const key of ['series','knowledge','relationships','locations','events','sceneVersions','dramaturgyAnalyses','dramaturgyDecisions'] as const) {
    if (v[key] !== undefined && !Array.isArray(v[key])) throw new Error(`Continuity-Feld ${key} muss eine Liste sein.`);
  }
  return { series:v.series??[], knowledge:v.knowledge??[], relationships:v.relationships??[], locations:v.locations??[], events:v.events??[], sceneVersions:v.sceneVersions??[], dramaturgyAnalyses:v.dramaturgyAnalyses??[], dramaturgyDecisions:v.dramaturgyDecisions??[] };
}
export function eventKnowledgeConflicts(events: ContinuityEvent[], knowledge: ContinuityState['knowledge']): Array<{knowledgeId:string; eventId:string; message:string}> {
  const byId=new Map(events.map(e=>[e.id,e]));
  return knowledge.flatMap(k=>{
    if(!k.sourceEventId) return [];
    const source=byId.get(k.sourceEventId);
    if(!source) return [{knowledgeId:k.id,eventId:k.sourceEventId,message:'Wissenseintrag verweist auf ein nicht vorhandenes Ereignis.'}];
    if(Date.parse(k.learnedAt)<Date.parse(source.occurredAt)) return [{knowledgeId:k.id,eventId:source.id,message:'Figur erfährt die Information vor dem zugehörigen Ereignis.'}];
    return [];
  });
}
export function createSceneVersion(input: Omit<SceneVersion,'id'|'version'|'createdAt'>, versions: SceneVersion[]): SceneVersion {
  const prior=versions.filter(v=>v.seriesId===input.seriesId&&v.projectId===input.projectId&&v.sceneId===input.sceneId);
  return { ...input, id: randomUUID(), version: prior.reduce((m,v)=>Math.max(m,v.version),0)+1, createdAt:new Date().toISOString() };
}
export function assertNoFutureKnowledge(event: {occurredAt:string}, learnedAt:string): void {
  const eventTime=Date.parse(event.occurredAt), knowledgeTime=Date.parse(learnedAt);
  if(!Number.isFinite(eventTime)||!Number.isFinite(knowledgeTime)) throw new Error('Zeitstempel müssen gültige ISO-Daten sein.');
  if(knowledgeTime<eventTime) throw new Error('Figurenwissen darf nicht vor dem auslösenden Ereignis beginnen.');
}
