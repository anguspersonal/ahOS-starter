/**
 * Step 2: Analyze Artifact
 * 
 * Performs AI-powered analysis of an artifact's content.
 * Extracts text from various file types and performs content analysis.
 * 
 * Features:
 * - Text extraction from text files, images, and PDFs
 * - Scanned PDF processing (split pages, process with Vision API)
 * - AI content analysis using Anthropic API
 * - Low confidence handling (clarification requests)
 * - Stores extracted text in artifact.extracted_content
 * 
 * @see docs/Step02_Analyze.md
 */

import { supabase } from '../../utils/supabase';
import logger from '../../utils/logger';
import { callAnthropicText, callAnthropicVision } from '../../utils/anthropic';
import { classifyFileType, toSemanticFilename } from '../../utils/helpers';
import type { WorkflowStep } from './types';
import type { ArtifactId, StepId } from './types';
import { updateStepStatus } from './stepStatus';
import sharp from 'sharp';
import path from 'path';

// Constants
const STORAGE_BUCKET = 'user-uploads';
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // Hard limit we support for uploads before failing
const ANTHROPIC_IMAGE_LIMIT = 5 * 1024 * 1024; // Anthropic Vision API per-image limit
const JPEG_MIN_QUALITY = 40;
const JPEG_STARTING_QUALITY = 85;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS = [2000, 4000, 8000]; // Exponential backoff: 2s, 4s, 8s
const LOW_CONFIDENCE_THRESHOLD = 0.5;

// Import PDF processor (CommonJS .js under src/; not compiled to dist, so resolve from __dirname at runtime)
const pdfProcessor = require(path.join(__dirname, '../../../src/services/pdf/processor'));

/**
 * Analysis result structure
 */
export interface AnalysisResult {
  intent: string;                    // "meeting_notes", "personal_reflection", "idea", "reminder", "reference", "task", "document", "unclear"
  title?: string;                     // Suggested title for the artifact
  description?: string;               // Suggested description for the artifact
  tags?: string[];                    // AI-generated tags for the artifact
  entities_mentioned: Array<{
    name: string;
    type: string;                     // "people", "area", "project", "resource"
    confidence: number;                // 0-1
  }>;
  actions_suggested: Array<{
    title: string;
    description?: string;
    priority?: string;                // "low", "medium", "high", "urgent"
    dueDate?: string;                 // "YYYY-MM-DD"
    suggestedDuration?: number;       // minutes
  }>;
  topics: string[];                   // Main themes/keywords
  sentiment: string;                  // "positive", "neutral", "negative", "mixed"
  confidence: number;                 // Overall confidence 0-1
  shouldClean?: boolean;              // For documents/notes, should a cleaned version be created?
}

/**
 * Result of analyze step execution
 */
export interface AnalyzeResult {
  success: boolean;
  status?: string;                    // "awaiting_user" if low confidence
  analysisResult?: AnalysisResult;     // Structured analysis from AI
  tokensUsed?: number;                // Anthropic API tokens consumed
  confidence?: number;                 // Overall confidence (0-1)
  notificationId?: string;             // ID of clarification request (if low confidence)
  error?: string;                      // Error message (if failed)
  errorDetails?: string;               // Detailed error info
}

/**
 * Content preparation result
 */
