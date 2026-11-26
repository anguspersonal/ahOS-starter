/**
 * Helper utility functions for the worker
 */

import { randomUUID } from 'crypto';

/**
 * Generate a UUID v4 (random UUID)
 * Uses Node.js crypto.randomUUID() for standard UUID generation
 * @returns A UUID string in the format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
 */
export function generateUUID(): string {
  return randomUUID();
}

/**
 * Sanitize filename for safe storage
 * Removes invalid characters, normalizes underscores, and limits length
 * @param fileName - The original filename
 * @returns Sanitized filename safe for file system storage
 */
export function sanitizeFileName(fileName: string): string {
  if (!fileName || typeof fileName !== 'string') {
    return 'unnamed_file';
  }

  // Replace invalid characters with underscore
  let sanitized = fileName
    .replace(/[^a-zA-Z0-9._-]/g, '_')  // Replace invalid chars with underscore
    .replace(/_{2,}/g, '_')              // Replace multiple underscores with single
    .replace(/^_|_$/g, '');             // Remove leading/trailing underscores

  // Ensure filename is not empty
  if (sanitized.length === 0) {
    return 'unnamed_file';
  }

  // Limit length to 100 characters (preserving extension)
  if (sanitized.length > 100) {
    const lastDotIndex = sanitized.lastIndexOf('.');
    if (lastDotIndex > 0 && lastDotIndex < sanitized.length - 1) {
      // Has extension
      const extension = sanitized.substring(lastDotIndex);
      const nameWithoutExt = sanitized.substring(0, lastDotIndex);
      const maxNameLength = 100 - extension.length;
      sanitized = nameWithoutExt.substring(0, maxNameLength) + extension;
    } else {
      // No extension, just truncate
      sanitized = sanitized.substring(0, 100);
    }
  }

  return sanitized;
}

/**
 * Build semantic filename: slug_domain_MmmYyyy.ext (e.g. internal-ai-agents-proposal-document_Work_Mar2026.pdf).
 * Used after analysis to set artifact.filename from AI title while preserving extension from original upload.
 *
 * @param title - Display title from analysis (e.g. "AI Agents Proposal")
 * @param originalFileName - Original upload filename (e.g. "work_ai_agents_overview.pdf") for extension
 * @param options - Optional domain (e.g. "Work") and shortId (e.g. first 8 chars of artifact id) for uniqueness
 * @returns Semantic filename safe for storage and exports
 */
export function toSemanticFilename(
  title: string,
  originalFileName: string,
  options?: { domain?: string; shortId?: string }
): string {
  if (!title || typeof title !== 'string') {
    title = 'untitled';
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const base = slug || 'untitled';

  const ext =
    typeof originalFileName === 'string' && originalFileName.includes('.')
      ? originalFileName.slice(originalFileName.lastIndexOf('.'))
      : '';

  const now = new Date();
  const mmmYyyy =
    now.toLocaleString('en-GB', { month: 'short' }) + now.getFullYear();

  const parts = [base];
  if (options?.domain?.trim()) {
    parts.push(options.domain.trim().replace(/[^a-zA-Z0-9_-]/g, ''));
  }
  parts.push(mmmYyyy);
  if (options?.shortId?.trim()) {
    parts.push(String(options.shortId).trim().slice(0, 8));
  }

  return parts.join('_') + ext;
}

/**
 * Calculate string similarity using longest common substring ratio
 * Returns a value between 0 (no similarity) and 1 (identical)
 * @param str1 - First string to compare
 * @param str2 - Second string to compare
 * @returns Similarity score between 0 and 1
 */
export function calculateStringSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;

  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();

  const lcsLength = longestCommonSubstring(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);

  if (maxLen === 0) return 1; // Both empty strings

  return lcsLength / maxLen;
}

/**
 * Longest common substring algorithm (helper for calculateStringSimilarity)
 * @param str1 - First string
 * @param str2 - Second string
 * @returns Length of the longest common substring
 */
function longestCommonSubstring(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  let maxLength = 0;

  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        maxLength = Math.max(maxLength, dp[i][j]);
      } else {
        dp[i][j] = 0;
      }
    }
  }

  return maxLength;
}

/**
 * Format file size in bytes to human-readable string
 * @param bytes - File size in bytes
 * @returns Human-readable file size string (e.g., "1.5 MB")
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  if (bytes < 0) return '0 Bytes'; // Handle negative values

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Parse date/time string into Date object
 * Supports various formats: ISO 8601, common date formats, and natural language
 * @param dateTimeString - Date/time string to parse
 * @returns Date object or null if parsing fails
 */
