/**
 * Test setup file
 * Configures mocks and test environment before tests run
 */

// Set test environment variables
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_KEY;
process.env.ANTHROPIC_API_KEY = 'test-api-key';
process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests

// Mock Supabase client
jest.mock('../src/utils/supabase', () => {
  const mockSupabase = require('./__mocks__/supabase');
  return {
    __esModule: true,
    supabase: mockSupabase.default,
    default: mockSupabase.default,
  };
});

// Mock Anthropic client
jest.mock('../src/utils/anthropic', () => {
  const mockAnthropic = require('./__mocks__/anthropic');
  return {
    callAnthropicText: jest.fn().mockImplementation(mockAnthropic.callAnthropicText),
    callAnthropicVision: jest.fn().mockImplementation(mockAnthropic.callAnthropicVision),
    default: mockAnthropic.default,
  };
});

// Mock PDF processor
jest.mock('../src/services/pdf/processor', () => {
  return require('./__mocks__/pdf-processor');
});

