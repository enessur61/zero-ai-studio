import { createHash, randomUUID } from 'node:crypto';
import type { DramaturgyAnalysisVersion } from '../src/types/continuity.ts';
import type { StorySupervisorAiResult } from './storySupervisorAI.ts';

const norm=(value:string)=>value.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function compareDramaturgyAnalyses(previous:DramaturgyAnalysisVersion|undefined,next:StorySupervisorAiResult) {
  if(!previous) return undefined;
  const before=new Map(previous.analysis.characterAnalyses.map(item=>[item.characterId,item]));
  const changedCharacters=next.characterAnalyses.flatMap(item=>{
    const old=before.get(item.characterId); if(!old)return [{characterId:item.characterId,changedFields:['neu'] }];
    const fields=(['psychologicalProfile','coreMotivation','emotionalArc','relationshipDynamics','contradictions'] as const)
      .filter(key=>JSON.stringify(old[key])!==JSON.stringify(item[key]));
    return fields.length?[{characterId:item.characterId,changedFields:fields}]:[];
  });
  const oldSet=new Set(previous.analysis.findings.filter(x=>x.category==='contradiction').map(x=>norm(x.evidence+' '+x.interpretation)));
  const newSet=new Set(next.findings.filter(x=>x.category==='contradiction').map(x=>norm(x.evidence+' '+x.interpretation)));
  const newContradictions=[...newSet].filter(x=>x&&!oldSet.has(x));
  const resolvedContradictions=[...oldSet].filter(x=>x&&!newSet.has(x));
  return {previousVersion:previous.version,changedCharacters,newContradictions,resolvedContradictions,summary:`${changedCharacters.length} Figurenprofile verändert; ${newContradictions.length} neue und ${resolvedContradictions.length} nicht mehr gemeldete Widersprüche.`};
}
export function createDramaturgyAnalysisVersion(input:{seriesId:string;modelId:string;costMode:'confirmed-free-cloud'|'local';analysis:StorySupervisorAiResult;previous?:DramaturgyAnalysisVersion;source:string}):DramaturgyAnalysisVersion {
  const version=(input.previous?.version??0)+1;
  const sourceFingerprint=createHash('sha256').update(input.source).digest('hex');
  return {id:randomUUID(),seriesId:input.seriesId,version,createdAt:new Date().toISOString(),modelId:input.modelId,costMode:input.costMode,sourceFingerprint,analysis:input.analysis,...(input.previous?{comparison:compareDramaturgyAnalyses(input.previous,input.analysis)}:{})};
}
