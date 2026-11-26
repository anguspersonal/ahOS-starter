/**
 * Unit tests for Upload Step
 */

import {
  generateStoragePath,
  validateFile,
  executeUploadStep,
  createSignedUrl,
} from '../../../../src/workflows/steps/upload';
import { WorkflowId, StepId } from '../../../../src/workflows/steps/types';
import { supabase } from '../../../../src/utils/supabase';
import {
  createMockFile,
  createMockUserContext,
  createMockWorkflowStep,
  createMockFileMetadata,
} from '../../../helpers/fixtures';
import {
  resetMockData,
  setMockData,
  resetMockStorage,
  setMockStorageFile,
} from '../../../__mocks__/supabase';

// Mock supabase
jest.mock('../../../../src/utils/supabase');

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

describe('Upload Step', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMockData();
    resetMockStorage();
  });

  describe('generateStoragePath', () => {
    it('should generate path with userId and timestamp', () => {
      const userId = 'user-123';
      const fileName = 'test.jpg';
      const path = generateStoragePath(userId, fileName);

      expect(path).toContain(userId);
      expect(path).toContain('test.jpg');
      expect(path).toMatch(/^user-123\/\d+_test\.jpg$/);
    });

    it('should sanitize filename in path', () => {
      const userId = 'user-123';
      const fileName = 'test file with spaces.jpg';
      const path = generateStoragePath(userId, fileName);

      expect(path).not.toContain(' ');
      expect(path).toContain('test');
      expect(path).toContain('jpg');
    });

    it('should handle special characters in filename', () => {
      const userId = 'user-123';
      const fileName = 'test<>:"|?*file.jpg';
      const path = generateStoragePath(userId, fileName);

      expect(path).not.toMatch(/[<>:"|?*]/);
    });

    it('should handle long filenames (truncation)', () => {
      const userId = 'user-123';
      const longFileName = 'a'.repeat(200) + '.jpg';
      const path = generateStoragePath(userId, longFileName);

      expect(path.length).toBeLessThan(300);
      expect(path).toContain('.jpg');
    });
  });

  describe('validateFile', () => {
    it('should reject null/undefined file', () => {
      const result1 = validateFile(null as any);
      expect(result1.valid).toBe(false);
      expect(result1.error).toBe('No file provided');

      const result2 = validateFile(undefined as any);
      expect(result2.valid).toBe(false);
      expect(result2.error).toBe('No file provided');
    });

    it('should reject empty filename', () => {
      const file = createMockFile({ name: '' });
      const result = validateFile(file);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Filename is empty');
    });

    it('should reject zero-byte files', () => {
      const file = createMockFile({ size: 0 });
      const result = validateFile(file);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('File is empty (0 bytes)');
    });

    it('should reject files exceeding MAX_FILE_SIZE (50MB)', () => {
      const file = createMockFile({ size: 60 * 1024 * 1024 }); // 60MB
      const result = validateFile(file);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('too large');
    });

    it('should accept valid file sizes', () => {
      const file = createMockFile({ size: 10 * 1024 * 1024 }); // 10MB
      const result = validateFile(file);

      expect(result.valid).toBe(true);
    });

    it('should reject unsupported MIME types', () => {
      const file = createMockFile({ type: 'application/x-executable' });
      const result = validateFile(file);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('should accept allowed MIME types', () => {
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'application/pdf',
        'video/mp4',
        'text/plain',
      ];

      allowedTypes.forEach(type => {
        const file = createMockFile({ type });
        const result = validateFile(file);
        expect(result.valid).toBe(true);
      });
    });

    it('should accept files with allowed MIME prefixes', () => {
      const prefixTypes = [
        'image/custom',
        'video/custom',
        'audio/mpeg',
      ];

      prefixTypes.forEach(type => {
        const file = createMockFile({ type });
        const result = validateFile(file);
        expect(result.valid).toBe(true);
      });
    });

    it('should reject files with empty data', () => {
      const file = createMockFile({ data: Buffer.alloc(0) });
      const result = validateFile(file);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('File data is empty');
    });

    it('should handle missing MIME type gracefully', () => {
      const file = createMockFile({ type: '' });
      const result = validateFile(file);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('not supported');
    });
  });

  describe('executeUploadStep', () => {
    it('should validate file before upload', async () => {
      const step = createMockWorkflowStep();
      const invalidFile = createMockFile({ size: 0 });
      const userContext = createMockUserContext();

      const result = await executeUploadStep(step, invalidFile, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should update step status to running', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: jest.fn().mockResolvedValue({ data: { path: 'user-123/test.jpg' }, error: null }),
      } as any);

      await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(mockSupabase.from).toHaveBeenCalledWith('workflow_steps');
    });

    it('should upload file successfully on first attempt', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockResolvedValue({
        data: { path: 'user-123/test.jpg' },
        error: null,
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.objectPath).toBe('user-123/test.jpg');
      expect(mockUpload).toHaveBeenCalledTimes(1);
    });

    it('should retry on upload failure', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      let attemptCount = 0;
      const mockUpload = jest.fn().mockImplementation(() => {
        attemptCount++;
        if (attemptCount < 3) {
          return Promise.resolve({ data: null, error: { message: 'Network error' } });
        }
        return Promise.resolve({ data: { path: 'user-123/test.jpg' }, error: null });
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(mockUpload).toHaveBeenCalledTimes(3);
    });

    it('should stop retrying after MAX_RETRY_ATTEMPTS', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'Persistent error' },
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      setMockData('system_decisions', []);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(mockUpload).toHaveBeenCalledTimes(3);
      expect(result.error).toBeDefined();
    });

    it('should create failure notification on all retries failed', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'Persistent error' },
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      setMockData('system_decisions', []);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.notificationId).toBeDefined();
    });

    it('should return correct UploadResult on success', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockResolvedValue({
        data: { path: 'user-123/test.jpg' },
        error: null,
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(true);
      expect(result.objectPath).toBe('user-123/test.jpg');
      expect(result.fileMetadata).toBeDefined();
      expect(result.fileMetadata?.fileName).toBe('test.jpg');
    });

    it('should return correct UploadResult on failure', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'Upload failed' },
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      setMockData('system_decisions', []);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.objectPath).toBeUndefined();
    });

    it('should update step with objectPath on success', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockResolvedValue({
        data: { path: 'user-123/test.jpg' },
        error: null,
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(mockSupabase.from).toHaveBeenCalledWith('workflow_steps');
    });

    it('should handle storage errors correctly', async () => {
      const step = createMockWorkflowStep();
      const file = createMockFile();
      const userContext = createMockUserContext();

      const mockUpload = jest.fn().mockRejectedValue(new Error('Storage error'));

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        upload: mockUpload,
      } as any);

      setMockData('system_decisions', []);

      const result = await executeUploadStep(step, file, userContext, WorkflowId.parse(step.workflow_id), StepId.parse(step.id));

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('createSignedUrl', () => {
    it('should create signed URL successfully', async () => {
      const objectPath = 'user-123/test.jpg';

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        createSignedUrl: jest.fn().mockResolvedValue({
          data: { signedUrl: 'https://example.com/signed-url' },
          error: null,
        }),
      } as any);

      const result = await createSignedUrl(objectPath);

      expect(result.signedUrl).toBe('https://example.com/signed-url');
      expect(result.error).toBeNull();
    });

    it('should use default expiration time (1 hour)', async () => {
      const objectPath = 'user-123/test.jpg';
      const mockCreateSignedUrl = jest.fn().mockResolvedValue({
        data: { signedUrl: 'https://example.com/signed-url' },
        error: null,
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        createSignedUrl: mockCreateSignedUrl,
      } as any);

      await createSignedUrl(objectPath);

      expect(mockCreateSignedUrl).toHaveBeenCalledWith(objectPath, 3600);
    });

    it('should use custom expiration time', async () => {
      const objectPath = 'user-123/test.jpg';
      const customExpiresIn = 7200; // 2 hours
      const mockCreateSignedUrl = jest.fn().mockResolvedValue({
        data: { signedUrl: 'https://example.com/signed-url' },
        error: null,
      });

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        createSignedUrl: mockCreateSignedUrl,
      } as any);

      await createSignedUrl(objectPath, customExpiresIn);

      expect(mockCreateSignedUrl).toHaveBeenCalledWith(objectPath, customExpiresIn);
    });

    it('should handle storage errors', async () => {
      const objectPath = 'user-123/test.jpg';

      (mockSupabase.storage.from as jest.Mock).mockReturnValue({
        createSignedUrl: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'Storage error' },
        }),
      } as any);

      const result = await createSignedUrl(objectPath);

      expect(result.signedUrl).toBeNull();
      expect(result.error).toBe('Storage error');
    });
  });
});

