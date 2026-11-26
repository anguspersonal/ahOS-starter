/**
 * TDD tests for workflow value objects: WorkflowId, ArtifactId, StepId.
 *
 * Backlog: "Introduce value objects for WorkflowId, ArtifactId, StepId (Primitive Obsession)"
 */

import { WorkflowId, ArtifactId, StepId } from '../../../src/workflows/ids';

const validUUID = '550e8400-e29b-41d4-a716-446655440000';

describe('WorkflowId', () => {
  describe('parse/create', () => {
    it('accepts a valid UUID string and exposes value', () => {
      const id = WorkflowId.parse(validUUID);
      expect(id).toBeDefined();
      expect(id.value).toBe(validUUID);
    });

    it('rejects empty string', () => {
      expect(() => WorkflowId.parse('')).toThrow();
    });

    it('rejects non-UUID string', () => {
      expect(() => WorkflowId.parse('workflow-123')).toThrow();
    });

    it('rejects number', () => {
      expect(() => WorkflowId.parse(42 as unknown)).toThrow();
    });
  });

  describe('equality', () => {
    it('two instances from same UUID are equal', () => {
      const a = WorkflowId.parse(validUUID);
      const b = WorkflowId.parse(validUUID);
      expect(a.equals(b)).toBe(true);
    });
  });
});

describe('ArtifactId', () => {
  describe('parse/create', () => {
    it('accepts a valid UUID string and exposes value', () => {
      const id = ArtifactId.parse(validUUID);
      expect(id.value).toBe(validUUID);
    });

    it('rejects invalid input', () => {
      expect(() => ArtifactId.parse('not-a-uuid')).toThrow();
    });
  });
});

describe('StepId', () => {
  describe('parse/create', () => {
    it('accepts positive integer and exposes value', () => {
      const id = StepId.parse(42);
      expect(id.value).toBe(42);
    });

    it('accepts numeric string and parses to number', () => {
      const id = StepId.parse('42');
      expect(id.value).toBe(42);
    });

    it('rejects negative number', () => {
      expect(() => StepId.parse(-1)).toThrow();
    });

    it('rejects zero if step IDs are always positive', () => {
      expect(() => StepId.parse(0)).toThrow();
    });

    it('rejects non-numeric string', () => {
      expect(() => StepId.parse('abc')).toThrow();
    });

    it('rejects null/undefined', () => {
      expect(() => StepId.parse(null)).toThrow();
      expect(() => StepId.parse(undefined)).toThrow();
    });
  });

  describe('equality', () => {
    it('two instances from same number are equal', () => {
      const a = StepId.parse(42);
      const b = StepId.parse(42);
      expect(a.equals(b)).toBe(true);
    });
  });

  describe('single place for parsing (resume-style)', () => {
    it('parses raw step id from DB (number or string) like resume.ts', () => {
      const rawStepIdNum = 7;
      const rawStepIdStr = '7';
      const fromNum = StepId.parse(rawStepIdNum);
      const fromStr = StepId.parse(rawStepIdStr);
      expect(fromNum.value).toBe(7);
      expect(fromStr.value).toBe(7);
      expect(fromNum.equals(fromStr)).toBe(true);
    });
  });
});
