// src/eval/dataset_loader.ts — Load and filter eval dataset samples

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DatasetSampleSchema } from './schemas';
import type { DatasetSample } from './types';

const SKIP_DIRS = new Set(['_candidates', 'calibration', '_test']);

export interface LoadedDataset {
  samples: DatasetSample[];
  selectedIds: string[];
}

export class DatasetLoader {
  private readonly datasetDir: string;

  constructor(datasetDir: string) {
    this.datasetDir = datasetDir;
  }

  load(): DatasetSample[] {
    if (!fs.existsSync(this.datasetDir)) {
      throw new Error(`Dataset directory not found: ${this.datasetDir}`);
    }

    const samples: DatasetSample[] = [];

    const entries = fs.readdirSync(this.datasetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== '.yaml' && ext !== '.yml') continue;

      const filePath = path.join(this.datasetDir, entry.name);
      let raw: unknown;
      try {
        raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
      } catch (err) {
        throw new Error(`Failed to parse dataset file ${filePath}: ${(err as Error).message}`);
      }

      const result = DatasetSampleSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `Dataset sample schema invalid in ${filePath}: ${result.error.message}`
        );
      }
      samples.push(result.data as DatasetSample);
    }

    // Also recurse one level into subdirectories (excluding skip dirs)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const subDir = path.join(this.datasetDir, entry.name);
      const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
      for (const sub of subEntries) {
        if (!sub.isFile()) continue;
        const ext = path.extname(sub.name).toLowerCase();
        if (ext !== '.yaml' && ext !== '.yml') continue;

        const filePath = path.join(subDir, sub.name);
        let raw: unknown;
        try {
          raw = yaml.load(fs.readFileSync(filePath, 'utf-8'));
        } catch (err) {
          throw new Error(
            `Failed to parse dataset file ${filePath}: ${(err as Error).message}`
          );
        }

        const result = DatasetSampleSchema.safeParse(raw);
        if (!result.success) {
          throw new Error(
            `Dataset sample schema invalid in ${filePath}: ${result.error.message}`
          );
        }
        samples.push(result.data as DatasetSample);
      }
    }

    if (samples.length === 0) {
      throw new Error(
        `Dataset directory is empty (no valid YAML samples found): ${this.datasetDir}`
      );
    }

    return samples;
  }

  filterByAnnotation(
    samples: DatasetSample[],
    source: 'human' | 'all'
  ): DatasetSample[] {
    if (source === 'all') return samples;
    return samples.filter((s) => s.annotation_source === 'human');
  }

  filterByTags(
    samples: DatasetSample[],
    tags: string[],
    tagMatch: 'any' | 'all' = 'any'
  ): DatasetSample[] {
    if (tags.length === 0) return samples;
    return samples.filter((s) => {
      const sampleTags = s.tags ?? [];
      if (tagMatch === 'all') {
        return tags.every((t) => sampleTags.includes(t));
      }
      return tags.some((t) => sampleTags.includes(t));
    });
  }

  /** Load, filter by annotation=human, then apply optional tag filter. Returns samples + selectedIds. */
  loadForRun(opts?: {
    tags?: string[];
    tagMatch?: 'any' | 'all';
    maxSamples?: number;
    sampleId?: string;
  }): LoadedDataset {
    let samples = this.load();

    // For threshold computation, only human-annotated samples participate
    samples = this.filterByAnnotation(samples, 'human');

    if (opts?.sampleId) {
      samples = samples.filter((s) => s.id === opts.sampleId);
      if (samples.length === 0) {
        throw new Error(`Sample '${opts.sampleId}' not found in dataset`);
      }
    }

    if (opts?.tags && opts.tags.length > 0) {
      samples = this.filterByTags(samples, opts.tags, opts.tagMatch ?? 'any');
    }

    if (samples.length === 0) {
      throw new Error('No samples remain after filtering — cannot run eval');
    }

    if (opts?.maxSamples && opts.maxSamples > 0) {
      samples = samples.slice(0, opts.maxSamples);
    }

    return {
      samples,
      selectedIds: samples.map((s) => s.id),
    };
  }
}
