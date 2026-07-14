export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export interface ArtifactValidationResult {
  /** change-relative path, e.g. cases/warehouse/inbound/case.yaml */
  path: string;
  artifact_type: string;
  ok: boolean;
  errors: string[];
}

export interface ValidateAllResult {
  ok: boolean;
  results: ArtifactValidationResult[];
}

/** Compile-time helper: fails `tsc` if T is not assignable to U (used to keep
 *  zod-inferred types aligned with hand-written interfaces in core/types.ts). */
export type AssertAssignable<T extends U, U> = true;
