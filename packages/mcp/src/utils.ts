import * as path from "path";

/**
 * Truncate content to specified length
 */
export function truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
        return content;
    }
    return content.substring(0, maxLength) + '...';
}

/**
 * Ensure path is absolute. If relative path is provided, resolve it properly.
 */
export function ensureAbsolutePath(inputPath: string): string {
    // If already absolute, return as is
    if (path.isAbsolute(inputPath)) {
        return inputPath;
    }

    // For relative paths, resolve to absolute path
    const resolved = path.resolve(inputPath);
    return resolved;
}

/**
 * Extracts a meaningful error message from any error object
 */
export function extractErrorMessage(error: any): string {
    if (typeof error === 'string') {
        return error;
    } else if (error instanceof Error) {
        return error.message;
    } else if (error && typeof error === 'object') {
        // Try common error properties
        return error.message || 
               error.error || 
               error.statusText ||
               error.data ||
               JSON.stringify(error);
    } else {
        return String(error);
    }
}

export function trackCodebasePath(codebasePath: string): void {
    const absolutePath = ensureAbsolutePath(codebasePath);
    console.log(`[TRACKING] Tracked codebase path: ${absolutePath} (not marked as indexed)`);
} 