interface ContentForAnalysis {
  type: 'text' | 'image' | 'error' | 'unsupported';
  content?: string;                    // Text content or base64 image
  extractedText?: string;              // Extracted text (for images/PDFs)
  mimeType?: string;                   // MIME type (for images)
  error?: string;
  /** True when artifact is a captured URL (content.url); use URL-specific prompt and minimal entities/actions */
  isUrlCapture?: boolean;
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convert plain text to HTML for display
 * Escapes HTML entities and converts newlines to <br> tags
 * Returns empty string if conversion fails
 */
function convertTextToHtml(text: string): string {
  if (!text) return '';

  try {
    // Escape HTML entities
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    // Convert newlines to <br> tags
    return escaped.replace(/\n/g, '<br>');
  } catch (error) {
    logger.warn('HTML conversion failed, returning empty string', { error });
    return '';
  }
}

/**
 * Safely convert text to HTML with fallback
 * If conversion fails, returns a basic escaped version
 */
function safeConvertTextToHtml(text: string | null | undefined): string | null {
  if (!text) return null;

  try {
    const html = convertTextToHtml(text);
    return html || null;
  } catch (error) {
    logger.warn('Safe HTML conversion failed, using fallback', { error });
    // Fallback: return basic escaped text wrapped in a pre tag
    try {
      const escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      return `<pre>${escaped}</pre>`;
    } catch (fallbackError) {
      logger.error('HTML conversion fallback also failed', { error: fallbackError });
      return null;
    }
  }
}

/**
 * Download file from Supabase Storage
 */
async function downloadFromStorage(storagePath: string): Promise<Buffer> {
  const { data, error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .download(storagePath);

  if (error) {
    throw new Error(`Failed to download from storage: ${error.message}`);
  }

  if (!data) {
    throw new Error('No data returned from storage download');
  }

  // Convert Blob to Buffer
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Resize/compress large images so they meet Anthropic's 5MB limit
 */
async function prepareImageForVision(
  imageBuffer: Buffer,
  mimeType: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageBuffer.length <= ANTHROPIC_IMAGE_LIMIT) {
    return { buffer: imageBuffer, mimeType };
  }

  logger.warn('Image exceeds Anthropic 5MB limit, attempting to downscale', {
    sizeMb: (imageBuffer.length / 1024 / 1024).toFixed(2),
    limitMb: (ANTHROPIC_IMAGE_LIMIT / 1024 / 1024).toFixed(2),
  });

  let targetBuffer = imageBuffer;
  let targetMimeType = mimeType;
  let quality = JPEG_STARTING_QUALITY;
  const metadata = await sharp(imageBuffer).metadata();
  let resizeWidth = metadata.width || undefined;

  while (targetBuffer.length > ANTHROPIC_IMAGE_LIMIT && quality >= JPEG_MIN_QUALITY) {
    let pipeline = sharp(imageBuffer);

    if (resizeWidth) {
      // Gradually step the width down until we're below the limit
      resizeWidth = Math.max(900, Math.floor(resizeWidth * 0.85));
      pipeline = pipeline.resize({
        width: resizeWidth,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    targetBuffer = await pipeline.jpeg({
      quality,
      mozjpeg: true,
    }).toBuffer();

    targetMimeType = 'image/jpeg';
    quality -= 10;
  }

  if (targetBuffer.length > ANTHROPIC_IMAGE_LIMIT) {
    throw new Error(
      `Image exceeds Anthropic 5MB limit even after compression (current ${(targetBuffer.length / 1024 / 1024).toFixed(2)}MB)`
    );
  }

  logger.info('Downscaled image for Anthropic Vision', {
    originalSizeMb: (imageBuffer.length / 1024 / 1024).toFixed(2),
    resizedSizeMb: (targetBuffer.length / 1024 / 1024).toFixed(2),
    targetMimeType,
    finalQuality: quality + 10,
  });

  return {
    buffer: targetBuffer,
    mimeType: targetMimeType,
  };
}

/**
 * Process image: download, convert to base64, extract text with Vision API
 */
async function processImage(artifact: any): Promise<string> {
  logger.info('Processing image for text extraction', {
    artifactId: artifact.id,
    storagePath: artifact.storage_path,
  });

  // Download image from storage
  const imageBuffer = await downloadFromStorage(artifact.storage_path);

  // Check size limit
  if (imageBuffer.length > MAX_IMAGE_SIZE) {
    throw new Error(`Image too large (${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB). Maximum size is 20MB for vision API.`);
  }

  // Get MIME type from artifact metadata
  const mimeType = artifact.file_metadata?.mime_type || artifact.file_type || 'image/jpeg';

  // Resize/compress if needed to meet Anthropic's 5MB limit
  const { buffer: preparedBuffer, mimeType: preparedMimeType } = await prepareImageForVision(
    imageBuffer,
    mimeType
  );

  // Convert to base64
  const base64Image = preparedBuffer.toString('base64');

  // Extract text using Anthropic Vision
  const extractionPrompt = 'Extract all text from this image. Include any handwritten text, printed text, labels, captions, or other textual content. Preserve the structure and formatting as much as possible.';

  const visionResult = await callAnthropicVision(
    extractionPrompt,
    base64Image,
    preparedMimeType
  );

  logger.info('Image text extraction complete', {
    artifactId: artifact.id,
    textLength: visionResult.content.length,
  });

  return visionResult.content;
}

/**
 * Process PDF: detect type and extract text
 */
async function processPdf(artifact: any): Promise<string> {
  logger.info('Processing PDF for text extraction', {
    artifactId: artifact.id,
    storagePath: artifact.storage_path,
  });

  // Download PDF from storage
  const pdfBuffer = await downloadFromStorage(artifact.storage_path);

  // Process PDF with cleanup (handles temp directory management)
  const result = await pdfProcessor.processPdfWithCleanup(
    pdfBuffer,
    async (buffer: Buffer, pdfPath: string, workDir: string) => {
      // Use processPdf to detect type and get initial result
      const pdfResult = await pdfProcessor.processPdf(buffer, pdfPath, workDir, 150);

      if (pdfResult.is_scanned && pdfResult.type === 'images') {
        // Scanned PDF: Split into pages and process each with Vision API
        logger.info('Processing scanned PDF', {
          artifactId: artifact.id,
          pageCount: pdfResult.page_count,
        });

        const pageImages = pdfResult.files;
        const extractedTexts: string[] = [];

        // Process each page with Anthropic Vision
        for (let i = 0; i < pageImages.length; i++) {
          const pageImage = pageImages[i];
          logger.debug(`Processing PDF page ${i + 1}/${pageImages.length}`, {
            artifactId: artifact.id,
            pageNumber: i + 1,
          });

          const extractionPrompt = `Extract all text from this PDF page (page ${i + 1} of ${pageImages.length}). Include any handwritten text, printed text, labels, captions, or other textual content. Preserve the structure and formatting as much as possible.`;

          try {
            const visionResult = await callAnthropicVision(
              extractionPrompt,
              pageImage.dataBase64,
              pageImage.contentType
            );

            extractedTexts.push(visionResult.content);

            // Add page break separator (except for last page)
            if (i < pageImages.length - 1) {
              extractedTexts.push('\n\n--- Page Break ---\n\n');
            }
          } catch (error: any) {
            logger.error(`Failed to process PDF page ${i + 1}`, {
              artifactId: artifact.id,
              pageNumber: i + 1,
              error: error.message,
            });
            // Continue with other pages even if one fails
            extractedTexts.push(`\n[Error extracting text from page ${i + 1}]\n`);
          }
        }

        const combinedText = extractedTexts.join('');
        logger.info('Scanned PDF processing complete', {
          artifactId: artifact.id,
          pageCount: pageImages.length,
          textLength: combinedText.length,
        });

        return combinedText;
      } else if (pdfResult.type === 'text' && pdfResult.text) {
        // Text-based PDF: Use extracted text
        logger.info('Processing text-based PDF', {
          artifactId: artifact.id,
          pageCount: pdfResult.page_count,
          textLength: pdfResult.text_length,
        });

        return pdfResult.text;
      } else {
        throw new Error('Unexpected PDF processing result');
      }
    }
  );

  return result;
}

// ---------------------------------------------------------------------------
// Content preparer registry (Strategy / OCP)
// To support a new file type, add an entry to CONTENT_PREPARERS below.
// prepareContentForAI never needs to change.
// ---------------------------------------------------------------------------

async function prepareTextContent(artifact: any): Promise<ContentForAnalysis> {
  logger.debug('Preparing text content', { artifactId: artifact.id });
  const contentObj = artifact.content as { url?: string; text?: string } | null;
  const url = contentObj?.url?.trim();
  const text = contentObj?.text?.trim() || '';
  if (url) {
    const combined = text ? `URL: ${url}\n\nUser notes: ${text}` : `URL: ${url}`;
    return { type: 'text', content: combined, extractedText: combined, isUrlCapture: true };
  }
  return { type: 'text', content: text, extractedText: text };
}

async function prepareImageContent(artifact: any): Promise<ContentForAnalysis> {
  try {
    const extractedText = await processImage(artifact);
    return { type: 'text', content: extractedText, extractedText };
  } catch (error: any) {
    logger.error('Failed to process image', { artifactId: artifact.id, error: error.message });
    return { type: 'error', error: `Image processing failed: ${error.message}` };
  }
}

async function preparePdfContent(artifact: any): Promise<ContentForAnalysis> {
  try {
    const extractedText = await processPdf(artifact);
    return { type: 'text', content: extractedText, extractedText };
  } catch (error: any) {
    logger.error('Failed to process PDF', { artifactId: artifact.id, error: error.message });
    return { type: 'error', error: `PDF processing failed: ${error.message}` };
  }
}

async function prepareVideoAudioContent(artifact: any): Promise<ContentForAnalysis> {
  const { contentSubtype } = classifyFileType(artifact.file_type, artifact.filename);
  logger.warn('Video/Audio not supported for text extraction', { artifactId: artifact.id });
  return { type: 'unsupported', error: `Content type ${contentSubtype} not supported for text extraction` };
}

type ContentPreparerFn = (artifact: any) => Promise<ContentForAnalysis>;

interface ContentPreparerEntry {
  matches: (artifact: any, classification: { contentType: string; contentSubtype?: string }) => boolean;
  prepare: ContentPreparerFn;
}

const CONTENT_PREPARERS: ContentPreparerEntry[] = [
  {
    matches: (_, cls) => cls.contentType === 'text',
    prepare: prepareTextContent,
  },
  {
    matches: (_, cls) => cls.contentSubtype === 'photo' || cls.contentSubtype === 'screenshot',
    prepare: prepareImageContent,
  },
  {
    matches: (artifact) => artifact.file_extension === 'pdf' || artifact.file_type === 'application/pdf',
    prepare: preparePdfContent,
  },
  {
    matches: (_, cls) => cls.contentSubtype === 'video' || cls.contentSubtype === 'audio',
    prepare: prepareVideoAudioContent,
  },
];

/**
 * Prepare content for AI analysis based on artifact type.
 * New file types are supported by adding an entry to CONTENT_PREPARERS above.
 */
async function prepareContentForAI(artifact: any): Promise<ContentForAnalysis> {
  const classification = classifyFileType(artifact.file_type, artifact.filename);
  for (const entry of CONTENT_PREPARERS) {
    if (entry.matches(artifact, classification)) {
      return entry.prepare(artifact);
    }
  }
  return {
    type: 'unsupported',
    error: `Content type ${classification.contentType}/${classification.contentSubtype} not supported for analysis`,
  };
}

/**
 * Build analysis prompt for Anthropic API (URL capture variant)
 */
function buildAnalysisPromptForUrl(contentForAnalysis: ContentForAnalysis, userContent?: string | null, filename?: string | null): string {
  let prompt = `You are analyzing a user's captured URL (bookmark/link). The user saved a link for later reference.

Extract the following:

1. **Intent**: Usually "reference" or "bookmark". Options: meeting_notes, personal_reflection, idea, reminder, reference, task, document, unclear

2. **Title**: A concise, descriptive title for this link (string, max 100 characters). Infer from the URL or user notes what the site/page is about.

3. **Description**: A brief 1-2 sentence description of what the site is about and how it could be useful or relevant to the user (string, max 500 characters).

4. **Tags**: Relevant tags/keywords (array of strings, max 5-10), e.g. reference, website, bookmark, and topic-based tags. Format: ["tag1", "tag2", "tag3"]

5. **entities_mentioned**: Leave EMPTY [] unless the user's notes explicitly mention specific people, projects, areas, or resources by name. For a plain URL with no such mentions, return []. Format: [{"name": string, "type": string, "confidence": 0-1}]

6. **actions_suggested**: Leave EMPTY [] unless the user's notes explicitly mention a task, reminder, or follow-up. For a plain URL bookmark, return []. Format: [{"title": string, "description": string, "priority": string, "dueDate": string}]

7. **Topics**: Main themes or keywords from the URL or user notes (array of strings).

8. **Sentiment**: positive, neutral, negative, mixed.

9. **Confidence**: 0-1. Use 0.8+ when the URL and any user notes give clear context.

10. **shouldClean**: false (not applicable for URL captures).

Return ONLY a JSON object with these fields. No markdown, no explanation.

Captured content:
`;
  if (contentForAnalysis.type === 'text' && contentForAnalysis.content) {
    prompt += `\n${contentForAnalysis.content}`;
  }
  if (userContent && userContent.length > 0) {
    prompt += `\n\nUser-provided context:\n${userContent}`;
  }
  if (filename) {
    prompt += `\n\nFilename: ${filename}`;
  }
  prompt += `\n\nCurrent date/time: ${new Date().toISOString()}`;
  return prompt;
}

/**
 * Build analysis prompt for Anthropic API (general artifact)
 */
function buildAnalysisPrompt(contentForAnalysis: ContentForAnalysis, userContent?: string | null, filename?: string | null): string {
  if (contentForAnalysis.isUrlCapture) {
    return buildAnalysisPromptForUrl(contentForAnalysis, userContent, filename);
  }

  let prompt = `You are analyzing a user's captured artifact. Extract the following:

1. **Intent**: What is the user trying to do?
   Options: meeting_notes, personal_reflection, idea, reminder, reference, task, document, unclear

2. **Title**: A concise, descriptive title for this artifact (string, max 100 characters)
   - Should summarize the main content or purpose. Do not return the filename verbatim.
   - Use the filename only as inspiration (e.g. for "Work-Pitch-Deck.pdf" use "Work Pitch Deck" or the company/product name).

3. **Description**: A brief 1-2 sentence description of the artifact's content and purpose (string, max 500 characters)
   - Should provide context about what the artifact contains
   - Help users quickly understand what they captured

4. **Tags**: Relevant tags/keywords (array of strings, max 5-10 tags)
   - Should be short, relevant keywords
   - Help with categorization and search
   - Format: ["tag1", "tag2", "tag3"]

5. **entities_mentioned**: List any people, projects, areas, or resources
   - People: names of individuals
   - Projects: specific projects or initiatives
   - Areas: categories/domains (Finance, Home, Work, etc.)
   - Resources: reusable materials (articles, recipes, tutorials)
   
   Format: [{"name": string, "type": string, "confidence": 0-1}]

6. **actions_suggested**: Any tasks, reminders, or follow-ups needed
   Format: [{"title": string, "description": string, "priority": string, "dueDate": string}]

7. **Topics**: Main themes or keywords (array of strings)

8. **Sentiment**: Overall emotional tone
   Options: positive, neutral, negative, mixed

9. **Confidence**: How confident are you in this analysis? (0-1 scale)
   - 0.9-1.0: Very confident
   - 0.7-0.9: Confident
   - 0.5-0.7: Somewhat confident
   - 0.0-0.5: Not confident (will ask user for clarification)

10. **shouldClean**: For documents/meeting notes, should a cleaned version be created? (boolean)

Return ONLY a JSON object with these fields. No markdown, no explanation.

Artifact content type: ${contentForAnalysis.type}

`;

  if (contentForAnalysis.type === 'text' && contentForAnalysis.content) {
    prompt += `Text content:\n${contentForAnalysis.content}`;
  }

  if (userContent && userContent.length > 0) {
    prompt += `\n\nUser-provided context:\n${userContent}`;
  }

  if (filename) {
    prompt += `\n\nFilename: ${filename}`;
  }

  prompt += `\n\nCurrent date/time: ${new Date().toISOString()}`;

  return prompt;
}

/**
 * Parse AI response JSON
 */
function parseAIResponse(content: string): AnalysisResult {
  // Remove markdown code fences if present
  let text = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // Try to extract JSON from response if it's wrapped in text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    text = jsonMatch[0];
  }

  try {
    const analysisResult = JSON.parse(text) as AnalysisResult;

    // Validate required fields
    if (!analysisResult.intent) {
      throw new Error('Missing required field: intent');
    }

    if (typeof analysisResult.confidence !== 'number') {
      throw new Error('Missing or invalid required field: confidence');
    }

    // Map 'entities' to 'entities_mentioned' if AI returned entities in wrong field
    // Some AI models return 'entities' instead of 'entities_mentioned'
    if (Array.isArray((analysisResult as any).entities) && 
        (!Array.isArray(analysisResult.entities_mentioned) || analysisResult.entities_mentioned.length === 0)) {
      analysisResult.entities_mentioned = (analysisResult as any).entities;
    }

    // Ensure arrays exist (even if empty)
    if (!Array.isArray(analysisResult.entities_mentioned)) {
      analysisResult.entities_mentioned = [];
    }

    if (!Array.isArray(analysisResult.actions_suggested)) {
      analysisResult.actions_suggested = [];
    }

    if (!Array.isArray(analysisResult.topics)) {
      analysisResult.topics = [];
    }

    // Ensure tags array exists and sanitize
    if (!Array.isArray(analysisResult.tags)) {
      analysisResult.tags = [];
    } else {
      // Sanitize tags (remove empty strings, trim, limit length)
      analysisResult.tags = analysisResult.tags
        .filter(tag => typeof tag === 'string' && tag.trim().length > 0)
        .map(tag => tag.trim().slice(0, 50)) // Limit tag length to 50 chars
        .slice(0, 10); // Limit to 10 tags
    }

    // Default values
    if (!analysisResult.sentiment) {
      analysisResult.sentiment = 'neutral';
    }

    if (typeof analysisResult.shouldClean !== 'boolean') {
      analysisResult.shouldClean = false;
    }

    // Ensure title and description are strings if provided, or undefined
    if (analysisResult.title !== undefined && typeof analysisResult.title !== 'string') {
      analysisResult.title = String(analysisResult.title);
    }
    if (analysisResult.description !== undefined && typeof analysisResult.description !== 'string') {
      analysisResult.description = String(analysisResult.description);
    }

    return analysisResult;
  } catch (parseError: any) {
    throw new Error(`Failed to parse AI response as JSON: ${parseError.message}`);
  }
}

/**
 * Create clarification notification for low confidence analysis
 */
async function createClarificationNotification(
  artifactId: string,
  userId: string,
  teamId: number | null | undefined,
  step: WorkflowStep,
  analysisResult: AnalysisResult
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('system_decisions')
      .insert({
        user_id: userId,
        team_id: teamId || null,
        artifact_id: artifactId,
        decision_type: 'clarification_needed',
        stage: 'extract',
        title: 'Help me understand this artifact',
        description: `I analyzed your artifact but I'm not confident. Intent: ${analysisResult.intent} (confidence: ${(analysisResult.confidence * 100).toFixed(0)}%). Can you provide more context?`,
        confidence_score: Math.round(analysisResult.confidence * 100),
        blocking: true,
        user_visible: true,
        requires_user_action: true,
        status: 'pending',
        review_type: 'clarification',
        decision_payload: {
          artifactId: artifactId,
          workflowId: step.workflow_id,
          workflowStepId: step.id,
          currentAnalysis: analysisResult,
        },
        workflow_task_id: step.id,
      })
      .select('id')
      .single();

    if (error) {
      logger.error('Failed to create clarification notification', error);
      return null;
    }

    logger.info('Created clarification notification', { notificationId: data.id });
    return data.id;
  } catch (err) {
    logger.error('Error creating clarification notification', err as Error);
    return null;
  }
}

function computeArtifactTitleAndFilename(
  artifact: { filename?: string | null; original_file_name?: string | null },
  analysisResult: AnalysisResult,
  extractedText: string,
  shortId: string
): { title: string; description: string | null; semanticFilename: string } {
  let title = analysisResult.title?.trim() || artifact.filename || artifact.original_file_name || 'Untitled';
  const uploadFileName = artifact.original_file_name || artifact.filename || '';
  const uploadBaseName = uploadFileName.replace(/\.[^.]+$/, '').trim();
  const looksLikeUploadName =
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(title) ||
    title === uploadFileName ||
    (uploadBaseName.length > 0 && title.toLowerCase() === uploadBaseName.toLowerCase());
  if (looksLikeUploadName && extractedText.trim().length > 0) {
    const firstLine = extractedText.trim().split(/\r?\n/)[0]?.trim().slice(0, 80) || '';
    if (firstLine.length > 0) title = firstLine;
  }
  if (looksLikeUploadName && (!title || title.length === 0)) title = 'Untitled document';
  if (looksLikeUploadName && title && extractedText.trim().length === 0) {
    const readable = uploadBaseName.replace(/[-_]+/g, ' ').trim() || uploadBaseName;
    if (readable.length > 0) title = `Document: ${readable.slice(0, 60)}`;
  }
  const description = analysisResult.description?.trim() ||
    (extractedText.length > 0 ? extractedText.slice(0, 240) : null);
  const originalFileName = artifact.original_file_name ?? artifact.filename ?? '';
  const semanticFilename = toSemanticFilename(title, originalFileName, { shortId });
  return { title, description, semanticFilename };
}

/**
 * Execute the analyze step
 *
 * This function:
 * 1. Fetches artifact from database
 * 2. Prepares content for AI analysis (extracts text from various file types)
 * 3. Updates artifact.extracted_content if text was extracted
 * 4. Builds prompt and calls Anthropic API
 * 5. Parses response and handles low confidence
 * 6. Returns analysis result
 */
export async function executeAnalyzeStep(
  step: WorkflowStep,
  artifactId: ArtifactId,
  stepId: StepId
): Promise<AnalyzeResult> {
  const startTime = Date.now();

  logger.info('Starting analyze step', {
    stepId: stepId.value,
    artifactId: artifactId.value,
  });

  // 1. UPDATE STEP STATUS TO PROCESSING
  await updateStepStatus(stepId, 'running', {
    started_at: new Date().toISOString(),
    message: 'Starting AI content analysis',
  });

  // 2. FETCH ARTIFACT
  const { data: artifact, error: fetchError } = await supabase
    .from('artifacts')
    .select('*')
    .eq('id', artifactId.value)
    .single();

  if (fetchError || !artifact) {
    logger.error('Artifact not found', { artifactId: artifactId.value, error: fetchError });
    await updateStepStatus(stepId, 'failed', {
      message: `Artifact not found for ID: ${artifactId.value}`,
      error_message: fetchError?.message || 'Artifact not found',
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    return {
      success: false,
      error: 'Artifact not found',
      errorDetails: fetchError?.message,
    };
  }

  // 3. PREPARE CONTENT FOR AI ANALYSIS
  let contentForAnalysis: ContentForAnalysis;
  try {
    contentForAnalysis = await prepareContentForAI(artifact);
  } catch (error: any) {
    logger.error('Content preparation failed', { artifactId: artifactId.value, error: error.message });

    // Update artifact with error
    await supabase
      .from('artifacts')
      .update({
        processing_status: 'failed',
        processing_error: error.message,
        // Keep lifecycle_stage as 'uploaded' since file was successfully uploaded
      })
      .eq('id', artifactId.value);

    await updateStepStatus(stepId, 'failed', {
      message: `Content preparation failed: ${error.message}`,
      error_message: error.message,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    return {
      success: false,
      error: 'Content preparation failed',
      errorDetails: error.message,
    };
  }

  // Check if content preparation failed
  if (contentForAnalysis.type === 'error' || contentForAnalysis.type === 'unsupported') {
    const errorMessage = contentForAnalysis.error || 'Unsupported content type';

    // Update artifact with error
    await supabase
      .from('artifacts')
      .update({
        processing_status: 'failed',
        processing_error: errorMessage,
        // Keep lifecycle_stage as 'uploaded' since file was successfully uploaded
      })
      .eq('id', artifactId.value);

    await updateStepStatus(stepId, 'failed', {
      message: errorMessage,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    return {
      success: false,
      error: errorMessage,
    };
  }

  // 4. UPDATE ARTIFACT WITH EXTRACTED TEXT (if available)
  if (contentForAnalysis.extractedText) {
    try {
      const { error: updateError } = await supabase
        .from('artifacts')
        .update({
          extracted_content: contentForAnalysis.extractedText,
          plain_text: contentForAnalysis.extractedText,
          extraction_confidence: 1.0, // Successful extraction
          content_html: safeConvertTextToHtml(contentForAnalysis.extractedText),
        })
        .eq('id', artifactId.value);

      if (updateError) {
        logger.warn('Failed to update artifact with extracted text', {
          artifactId: artifactId.value,
          error: updateError.message,
        });
        // Non-fatal - continue with analysis
      } else {
        logger.info('Updated artifact with extracted text', {
          artifactId: artifactId.value,
          textLength: contentForAnalysis.extractedText.length,
        });
      }
    } catch (error: any) {
      logger.warn('Error updating artifact with extracted text', {
        artifactId: artifactId.value,
        error: error.message,
      });
      // Non-fatal - continue with analysis
    }
  }

  // 5. BUILD AI ANALYSIS PROMPT
  const textContent = (artifact.content as { text?: string } | null)?.text || '';
  const prompt = buildAnalysisPrompt(contentForAnalysis, textContent, artifact.filename || null);

  // 6. CALL AI API WITH RETRY LOGIC
  let lastError: Error | null = null;
  let attempt = 0;
  let tokensUsed = 0;
  let aiResponse: { content: string; usage: any } | null = null;

  while (attempt < MAX_RETRY_ATTEMPTS) {
    attempt++;

    try {
      logger.info(`Calling Anthropic API (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`, {
        artifactId: artifactId.value,
        contentType: contentForAnalysis.type,
      });

      aiResponse = await callAnthropicText(prompt, 4096);
      tokensUsed = aiResponse.usage.input_tokens + aiResponse.usage.output_tokens;

      logger.info('Anthropic API call successful', {
        artifactId,
        attempt,
        tokensUsed,
      });

      break; // Success!
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));

      logger.warn(`Anthropic API call failed (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})`, {
        artifactId: artifactId.value,
        error: lastError.message,
        attempt,
      });

      // Wait before retry (if not last attempt)
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAYS[attempt - 1];
        logger.info(`Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  // Check if all retries failed
  if (!aiResponse) {
    logger.error('Anthropic API call failed after all retries', {
      artifactId: artifactId.value,
      lastError: lastError?.message,
    });

    const errorMessage = lastError?.message || 'Unknown error';

    // Update artifact with error
    await supabase
      .from('artifacts')
      .update({
        processing_status: 'failed',
        processing_error: `AI API call failed after ${MAX_RETRY_ATTEMPTS} attempts: ${errorMessage}`,
        // Keep lifecycle_stage as 'uploaded' since file was successfully uploaded
      })
      .eq('id', artifactId.value);

    await updateStepStatus(stepId, 'failed', {
      message: `AI API call failed after ${MAX_RETRY_ATTEMPTS} attempts: ${errorMessage}`,
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    return {
      success: false,
      error: 'AI API call failed',
      errorDetails: errorMessage,
    };
  }

  // 7. PARSE AI RESPONSE
  let analysisResult: AnalysisResult;
  try {
    analysisResult = parseAIResponse(aiResponse.content);
    logger.info('AI response parsed successfully', {
      artifactId,
      intent: analysisResult.intent,
      confidence: analysisResult.confidence,
    });
  } catch (parseError: any) {
    logger.error('Failed to parse AI response', {
      artifactId,
      error: parseError.message,
    });

    // Update artifact with error
    await supabase
      .from('artifacts')
      .update({
        processing_status: 'failed',
        processing_error: `Failed to parse AI response: ${parseError.message}`,
        // Keep lifecycle_stage as 'uploaded' since file was successfully uploaded
      })
      .eq('id', artifactId.value);

    await updateStepStatus(stepId, 'failed', {
      message: `Failed to parse AI response: ${parseError.message}`,
      error_message: parseError.message,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    return {
      success: false,
      error: 'Failed to parse AI response',
      errorDetails: parseError.message,
    };
  }

  // For URL captures, ensure entities/actions are empty so workflow skips organize_entities and extract_actions
  if (contentForAnalysis.isUrlCapture) {
    analysisResult.entities_mentioned = [];
    analysisResult.actions_suggested = [];
  }

  // 8. HANDLE LOW CONFIDENCE (or accept and proceed if user already chose "Continue without more context")
  if (analysisResult.confidence < LOW_CONFIDENCE_THRESHOLD) {
    const continuedWithoutClarification = (artifact.processing_metadata as Record<string, unknown>)?.user_continued_without_clarification === true;
    if (continuedWithoutClarification) {
      // User previously clicked "Continue without more context"; accept low confidence and proceed.
      const meta = { ...(artifact.processing_metadata || {}), user_continued_without_clarification: undefined } as Record<string, unknown>;
      delete meta.user_continued_without_clarification;
      await supabase
        .from('artifacts')
        .update({ processing_metadata: meta })
        .eq('id', artifactId.value);
      (artifact as Record<string, unknown>).processing_metadata = meta;
      logger.info('Low confidence accepted (user continued without context)', { artifactId: artifactId.value, confidence: analysisResult.confidence });
      // Fall through to store analysis and complete step (same as high-confidence path below).
    } else {
      logger.warn('Low confidence analysis', {
        artifactId: artifactId.value,
        confidence: analysisResult.confidence,
      });

      // Create clarification notification
      const notificationId = await createClarificationNotification(
      artifactId.value,
      artifact.user_id,
      artifact.team_id,
      step,
      analysisResult
    );

    // Update step status (use 'pending' for awaiting user input)
    await updateStepStatus(stepId, 'pending', {
      message: `Low confidence analysis (confidence: ${(analysisResult.confidence * 100).toFixed(0)}%)`,
      notification_id: notificationId,
      output: analysisResult as unknown as Record<string, unknown>,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    // Update artifact (include title/description if provided, with fallbacks)
    const extractedText = contentForAnalysis.extractedText || '';
    const { title, description, semanticFilename } = computeArtifactTitleAndFilename(
      artifact, analysisResult, extractedText, artifactId.value.slice(0, 8)
    );

    const { error: updateError } = await supabase
      .from('artifacts')
      .update({
        lifecycle_stage: 'needs_review',
        processing_status: 'pending',
        title: title || null,
        description: description || null,
        filename: semanticFilename,
        plain_text: extractedText || '', // Always set so Content section has an editable field
        extraction_confidence: extractedText ? 1.0 : null,
        content_html: safeConvertTextToHtml(extractedText),
        tags: analysisResult.tags || [],
        processing_metadata: {
          ...(artifact.processing_metadata || {}),
          analysis: analysisResult,
        },
      })
      .eq('id', artifactId.value);

    if (updateError) {
      logger.error('Failed to update artifact with analysis (low confidence path)', {
        artifactId: artifactId.value,
        error: updateError.message,
        code: updateError.code,
      });
      await updateStepStatus(stepId, 'failed', {
        message: `Could not save analysis: ${updateError.message}`,
        error_message: updateError.message,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      });
      return {
        success: false,
        error: 'Failed to update artifact with analysis',
        errorDetails: updateError.message,
      };
    }

    return {
      success: true,
      status: 'awaiting_user',
      confidence: analysisResult.confidence,
      notificationId: notificationId || undefined,
      analysisResult,
      tokensUsed,
    };
    }
  }

  // 9. STORE ANALYSIS RESULTS (high confidence, or low confidence after user continued without context)
  const extractedText = contentForAnalysis.extractedText || '';
  const { title, description, semanticFilename } = computeArtifactTitleAndFilename(
    artifact, analysisResult, extractedText, artifactId.value.slice(0, 8)
  );

  const { error: updateError } = await supabase
    .from('artifacts')
    .update({
      lifecycle_stage: 'analysed',
      processing_status: 'in_progress', // DB constraint allows only pending|in_progress|completed|failed
      title: title || null,
      description: description || null,
      filename: semanticFilename,
      plain_text: extractedText || '', // Always set so Content section has an editable field
      extraction_confidence: extractedText ? 1.0 : null,
      content_html: safeConvertTextToHtml(extractedText),
      tags: analysisResult.tags || [],
      processing_metadata: {
        ...(artifact.processing_metadata || {}),
        analysis: analysisResult,
      },
    })
    .eq('id', artifactId.value);

  if (updateError) {
    logger.error('Failed to update artifact with analysis results', {
      artifactId: artifactId.value,
      error: updateError.message,
      code: updateError.code,
    });
    await updateStepStatus(stepId, 'failed', {
      message: `Could not save analysis: ${updateError.message}`,
      error_message: updateError.message,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });
    return {
      success: false,
      error: 'Failed to update artifact with semantic title/filename',
      errorDetails: updateError.message,
    };
  }

  await updateStepStatus(stepId, 'completed', {
    message: `Analysis complete: ${analysisResult.intent}`,
    output: analysisResult as unknown as Record<string, unknown>,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
  });

  logger.info('Analyze step completed successfully', {
    artifactId: artifactId.value,
    intent: analysisResult.intent,
    confidence: analysisResult.confidence,
    tokensUsed,
    durationMs: Date.now() - startTime,
  });

  // 10. RETURN RESULTS
  return {
    success: true,
    analysisResult,
    tokensUsed,
    confidence: analysisResult.confidence,
  };
}

/**
 * Run extraction only for an artifact (no AI analysis).
 * Used by regenerate-content API to re-extract text and update plain_text/content_html.
 * Returns the new plain_text and content_html, or null if extraction failed or unsupported.
 */
export async function runExtractionOnly(artifactId: string): Promise<{ plain_text: string; content_html: string | null } | null> {
  const { data: artifact, error: fetchError } = await supabase
    .from('artifacts')
    .select('*')
    .eq('id', artifactId)
    .single();

  if (fetchError || !artifact) {
    logger.warn('runExtractionOnly: artifact not found', { artifactId, error: fetchError?.message });
    return null;
  }

  let contentForAnalysis: ContentForAnalysis;
  try {
    contentForAnalysis = await prepareContentForAI(artifact);
  } catch (error: any) {
    logger.warn('runExtractionOnly: content preparation failed', { artifactId, error: error?.message });
    return null;
  }

  if (contentForAnalysis.type === 'error' || contentForAnalysis.type === 'unsupported' || !contentForAnalysis.extractedText) {
    logger.info('runExtractionOnly: no extracted text', { artifactId, type: contentForAnalysis.type });
    return null;
  }

  const plainText = contentForAnalysis.extractedText;
  const contentHtml = safeConvertTextToHtml(plainText);

  const { error: updateError } = await supabase
    .from('artifacts')
    .update({
      plain_text: plainText,
      content_html: contentHtml,
      extraction_confidence: 1.0,
    })
    .eq('id', artifactId);

  if (updateError) {
    logger.warn('runExtractionOnly: failed to update artifact', { artifactId, error: updateError.message });
    return null;
  }

  return { plain_text: plainText, content_html: contentHtml };
}

