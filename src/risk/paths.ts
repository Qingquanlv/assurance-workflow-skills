import * as path from 'path';
import { assertChangeIdSafe, resolveInsideProject } from './safety';

export function riskAdvisoryDir(projectRoot: string, changeId: string): string {
  assertChangeIdSafe(changeId);
  return resolveInsideProject(projectRoot, 'qa', 'changes', changeId, 'risk-advisory');
}

export function contextJsonPath(projectRoot: string, changeId: string): string {
  return path.join(riskAdvisoryDir(projectRoot, changeId), 'context.json');
}

export function advisoryJsonPath(projectRoot: string, changeId: string): string {
  return path.join(riskAdvisoryDir(projectRoot, changeId), 'advisory.json');
}
