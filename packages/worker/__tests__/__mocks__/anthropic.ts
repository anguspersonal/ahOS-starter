/**
 * Mock Anthropic client
 * Provides mock functions for AI API calls
 */

// Mock responses storage
let mockTextResponse: { content: string; usage: any } | null = null;
let mockVisionResponse: { content: string; usage: any } | null = null;
let shouldFailText = false;
let shouldFailVision = false;
let textError: Error | null = null;
let visionError: Error | null = null;
let callCount = 0;

// Helper to reset mocks
export function resetAnthropicMocks() {
  mockTextResponse = null;
  mockVisionResponse = null;
  shouldFailText = false;
  shouldFailVision = false;
  textError = null;
  visionError = null;
  callCount = 0;
}

// Helper to set mock text response
export function setMockTextResponse(content: string, usage: any = { input_tokens: 100, output_tokens: 50 }) {
  mockTextResponse = { content, usage };
  shouldFailText = false;
  textError = null;
}

// Helper to set mock vision response
export function setMockVisionResponse(content: string, usage: any = { input_tokens: 100, output_tokens: 50 }) {
  mockVisionResponse = { content, usage };
  shouldFailVision = false;
  visionError = null;
}

// Helper to simulate text API failure
export function simulateTextFailure(error: Error) {
  shouldFailText = true;
  textError = error;
}

// Helper to simulate vision API failure
export function simulateVisionFailure(error: Error) {
  shouldFailVision = true;
  visionError = error;
}

// Helper to get call count
export function getCallCount() {
  return callCount;
}

// Mock callAnthropicText
export async function callAnthropicText(
  prompt: string,
  maxTokens: number = 4096,
  model: string = 'claude-sonnet-4-20250514'
): Promise<{ content: string; usage: any }> {
  callCount++;
  
  if (shouldFailText) {
    throw textError || new Error('Mock Anthropic API error');
  }

  if (mockTextResponse) {
    return mockTextResponse;
  }

  // Default mock response
  return {
    content: JSON.stringify({
      intent: 'unclear',
      confidence: 0.5,
      entities_mentioned: [],
      actions_suggested: [],
      topics: [],
      sentiment: 'neutral',
    }),
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// Mock callAnthropicVision
export async function callAnthropicVision(
  prompt: string,
  imageBase64: string,
  mediaType: string,
  maxTokens: number = 4096,
  model: string = 'claude-sonnet-4-20250514'
): Promise<{ content: string; usage: any }> {
  callCount++;
  
  if (shouldFailVision) {
    throw visionError || new Error('Mock Anthropic Vision API error');
  }

  if (mockVisionResponse) {
    return mockVisionResponse;
  }

  // Default mock response
  return {
    content: 'Extracted text from image',
    usage: { input_tokens: 200, output_tokens: 50 },
  };
}

export default {
  callAnthropicText,
  callAnthropicVision,
};

