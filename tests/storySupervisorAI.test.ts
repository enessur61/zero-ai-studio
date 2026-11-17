import assert from 'node:assert/strict';
import { buildStorySupervisorAiPrompt, parseStorySupervisorAiResponse } from '../server/storySupervisorAI.ts';
import type { ContinuityState } from '../src/types/continuity.ts';
import type { CharacterProfile, StudioProject } from '../src/types/zero.ts';

const state: ContinuityState = {
  series: [], knowledge: [], locations: [], sceneVersions: [],
  relationships: [{ id:'r1', seriesId:'s1', fromCharacterId:'c1', toCharacterId:'c2', type:'misstrauen', description:'Elias vermutet Verrat.' ,createdAt:'',updatedAt:''}],
  events: [{ id:'e1', seriesId:'s1', title:'Geständnis', description:'Mara lügt über den Schlüssel.', occurredAt:'2026-01-01T00:00:00Z', characterIds:['c1','c2'], createdAt:'',updatedAt:'' }],
};
const series = { id:'s1', title:'Der fehlende Tag', logline:'Ein Geheimnis zerreißt Vertrauen.', genre:'Mystery', bible:'Elias darf die Wahrheit erst im Finale erfahren.', projectIds:['p1'], createdAt:'',updatedAt:'' };
const scene = { id:'sc1', index:1, title:'Das Geständnis', location:'',timeOfDay:'',durationSec:20,cameraMovement:'Statisch' as const,characterIds:['c1','c2'],narrationText:'Elias sucht nach der Wahrheit.',dialogueText:'Mara: Ich habe dich nie gesehen.',subtitleText:'',soundCue:'',imagePrompt:'',videoPrompt:'',status:'Entwurf' as const };
const project = { id:'p1',title:'Episode 1',logline:'',genre:'',targetDurationSec:20,concept:'',story:'',screenplay:'',characterIds:['c1','c2'],scenes:[scene],assets:[],snapshots:[],status:'Konzept' as const,version:1,createdAt:'',updatedAt:'' } as StudioProject;
const characters = [{id:'c1',name:'Elias',role:'Lead'},{id:'c2',name:'Mara',role:'Antagonistin'}] as CharacterProfile[];
const built = buildStorySupervisorAiPrompt({series,state,projects:[project],characters});
assert.match(built.prompt,/Episode 1/);
assert.match(built.prompt,/Elias sucht nach der Wahrheit/);
assert.match(built.prompt,/misstrauen/);
assert.match(built.prompt,/erst im Finale/);
assert.deepEqual(built.validCharacterIds.sort(),['c1','c2']);
const response = parseStorySupervisorAiResponse(JSON.stringify({
 overallAssessment:'Die Beziehung kippt durch ein wiederholtes Vermeidungsverhalten.',
 characterAnalyses:[{characterId:'c1',psychologicalProfile:'Kontrollbedürftig',coreMotivation:'Wahrheit',emotionalArc:'Misstrauen wächst',relationshipDynamics:['Misstrauen zu Mara'],contradictions:[]} ,{characterId:'unknown',psychologicalProfile:'fake'}],
 findings:[{id:'f1',category:'subtext',severity:'warning',characterIds:['c1','unknown'],episodeTitle:'Episode 1',sceneTitle:'Das Geständnis',evidence:'Mara weicht der Frage aus.',interpretation:'Schutz durch Lüge',recommendation:'Subtext über Handlung verstärken.',confidence:'medium'}],
 storyRecommendations:['Lass die Lüge später einen Preis haben.'],
}),built.validCharacterIds);
assert.equal(response.characterAnalyses.length,1);
assert.deepEqual(response.findings[0].characterIds,['c1']);
assert.equal(response.findings[0].category,'subtext');
assert.throws(()=>parseStorySupervisorAiResponse('kein JSON',built.validCharacterIds),/kein JSON/);
assert.throws(()=>parseStorySupervisorAiResponse('{"overallAssessment":"","findings":[]}',built.validCharacterIds),/keine verwertbare Analyse/);
console.log('Story Supervisor AI tests passed: series context, relationship/subtext prompt and strict response validation.');
