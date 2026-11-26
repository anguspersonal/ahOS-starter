/**
 * Anthropic client configuration and helper functions
 * Provides text and vision API capabilities
 */

import Anthropic from '@anthropic-ai/sdk';
import logger from './logger';

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!anthropicApiKey) {
  logger.error('Missing Anthropic API key in environment variables');
  throw new Error('Missing Anthropic API key');
}

// Create Anthropic client
export const anthropic = new Anthropic({
  apiKey: anthropicApiKey,
});

logger.info('Anthropic client initialized');

// Default model to use
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Call Anthropic API with text content
 * @param prompt - The text prompt to send
 * @param maxTokens - Maximum tokens to generate (default: 4096)
 * @param model - Model to use (default: claude-sonnet-4-20250514)
 * @returns Promise with content and usage information
 */
export async function callAnthropicText(
  prompt: string,
  maxTokens: number = 4096,
  model: string = DEFAULT_MODEL
): Promise<{ content: string; usage: any }> {
  try {
    logger.debug('Calling Anthropic API (text)', { model, maxTokens });
    
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const textContent = response.content
      .filter((block) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');

    logger.debug('Anthropic API response received', {
      tokens: response.usage,
      contentLength: textContent.length,
    });

    return {
      content: textContent,
      usage: response.usage,
    };
  } catch (error: any) {
    logger.error('Anthropic API call failed', error, {
      model,
      promptLength: prompt.length,
    });
    throw error;
  }
}

/**
 * Call Anthropic API with image content (vision)
 * @param prompt - The text prompt to send with the image
 * @param imageBase64 - Base64-encoded image data
 * @param mediaType - MIME type of the image (e.g., 'image/png', 'image/jpeg')
 * @param maxTokens - Maximum tokens to generate (default: 4096)
 * @param model - Model to use (default: claude-sonnet-4-20250514)
 * @returns Promise with content and usage information
 */
export async function callAnthropicVision(
  prompt: string,
  imageBase64: string,
  mediaType: string,
  maxTokens: number = 4096,
  model: string = DEFAULT_MODEL
): Promise<{ content: string; usage: any }> {
  try {
    logger.debug('Calling Anthropic API (vision)', {
      model,
      maxTokens,
      mediaType,
      imageSize: imageBase64.length,
    });

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType as any,
                data: imageBase64,
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    });

    const textContent = response.content
      .filter((block) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');

    logger.debug('Anthropic API response received', {
      tokens: response.usage,
      contentLength: textContent.length,
    });

    return {
      content: textContent,
      usage: response.usage,
    };
  } catch (error: any) {
    logger.error('Anthropic API call failed', error, {
      model,
      mediaType,
      promptLength: prompt.length,
    });
    throw error;
  }
}

export default anthropic;

