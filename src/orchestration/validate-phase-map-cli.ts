/**
 * CLI entry for hybrid phase map validation.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseHybridPhaseMap,
  validateHybridPhaseMap,
  findHybridPhaseMapFile,
} from './hybrid-phase-map';
import { validatePhaseMapAssets } from './validate-phase-map-assets';

export function runValidatePhaseMapCli(argv: string[] = process.argv.slice(2)): number {
  const projectRoot = process.cwd();
  let mapPath: string | undefined;
  let checkAssets = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--map' && argv[i + 1]) {
      mapPath = path.isAbsolute(argv[i + 1])
        ? argv[i + 1]
        : path.join(projectRoot, argv[i + 1]);
      i++;
    } else if (argv[i] === '--assets') {
      checkAssets = true;
    }
  }

  const file = mapPath ?? findHybridPhaseMapFile(projectRoot);
  const yamlText = fs.readFileSync(file, 'utf-8');

  let map;
  try {
    map = parseHybridPhaseMap(yamlText);
  } catch (err) {
    console.error(`Phase map parse error (${file}): ${(err as Error).message}`);
    return 1;
  }

  const result = validateHybridPhaseMap(map);
  if (!result.ok) {
    console.error(`Phase map validation failed (${file}):`);
    for (const e of result.errors) console.error(`  - ${e}`);
    return 1;
  }

  if (checkAssets) {
    const repoRoot =
      path.basename(path.dirname(file)) === '.opencode'
        ? path.dirname(path.dirname(file))
        : projectRoot;
    const assetResult = validatePhaseMapAssets(map, {
      repoRoot,
      requireSyncedSkills: true,
    });
    if (!assetResult.ok) {
      console.error(`Phase map asset validation failed (${file}):`);
      for (const e of assetResult.errors) console.error(`  - ${e}`);
      return 1;
    }
    console.log(`Phase map assets OK (${repoRoot})`);
  }

  console.log(`Phase map OK (${file}) — ${map.phases.length} phases`);
  return 0;
}

if (require.main === module) {
  process.exit(runValidatePhaseMapCli());
}
