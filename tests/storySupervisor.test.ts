import assert from 'node:assert/strict';
import { buildStorySupervisorReport } from '../server/storySupervisor.ts';
import { emptyContinuityState } from '../src/types/continuity.ts';
import type { CharacterProfile, StudioProject } from '../src/types/zero.ts';

const state = emptyContinuityState();
state.series.push({ id:'series', title:'Test', logline:'', genre:'Mystery', bible:'', projectIds:['ep1','ep2'], createdAt:'2026-01-01T00:00:00.000Z', updatedAt:'' });
state.events.push(
 { id:'s1',seriesId:'series',title:'Folge 1 Szene 1',description:'',occurredAt:'2026-01-01T10:00:00.000Z',sceneId:'scene-1',characterIds:['c1'],kind:'scene',createdAt:'',updatedAt:'' },
 { id:'s2',seriesId:'series',title:'Folge 2 Szene 1',description:'',occurredAt:'2026-01-02T10:00:00.000Z',sceneId:'scene-2',characterIds:['c1','c2'],kind:'scene',createdAt:'',updatedAt:'' },
 { id:'r1',seriesId:'series',title:'Identität enthüllt',description:'',occurredAt:'2026-01-02T11:00:00.000Z',characterIds:[],kind:'identity_reveal',subjectCharacterId:'c2',canonicalValue:'Mara',createdAt:'',updatedAt:'' },
 { id:'r2',seriesId:'series',title:'Widersprüchliche Enthüllung',description:'',occurredAt:'2026-01-03T11:00:00.000Z',characterIds:[],kind:'identity_reveal',subjectCharacterId:'c2',canonicalValue:'Nina',createdAt:'',updatedAt:'' },
);
state.sceneVersions.push(
 { id:'v1',seriesId:'series',projectId:'ep1',sceneId:'scene-1',version:1,snapshot:{},note:'initial',createdAt:'' },
 { id:'v2',seriesId:'series',projectId:'ep2',sceneId:'scene-2',version:2,snapshot:{},note:'revision',createdAt:'' },
);
state.knowledge.push({id:'k1',seriesId:'series',characterId:'c1',fact:'Erfährt von Mara',factType:'fact',learnedAt:'2026-01-02T12:00:00.000Z',createdAt:'',updatedAt:''});
const scene = (id:string, characterIds:string[]) => ({id,index:1,title:id,location:'',timeOfDay:'',durationSec:10,cameraMovement:'Statisch' as const,characterIds,narrationText:'Elias hat Angst und will die Wahrheit finden.',dialogueText:'Ich vertraue dir nicht.',subtitleText:'',soundCue:'',imagePrompt:'',videoPrompt:'',status:'Entwurf' as const});
const project = (id:string,title:string,createdAt:string,scenes:ReturnType<typeof scene>[]) => ({id,title,logline:'',genre:'',targetDurationSec:10,concept:'',story:'',screenplay:'',characterIds:[],scenes,assets:[],snapshots:[],status:'Konzept' as const,version:1,createdAt,updatedAt:createdAt}) as StudioProject;
const characters = [{id:'c1',name:'Elias',role:'Lead'},{id:'c2',name:'Mara',role:'Antagonistin'}] as CharacterProfile[];
const report = buildStorySupervisorReport(state,'series',[
 project('ep2','Episode 2','2026-01-02T00:00:00.000Z',[scene('scene-2',['c1','c2'])]),
 project('ep1','Episode 1','2026-01-01T00:00:00.000Z',[scene('scene-1',['c1'])]),
],characters);
assert.ok(report);
assert.equal(report.episodeCount,2);
assert.equal(report.sceneCount,2);
assert.deepEqual(report.episodes.map((item)=>item.title),['Episode 1','Episode 2']);
assert.equal(report.characterArcs.find((item)=>item.characterId==='c1')?.appearanceCount,2);
assert.deepEqual(report.characterArcs.find((item)=>item.characterId==='c1')?.episodeTitles,['Episode 1','Episode 2']);
assert.equal(report.revealTimeline.length,2);
assert.ok(Array.isArray(report.dramaturgyInsights));
assert.ok(report.dramaturgyInsights.every((insight) => insight.confidence === 'heuristic'));
assert.ok(report.dramaturgyInsights.some((insight) => ['emotion','motivation','contradiction'].includes(insight.category)));
assert.ok(report.conflicts.some((item)=>item.code==='STORY_CANON_DIVERGENCE' && item.characterId==='c2'));
assert.equal(buildStorySupervisorReport(state,'missing',[],characters),null);
console.log('Story Supervisor tests passed: cross-episode ordering, character arcs, reveal timeline and canon divergence.');
