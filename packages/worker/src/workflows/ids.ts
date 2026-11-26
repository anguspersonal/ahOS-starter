/**
 * Value objects for workflow identifiers (Primitive Obsession refactor).
 * Single place for validation and parsing of WorkflowId, ArtifactId, StepId.
 */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUUID(value: string): boolean {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export class WorkflowId {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value;
  }

  static parse(input: unknown): WorkflowId {
    if (typeof input !== 'string' || !isUUID(input)) {
      throw new Error(`Invalid WorkflowId: expected UUID string, got ${typeof input}`);
    }
    return new WorkflowId(input);
  }

  get value(): string {
    return this._value;
  }

  equals(other: WorkflowId): boolean {
    return this._value === other._value;
  }

  toString(): string {
    return this._value;
  }
}

export class ArtifactId {
  private readonly _value: string;

  private constructor(value: string) {
    this._value = value;
  }

  static parse(input: unknown): ArtifactId {
    if (typeof input !== 'string' || !isUUID(input)) {
      throw new Error(`Invalid ArtifactId: expected UUID string, got ${typeof input}`);
    }
    return new ArtifactId(input);
  }

  get value(): string {
    return this._value;
  }

  equals(other: ArtifactId): boolean {
    return this._value === other._value;
  }

  toString(): string {
    return this._value;
  }
}

export class StepId {
  private readonly _value: number;

  private constructor(value: number) {
    this._value = value;
  }

  static parse(input: unknown): StepId {
    if (input === null || input === undefined) {
      throw new Error('Invalid StepId: null or undefined');
    }
    const num =
      typeof input === 'number' ? input : typeof input === 'string' ? Number.parseInt(String(input), 10) : NaN;
    if (!Number.isInteger(num) || num < 1 || !Number.isFinite(num)) {
      throw new Error(`Invalid StepId: expected positive integer, got ${String(input)}`);
    }
    return new StepId(num);
  }

  get value(): number {
    return this._value;
  }

  equals(other: StepId): boolean {
    return this._value === other._value;
  }

  toString(): string {
    return String(this._value);
  }
}
