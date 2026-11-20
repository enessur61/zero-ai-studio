import { loadSceneVideoClip, saveSceneVideoClip } from '../sceneVideoStore.ts';
import type { ProjectMediaService } from './types.ts';

export const projectMediaService: ProjectMediaService = {
  async saveSceneVideo(projectId, sceneId, blob) {
    const status = await saveSceneVideoClip(projectId, sceneId, blob);
    const serverPersisted = status.serverPersisted === true;
    return {
      persistence: serverPersisted ? 'server' : status.localSaved ? 'local_only' : 'failed',
      localSaved: status.localSaved,
      serverPersisted,
      persistent: status.persistent,
      usageBytes: status.usageBytes,
      quotaBytes: status.quotaBytes,
    };
  },

  loadSceneVideo(projectId, sceneId) {
    return loadSceneVideoClip(projectId, sceneId);
  },
};
