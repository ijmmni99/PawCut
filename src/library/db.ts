import Dexie, { type EntityTable } from 'dexie';
import type { AssetAnalysis } from '../ai/autocut/score';
import type { Asset, Project } from '../editor/timeline/model';

/** Undo/redo stacks, persisted per project so history survives reloads. */
export type ProjectHistory = { projectId: string; past: Project[]; future: Project[] };

export type Setting = { key: string; value: unknown };

class PawCutDB extends Dexie {
  projects!: EntityTable<Project, 'id'>;
  assets!: EntityTable<Asset, 'id'>;
  history!: EntityTable<ProjectHistory, 'projectId'>;
  settings!: EntityTable<Setting, 'key'>;
  analyses!: EntityTable<AssetAnalysis, 'assetId'>;

  constructor() {
    super('pawcut');
    this.version(1).stores({
      projects: 'id, updatedAt',
      assets: 'id',
      history: 'projectId',
      settings: 'key',
    });
    this.version(2).stores({ analyses: 'assetId' });
  }
}

export const db = new PawCutDB();

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
