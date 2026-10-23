import Dexie, { type EntityTable } from 'dexie';
import type { AssetAnalysis } from '../ai/autocut/score';
import type { Asset, Project } from '../editor/timeline/model';
import type { LibraryItem } from './audioTypes';

/** Undo/redo stacks, persisted per project so history survives reloads. */
export type ProjectHistory = { projectId: string; past: Project[]; future: Project[] };

export type Setting = { key: string; value: unknown };

class PawCutDB extends Dexie {
  projects!: EntityTable<Project, 'id'>;
  assets!: EntityTable<Asset, 'id'>;
  history!: EntityTable<ProjectHistory, 'projectId'>;
  settings!: EntityTable<Setting, 'key'>;
  analyses!: EntityTable<AssetAnalysis, 'assetId'>;
  library!: EntityTable<LibraryItem, 'id'>;

  constructor() {
    super('pawcut');
    this.version(1).stores({
      projects: 'id, updatedAt',
      assets: 'id',
      history: 'projectId',
      settings: 'key',
    });
    this.version(2).stores({ analyses: 'assetId' });
    this.version(3).stores({ library: 'id, kind, lastUsedAt' });
  }
}

export const db = new PawCutDB();

export async function getSetting<T>(key: string): Promise<T | undefined> {
  return (await db.settings.get(key))?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}