export function parseDateTime(dateTimeString: string | null | undefined): Date | null {
  if (!dateTimeString || typeof dateTimeString !== 'string') {
    return null;
  }

  const trimmed = dateTimeString.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Try ISO 8601 format first (most common)
  const isoDate = new Date(trimmed);
  if (!isNaN(isoDate.getTime())) {
    return isoDate;
  }

  // Try common date formats
  const commonFormats = [
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,  // YYYY-MM-DD HH:MM:SS
    /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/,          // YYYY-MM-DD HH:MM
    /^(\d{4})-(\d{2})-(\d{2})$/,                              // YYYY-MM-DD
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/, // MM/DD/YYYY HH:MM:SS
    /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/,         // MM/DD/YYYY HH:MM
    /^(\d{2})\/(\d{2})\/(\d{4})$/,                            // MM/DD/YYYY
  ];

  for (const format of commonFormats) {
    const match = trimmed.match(format);
    if (match) {
      let date: Date;
      if (format.source.includes('\\/')) {
        // MM/DD/YYYY format
        const [, month, day, year, hour, minute, second] = match;
        date = new Date(
          parseInt(year),
          parseInt(month) - 1,
          parseInt(day),
          hour ? parseInt(hour) : 0,
          minute ? parseInt(minute) : 0,
          second ? parseInt(second) : 0
        );
      } else {
        // YYYY-MM-DD format
        const [, year, month, day, hour, minute, second] = match;
        date = new Date(
          parseInt(year),
          parseInt(month) - 1,
          parseInt(day),
          hour ? parseInt(hour) : 0,
          minute ? parseInt(minute) : 0,
          second ? parseInt(second) : 0
        );
      }
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }

  // Try natural language relative dates (basic support)
  const now = new Date();
  const lower = trimmed.toLowerCase();
  
  if (lower.includes('today')) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
  if (lower.includes('tomorrow')) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }
  if (lower.includes('yesterday')) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }

  // Last resort: try Date constructor with the original string
  const fallbackDate = new Date(trimmed);
  if (!isNaN(fallbackDate.getTime())) {
    return fallbackDate;
  }

  return null;
}

/**
 * Classify file type based on MIME type and filename
 * Returns content type classification for artifact creation
 * @param mimeType - MIME type of the file (e.g., 'image/jpeg', 'application/pdf')
 * @param fileName - Original filename (used to extract extension)
 * @returns Object with contentType, contentSubtype, and fileExtension
 */
export interface FileTypeClassification {
  contentType: 'binary' | 'text';
  contentSubtype: 'photo' | 'screenshot' | 'document' | 'video' | 'audio' | 'plain' | 'unknown';
  fileExtension: string;
}

export function classifyFileType(mimeType: string | null | undefined, fileName: string | null | undefined): FileTypeClassification {
  // Extract file extension from filename
  let fileExtension = '';
  if (fileName && fileName.includes('.')) {
    const parts = fileName.split('.');
    fileExtension = parts[parts.length - 1]?.toLowerCase() || '';
  }

  // Normalize MIME type (handle null/undefined)
  const normalizedMime = (mimeType || '').toLowerCase().trim();

  // Classify based on MIME type
  if (normalizedMime.startsWith('image/')) {
    // Determine if it's a screenshot or photo based on common patterns
    const isScreenshot = fileName?.toLowerCase().includes('screenshot') || 
                        fileName?.toLowerCase().includes('screen_shot') ||
                        normalizedMime.includes('screenshot');
    
    return {
      contentType: 'binary',
      contentSubtype: isScreenshot ? 'screenshot' : 'photo',
      fileExtension: fileExtension || 'jpg', // Default to jpg for images
    };
  }

  if (normalizedMime.startsWith('video/')) {
    return {
      contentType: 'binary',
      contentSubtype: 'video',
      fileExtension: fileExtension || 'mp4', // Default to mp4 for videos
    };
  }

  if (normalizedMime.startsWith('audio/')) {
    return {
      contentType: 'binary',
      contentSubtype: 'audio',
      fileExtension: fileExtension || 'mp3', // Default to mp3 for audio
    };
  }

  if (normalizedMime === 'application/pdf') {
    return {
      contentType: 'binary',
      contentSubtype: 'document',
      fileExtension: 'pdf',
    };
  }

  if (normalizedMime.startsWith('text/')) {
    return {
      contentType: 'text',
      contentSubtype: 'plain',
      fileExtension: fileExtension || 'txt', // Default to txt for text
    };
  }

  // Check for Word documents
  if (normalizedMime.includes('word') || 
      normalizedMime.includes('document') ||
      normalizedMime === 'application/msword' ||
      normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return {
      contentType: 'binary',
      contentSubtype: 'document',
      fileExtension: fileExtension || 'docx',
    };
  }

  // Check for spreadsheets/Excel
  if (normalizedMime.includes('spreadsheet') || 
      normalizedMime.includes('excel') ||
      normalizedMime === 'application/vnd.ms-excel' ||
      normalizedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return {
      contentType: 'binary',
      contentSubtype: 'document',
      fileExtension: fileExtension || 'xlsx',
    };
  }

  // Unknown/unsupported type
  return {
    contentType: 'binary',
    contentSubtype: 'unknown',
    fileExtension: fileExtension || 'bin',
  };
}

