import * as path from 'path';
import { assertChangeIdSafe, resolveInsideProject } from './safety';

export function exploreDir(projectRoot: string, changeId: string): string {
  assertChangeIdSafe(changeId);
  return resolveInsideProject(projectRoot, 'qa', 'changes', changeId, 'explore');
}

export function contextJsonPath(projectRoot: string, changeId: string): string {
  return path.join(exploreDir(projectRoot, changeId), 'context.json');
}

export function advisoryJsonPath(projectRoot: string, changeId: string): string {
  return path.join(exploreDir(projectRoot, changeId), 'advisory.json');
}
