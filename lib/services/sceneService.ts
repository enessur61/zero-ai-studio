import { projectService } from './projectService.ts';
import type { SceneService } from './types.ts';
import type { FilmScene } from '../../src/types/zero.ts';

export const sceneService: SceneService = {
  async list(projectId) {
    return (await projectService.get(projectId)).scenes;
  },

  async get(projectId, sceneId) {
    const project = await projectService.get(projectId);
    const scene = project.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error('Szene gehört nicht zu diesem Projekt oder existiert nicht.');
    return scene;
  },

  async create(projectId, scene: FilmScene) {
    const project = await projectService.get(projectId);
    if (!scene.id || project.scenes.some((item) => item.id === scene.id)) {
      throw new Error('Szenen-ID fehlt oder ist im Projekt bereits vorhanden.');
    }
    const updated = await projectService.update(projectId, { scenes: [...project.scenes, scene] });
    const created = updated.scenes.find((item) => item.id === scene.id);
    if (!created) throw new Error('Die neue Szene wurde vom Server nicht bestätigt.');
    return created;
  },

  async update(projectId, sceneId, patch) {
    const project = await projectService.get(projectId);
    const index = project.scenes.findIndex((item) => item.id === sceneId);
    if (index < 0) throw new Error('Szene gehört nicht zu diesem Projekt oder existiert nicht.');
    const scenes = project.scenes.map((scene, itemIndex) => itemIndex === index
      ? { ...scene, ...patch, id: scene.id }
      : scene);
    const updated = await projectService.update(projectId, { scenes });
    const result = updated.scenes.find((item) => item.id === sceneId);
    if (!result) throw new Error('Die Szenenänderung wurde vom Server nicht bestätigt.');
    return result;
  },

  async remove(projectId, sceneId) {
    const project = await projectService.get(projectId);
    if (!project.scenes.some((item) => item.id === sceneId)) {
      throw new Error('Szene gehört nicht zu diesem Projekt oder existiert nicht.');
    }
    await projectService.update(projectId, { scenes: project.scenes.filter((item) => item.id !== sceneId) });
  },
};
