import { apiRequest } from '../api.ts';
import type { CreateProjectInput, ProjectService, StudioProject, UpdateProjectInput } from './types.ts';

export const projectService: ProjectService = {
  async list() {
    const response = await apiRequest<{ projects: StudioProject[] }>('/api/projects');
    if (!Array.isArray(response.projects)) throw new Error('ZERO hat keine gültige Projektliste geliefert.');
    return response.projects;
  },

  async get(projectId) {
    if (!projectId.trim()) throw new Error('Projekt-ID fehlt.');
    const project = (await this.list()).find((item) => item.id === projectId);
    if (!project) throw new Error('Projekt nicht gefunden.');
    return project;
  },

  async create(input: CreateProjectInput) {
    const response = await apiRequest<{ project: StudioProject }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (!response.project?.id) throw new Error('ZERO hat kein gültiges Projekt zurückgegeben.');
    return response.project;
  },

  async update(projectId: string, input: UpdateProjectInput, expectedVersion?: number) {
    if (!projectId.trim()) throw new Error('Projekt-ID fehlt.');
    const response = await apiRequest<{ project: StudioProject }>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      { method: 'PUT', body: JSON.stringify({ ...input, ...(expectedVersion === undefined ? {} : { expectedVersion }) }) },
    );
    if (!response.project?.id) throw new Error('ZERO hat kein gültiges aktualisiertes Projekt zurückgegeben.');
    return response.project;
  },
};
