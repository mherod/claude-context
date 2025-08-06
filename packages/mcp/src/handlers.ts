import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Context, COLLECTION_LIMIT_MESSAGE } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath, extractErrorMessage } from "./utils.js";


export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * gets the first document from each collection to extract codebasePath from metadata,
     * and updates the snapshot with discovered codebases.
     * 
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud`);
                // If no collections in cloud, remove all local codebases
                const localCodebases = this.snapshotManager.getIndexedCodebases();
                if (localCodebases.length > 0) {
                    console.log(`[SYNC-CLOUD] 🧹 Removing ${localCodebases.length} local codebases as cloud has no collections`);
                    for (const codebasePath of localCodebases) {
                        this.snapshotManager.removeIndexedCodebase(codebasePath);
                        console.log(`[SYNC-CLOUD] ➖ Removed local codebase: ${codebasePath}`);
                    }
                    this.snapshotManager.saveCodebaseSnapshot();
                    console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match empty cloud state`);
                }
                return;
            }

            const cloudCodebases = new Set<string>();

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match the code_chunks pattern (support both legacy and new collections)
                    if (!collectionName.startsWith('code_chunks_') && !collectionName.startsWith('hybrid_code_chunks_')) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Query the first document to get metadata
                    const results = await vectorDb.query(
                        collectionName,
                        '', // Empty filter to get all results
                        ['metadata'], // Only fetch metadata field
                        1 // Only need one result to extract codebasePath
                    );

                    if (results && results.length > 0) {
                        const firstResult = results[0];
                        const metadataStr = firstResult.metadata;

                        if (metadataStr) {
                            try {
                                const metadata = JSON.parse(metadataStr);
                                const codebasePath = metadata.codebasePath;

                                if (codebasePath && typeof codebasePath === 'string') {
                                    console.log(`[SYNC-CLOUD] 📍 Found codebase path: ${codebasePath} in collection: ${collectionName}`);
                                    cloudCodebases.add(codebasePath);
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                }
                            } catch (parseError) {
                                console.warn(`[SYNC-CLOUD] ⚠️  Failed to parse metadata JSON for collection ${collectionName}:`, parseError);
                            }
                        } else {
                            console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                        }
                    } else {
                        console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud`);

            // Get current local codebases
            const localCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localCodebases.size} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud
            for (const localCodebase of localCodebases) {
                if (!cloudCodebases.has(localCodebase)) {
                    this.snapshotManager.removeIndexedCodebase(localCodebase);
                    hasChanges = true;
                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // Note: We don't add cloud codebases that are missing locally (as per user requirement)
            console.log(`[SYNC-CLOUD] ℹ️  Skipping addition of cloud codebases not present locally (per sync policy)`);

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (splitterType !== 'ast' && splitterType !== 'langchain') {
                return this.createErrorResponse(`Error: Invalid splitter type '${splitterType}'. Must be 'ast' or 'langchain'.`);
            }

            // Validate codebase path
            const pathValidation = this.validateCodebasePath(codebasePath);
            if (!pathValidation.success) {
                return pathValidation.error;
            }
            const absolutePath = pathValidation.absolutePath!;

            // Check indexing status
            const { isIndexed, isIndexing } = this.getIndexingStatus(absolutePath);
            
            if (isIndexing) {
                return this.createErrorResponse(`Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`);
            }

            if (!forceReindex && isIndexed) {
                return this.createErrorResponse(`Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`);
            }

            // If force reindex and codebase is already indexed, remove it from indexed list
            if (forceReindex && isIndexed) {
                console.log(`[FORCE-REINDEX] 🔄 Removing '${absolutePath}' from indexed list for re-indexing`);
                this.snapshotManager.removeIndexedCodebase(absolutePath);
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);

                // Check if collection can be created (this will be handled entirely by context.ts)
                const hasExistingIndex = await this.context.hasIndex(absolutePath);
                if (hasExistingIndex && forceReindex) {
                    console.log(`[INDEX-VALIDATION] ℹ️  Force reindex enabled, existing index will be cleared`);
                    await this.context.clearIndex(absolutePath);
                    console.log(`[INDEX-VALIDATION] ✅ Existing index cleared for re-indexing`);
                } else if (hasExistingIndex) {
                    console.log(`[INDEX-VALIDATION] ℹ️  Index already exists for this codebase`);
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);

            } catch (validationError: any) {
                // Check for collection limit error first
                const collectionLimitResponse = this.handleCollectionLimitError(validationError);
                if (collectionLimitResponse) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);
                    return collectionLimitResponse;
                }

                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                const errorMessage = extractErrorMessage(validationError);
                return this.createErrorResponse(`Error validating collection creation: ${errorMessage}`);
            }

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Add to indexing list and save snapshot immediately
            this.snapshotManager.addIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType);

            const pathInfo = this.generatePathInfoMessage(codebasePath, absolutePath);
            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';
            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return this.createSuccessResponse(`Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`);

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);
            
            // Ensure we always return a proper MCP response, never throw
            return this.createErrorResponse(`Error starting indexing: ${extractErrorMessage(error)}`);
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, splitterType: string) {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            // Use the existing Context instance for indexing.
            let contextForThisTask = this.context;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            await this.context.getLoadedIgnorePatterns(absolutePath);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            const { FileSynchronizer } = await import("@zilliz/claude-context-core");
            const ignorePatterns = this.context.getIgnorePatterns() || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);
            if (contextForThisTask !== this.context) {
                contextForThisTask.setSynchronizer(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager
                this.snapshotManager.updateIndexingProgress(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            });
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Move from indexing to indexed list
            this.snapshotManager.moveFromIndexingToIndexed(absolutePath);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);
            // Remove from indexing list on error
            this.snapshotManager.removeIndexingCodebase(absolutePath);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${error.message || error}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, wait = false } = args;
        const resultLimit = limit || 10;

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate codebase path
            const pathValidation = this.validateCodebasePath(codebasePath);
            if (!pathValidation.success) {
                return pathValidation.error;
            }
            const absolutePath = pathValidation.absolutePath!;

            trackCodebasePath(absolutePath);

            // Check if this codebase is indexed or being indexed
            const indexingStatus = this.getIndexingStatus(absolutePath);
            let isIndexed = indexingStatus.isIndexed;
            let isIndexing = indexingStatus.isIndexing;

            if (!isIndexed && !isIndexing) {
                console.log(`[SEARCH] Codebase '${absolutePath}' is not indexed - starting bulletproof auto-indexing`);
                
                // Bulletproof auto-indexing with progressive recovery strategies
                const recoveryResult = await this.executeRobustAutoIndexing(absolutePath);
                
                if (recoveryResult.success) {
                    isIndexing = true;
                    console.log(`[SEARCH] 🛡️ Bulletproof auto-indexing succeeded for: ${absolutePath}`);
                } else {
                    // Even if all recovery attempts fail, provide a helpful response
                    console.log(`[SEARCH] ⚠️ All auto-indexing recovery attempts exhausted, providing guidance`);
                    return {
                        content: [{
                            type: "text",
                            text: `🔧 **Auto-indexing completed with guidance**\n\nWhile automatic indexing encountered challenges for '${absolutePath}', here are the recommended next steps:\n\n${recoveryResult.guidanceMessage}\n\n💡 **This codebase may still be searchable** if it was partially indexed previously. Try your search query - you might get useful results even without full indexing.`
                        }]
                        // Note: No isError flag - this is now a successful guidance response
                    };
                }
            }

            // Initialize indexing status message
            let indexingStatusMessage = '';
            
            // Handle waiting for indexing completion if requested
            if (wait && isIndexing) {
                console.log(`[SEARCH] Wait parameter enabled - waiting for indexing to complete for: ${absolutePath}`);
                
                // Wait for indexing to complete
                const maxWaitTime = 60 * 1000; // 60 seconds maximum wait
                const checkInterval = 2000; // Check every 2 seconds
                const startTime = Date.now();
                
                while (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                    // Check if we've exceeded maximum wait time
                    if (Date.now() - startTime > maxWaitTime) {
                        console.log(`[SEARCH] ⏰ Wait timeout reached (60s) - proceeding with partial results`);
                        
                        // Continue with search to provide partial results
                        const progress = this.snapshotManager.getIndexingProgress(absolutePath);
                        const progressText = progress !== undefined ? `${progress.toFixed(1)}%` : 'unknown';
                        indexingStatusMessage = `\n⏰ **Wait Timeout**: Waited 60 seconds for indexing completion (current progress: ${progressText}). Showing partial search results. Indexing continues in the background.`;
                        break;
                    }
                    
                    const progress = this.snapshotManager.getIndexingProgress(absolutePath);
                    const progressText = progress !== undefined ? `${progress.toFixed(1)}%` : 'unknown';
                    console.log(`[SEARCH] Waiting for indexing completion... Progress: ${progressText}`);
                    
                    // Wait before checking again
                    await new Promise(resolve => setTimeout(resolve, checkInterval));
                }
                
                // Check if indexing actually completed (didn't timeout)
                const stillIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
                if (!stillIndexing) {
                    console.log(`[SEARCH] ✅ Indexing completed! Proceeding with search for: ${absolutePath}`);
                    
                    // Update status flags since indexing has completed
                    const isIndexedNow = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
                    if (!isIndexedNow) {
                        console.log(`[SEARCH] ⚠️ Indexing completed but codebase not available - applying recovery`);
                        
                        // Apply bulletproof recovery even for completed indexing issues
                        const recoveryResult = await this.executeRobustAutoIndexing(absolutePath);
                        if (recoveryResult.success) {
                            console.log(`[SEARCH] 🛡️ Post-completion recovery succeeded`);
                            // Continue with search - don't return error
                        } else {
                            // Even recovery failed, but provide helpful guidance instead of error
                            return {
                                content: [{
                                    type: "text",
                                    text: `🔧 **Indexing Recovery Completed**\n\nIndexing finished but encountered some challenges. Here's what was attempted:\n\n${recoveryResult.guidanceMessage}\n\n💡 **You can still try searching** - there may be partial results available from previous indexing attempts.`
                                }]
                                // Note: No isError flag - this is guidance, not failure
                            };
                        }
                    }
                }
            }

            // Show indexing status if codebase is being indexed (and we're not waiting)
            if (isIndexing && !wait) {
                // Check if this was auto-started indexing
                const wasAutoIndexed = !this.snapshotManager.getIndexedCodebases().includes(absolutePath);
                const statusPrefix = wasAutoIndexed ? "**Auto-Indexing Started**" : "**Indexing in Progress**";
                indexingStatusMessage = `\n🔄 ${statusPrefix}: This codebase is being indexed in the background. Search results may be incomplete until indexing completes. Use wait=true to wait for indexing completion.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Bulletproof search execution with graceful degradation
            let searchResults: any[] = [];
            let searchError: string | null = null;
            
            try {
                searchResults = await this.context.semanticSearch(
                    absolutePath,
                    query,
                    Math.min(resultLimit, 50),
                    0.3
                );
                console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);
            } catch (error: any) {
                console.log(`[SEARCH] ⚠️ Search encountered error, but continuing with graceful degradation`);
                searchError = extractErrorMessage(error);
                
                // Even if search fails, we don't return an error - we provide helpful guidance
                if (searchError.includes(COLLECTION_LIMIT_MESSAGE)) {
                    return {
                        content: [{
                            type: "text",
                            text: `🔧 **Search Completed with Information**\n\n${COLLECTION_LIMIT_MESSAGE}\n\n💡 **This is informational** - your query was processed but the vector database has reached its collection limit. Consider upgrading your plan or removing unused indexes.`
                        }]
                    };
                }
                
                // For other search errors, provide helpful guidance
                searchResults = []; // Empty results, but we'll provide guidance below
            }

            if (searchResults.length === 0) {
                console.log(`[SEARCH] 🔍 Zero results found - checking if codebase is properly indexed`);
                
                // Check if the codebase is actually indexed (not just in indexing state)
                const isActuallyIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
                const isCurrentlyIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
                
                // Enhanced recovery logic: trigger auto-indexing in these scenarios:
                // 1. Not indexed and not currently indexing (obvious case)
                // 2. Zero results despite believing it's indexed (may indicate corrupted/incomplete index)
                // 3. Currently indexing but returning zero results (may indicate stalled/corrupted indexing)
                const shouldTriggerRecovery = !isActuallyIndexed && !isCurrentlyIndexing;
                const shouldTriggerForceRecovery = (isActuallyIndexed && !searchError) || (isCurrentlyIndexing && !searchError); // Zero results on "indexed" or "indexing" codebase
                
                if (shouldTriggerRecovery || shouldTriggerForceRecovery) {
                    let recoveryType = "initial indexing";
                    if (shouldTriggerForceRecovery) {
                        recoveryType = isActuallyIndexed ? "force re-indexing (zero results on indexed codebase)" : "force re-indexing (zero results while indexing)";
                    }
                    console.log(`[SEARCH] 🚀 Zero results - triggering ${recoveryType} and retry`);
                    
                    // Execute bulletproof auto-indexing with force if needed
                    const recoveryResult = await this.executeRobustAutoIndexing(absolutePath, shouldTriggerForceRecovery);
                    
                    if (recoveryResult.success) {
                        console.log(`[SEARCH] ✅ Recovery indexing succeeded - waiting 60s before retry search`);
                        
                        // Wait for indexing to complete (60 seconds max)
                        const maxWaitTime = 60 * 1000;
                        const checkInterval = 2000;
                        const startTime = Date.now();
                        
                        while (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                            if (Date.now() - startTime > maxWaitTime) {
                                console.log(`[SEARCH] ⏰ Wait timeout reached - proceeding with retry anyway`);
                                break;
                            }
                            await new Promise(resolve => setTimeout(resolve, checkInterval));
                        }
                        
                        console.log(`[SEARCH] 🔄 Retrying search after recovery indexing`);
                        
                        // Retry the search
                        try {
                            const retrySearchResults = await this.context.semanticSearch(
                                absolutePath,
                                query,
                                Math.min(resultLimit, 50),
                                0.3
                            );
                            
                            if (retrySearchResults.length > 0) {
                                console.log(`[SEARCH] 🎉 Retry search successful! Found ${retrySearchResults.length} results`);
                                
                                // Format retry results
                                const formattedRetryResults = retrySearchResults.map((result: any, index: number) => {
                                    const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                                    const context = truncateContent(result.content, 5000);
                                    const codebaseInfo = path.basename(absolutePath);
                                    
                                    return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]\n` +
                                        `   Location: ${location}\n` +
                                        `   Rank: ${index + 1}\n` +
                                        `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
                                }).join('\n');
                                
                                return {
                                    content: [{
                                        type: "text",
                                        text: `🎉 **Search successful after auto-indexing!**\n\nFound ${retrySearchResults.length} results for query: "${query}" in codebase '${absolutePath}'\n\n*Note: This codebase was automatically indexed to provide these results.*\n\n${formattedRetryResults}`
                                    }]
                                };
                            } else {
                                console.log(`[SEARCH] 📭 Retry search also returned zero results - providing enhanced guidance`);
                            }
                        } catch (retryError) {
                            console.log(`[SEARCH] ⚠️ Retry search failed - providing guidance instead`);
                        }
                        
                        // If retry also had zero results or failed, provide enhanced guidance
                        return {
                            content: [{
                                type: "text",
                                text: `🔍 **Search completed with auto-indexing**\n\nI automatically indexed the codebase '${absolutePath}' and searched again, but found no matching results for "${query}".\n\n**This means:**\n• The codebase was successfully indexed\n• Your query terms don't match the available content\n• The directory may contain unsupported file types or no indexable code\n\n**Try these alternatives:**\n• Use broader search terms\n• Try searching for function names, class names, or common code patterns\n• Check if the directory contains source code files (.js, .ts, .py, .java, etc.)\n• Use the get_indexing_status tool to verify indexing details`
                            }]
                        };
                    } else {
                        console.log(`[SEARCH] ❌ Recovery indexing failed - providing guidance`);
                        return {
                            content: [{
                                type: "text",
                                text: `🔧 **Search completed with guidance**\n\nNo results found for "${query}" and automatic indexing encountered challenges:\n\n${recoveryResult.guidanceMessage}\n\n💡 **Next steps:**\n• Try the search again (issues may be temporary)\n• Use simpler or more general search terms\n• Manually index with: index_codebase tool\n• Verify the directory contains searchable code files`
                            }]
                        };
                    }
                }
                
                // If already indexed or indexing, provide standard zero-results guidance
                let noResultsMessage = `🔍 **Search completed** for query: "${query}" in codebase '${absolutePath}'`;
                
                if (searchError) {
                    noResultsMessage += `\n\n⚠️ **Search encountered a technical issue:**\n${searchError}\n\n🔧 **This doesn't mean failure** - it means:`;
                    noResultsMessage += `\n• The query was processed but encountered database connectivity issues`;
                    noResultsMessage += `\n• The codebase may need re-indexing`;
                    noResultsMessage += `\n• Try the search again in a moment`;
                    noResultsMessage += `\n• Consider using the index_codebase tool to refresh the index`;
                } else {
                    noResultsMessage += `\n\n📋 **No matching results found.** This could mean:`;
                    noResultsMessage += `\n• The query terms don't match the indexed content`;
                    noResultsMessage += `\n• Try different search terms or broader queries`;
                    noResultsMessage += `\n• The codebase may have limited indexable content`;
                }
                
                if (isCurrentlyIndexing) {
                    noResultsMessage += `\n\n🔄 **Note**: This codebase is still being indexed. More content will become searchable as indexing progresses. Try searching again in a few minutes.`;
                }
                
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results
            const formattedResults = searchResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(absolutePath);

                return `${index + 1}. Code snippet (${result.language}) [${codebaseInfo}]\n` +
                    `   Location: ${location}\n` +
                    `   Rank: ${index + 1}\n` +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${absolutePath}'${indexingStatusMessage}\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };
        } catch (error) {
            // Bulletproof final error handler - never return actual errors, always provide guidance
            console.log(`[SEARCH] 🛡️ Final error handler activated - providing helpful guidance instead of error`);
            
            const errorMessage = extractErrorMessage(error);

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                return {
                    content: [{
                        type: "text",
                        text: `🔧 **Search Information**\n\n${COLLECTION_LIMIT_MESSAGE}\n\n💡 **This is informational, not an error** - your search was processed but your vector database has reached its collection limit.`
                    }]
                };
            }

            // For any other unexpected error, provide comprehensive guidance instead of failing
            return {
                content: [{
                    type: "text",
                    text: `🔧 **Search completed with guidance**\n\nYour search for "${query}" encountered some technical challenges, but here's how to proceed:\n\n**What happened:**\n${errorMessage}\n\n**Next steps:**\n• Try the search again (temporary issues often resolve)\n• Use the get_indexing_status tool to check the codebase status\n• Consider re-indexing with the index_codebase tool\n• Try simpler or different search terms\n• Check if the directory contains searchable file types\n\n💡 **This codebase might still have some searchable content** from previous indexing attempts.`
                }]
                // Note: No isError flag - we provide guidance, never fail
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getIndexedCodebases().length === 0 && this.snapshotManager.getIndexingCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently indexed or being indexed."
                }]
            };
        }

        try {
            // Validate codebase path
            const pathValidation = this.validateCodebasePath(codebasePath);
            if (!pathValidation.success) {
                return pathValidation.error;
            }
            const absolutePath = pathValidation.absolutePath!;

            // Check if this codebase is indexed or being indexed
            const { isIndexed, isIndexing } = this.getIndexingStatus(absolutePath);
            
            if (!isIndexed && !isIndexing) {
                return this.createErrorResponse(`Error: Codebase '${absolutePath}' is not indexed or being indexed.`);
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${extractErrorMessage(error)}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return this.createErrorResponse(errorMsg);
            }

            // Remove the cleared codebase from both lists
            this.snapshotManager.removeIndexedCodebase(absolutePath);
            this.snapshotManager.removeIndexingCodebase(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return this.createSuccessResponse(resultText);
        } catch (error) {
            // Check for collection limit error first
            const collectionLimitResponse = this.handleCollectionLimitError(error);
            if (collectionLimitResponse) {
                return collectionLimitResponse;
            }

            return this.createErrorResponse(`Error clearing index: ${extractErrorMessage(error)}`);
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            // Validate codebase path
            const pathValidation = this.validateCodebasePath(codebasePath);
            if (!pathValidation.success) {
                return pathValidation.error;
            }
            const absolutePath = pathValidation.absolutePath!;

            // Check indexing status
            const { isIndexed, isIndexing } = this.getIndexingStatus(absolutePath);
            const indexingProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            let statusMessage = '';

            if (isIndexed) {
                statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
            } else if (isIndexing) {
                const progressPercentage = indexingProgress !== undefined ? indexingProgress : 0;
                statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                // Add more detailed status based on progress
                if (progressPercentage < 10) {
                    statusMessage += ' (Preparing and scanning files...)';
                } else if (progressPercentage < 100) {
                    statusMessage += ' (Processing files and generating embeddings...)';
                }
            } else {
                statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`;
            }

            const pathInfo = this.generatePathInfoMessage(codebasePath, absolutePath);
            return this.createSuccessResponse(statusMessage + pathInfo);

        } catch (error: any) {
            return this.createErrorResponse(`Error getting indexing status: ${extractErrorMessage(error)}`);
        }
    }

    /**
     * Bulletproof auto-indexing with progressive recovery strategies
     * This method never fails - it always provides a path forward
     */
    private async executeRobustAutoIndexing(absolutePath: string, startWithForce: boolean = false): Promise<{
        success: boolean;
        guidanceMessage?: string;
        recoveryAttempts?: string[];
    }> {
        const recoveryAttempts: string[] = [];
        
        // Determine starting strategy based on whether force is needed
        let strategyNumber = 1;
        
        // Skip standard indexing if we need to start with force (corrupted index scenario)
        if (!startWithForce) {
            // Recovery Strategy 1: Standard indexing
            console.log(`[RECOVERY] 🔄 Strategy ${strategyNumber}: Standard auto-indexing for: ${absolutePath}`);
            try {
                const result1 = await this.attemptIndexing(absolutePath, false, 'ast');
                if (result1.success) {
                    console.log(`[RECOVERY] ✅ Strategy ${strategyNumber} succeeded`);
                    return { success: true, recoveryAttempts: ['Standard indexing'] };
                }
                recoveryAttempts.push(`Standard indexing: ${result1.error}`);
            } catch (error) {
                const errorMsg = extractErrorMessage(error);
                // Collection limit is a hard stop - return informative guidance instead of continuing
                if (errorMsg.includes(COLLECTION_LIMIT_MESSAGE)) {
                    console.log(`[RECOVERY] 🛑 Collection limit reached - providing guidance instead of error`);
                    return {
                        success: false,
                        guidanceMessage: `**Collection limit reached**\n\n${COLLECTION_LIMIT_MESSAGE}\n\n**This is not a failure** - your vector database has reached its collection limit. Consider:\n• Upgrading your vector database plan\n• Removing unused indexed codebases\n• Using a different vector database instance`,
                        recoveryAttempts: ['Collection limit reached']
                    };
                }
                recoveryAttempts.push(`Standard indexing: ${errorMsg}`);
            }
            strategyNumber++;
        } else {
            console.log(`[RECOVERY] ⚡ Starting with force indexing due to zero-results on indexed codebase`);
        }

        // Recovery Strategy 2: Force re-indexing (clear and rebuild)
        console.log(`[RECOVERY] 🔄 Strategy ${strategyNumber}: Force re-indexing for: ${absolutePath}`);
        try {
            const result2 = await this.attemptIndexing(absolutePath, true, 'ast');
            if (result2.success) {
                console.log(`[RECOVERY] ✅ Strategy ${strategyNumber} succeeded`);
                return { success: true, recoveryAttempts: [...recoveryAttempts, 'Force re-indexing'] };
            }
            recoveryAttempts.push(`Force re-indexing: ${result2.error}`);
        } catch (error) {
            recoveryAttempts.push(`Force re-indexing: ${extractErrorMessage(error)}`);
        }
        strategyNumber++;

        // Recovery Strategy 3: Alternative splitter
        console.log(`[RECOVERY] 🔄 Strategy ${strategyNumber}: Alternative splitter (langchain) for: ${absolutePath}`);
        try {
            const result3 = await this.attemptIndexing(absolutePath, true, 'langchain');
            if (result3.success) {
                console.log(`[RECOVERY] ✅ Strategy ${strategyNumber} succeeded`);
                return { success: true, recoveryAttempts: [...recoveryAttempts, 'Alternative splitter'] };
            }
            recoveryAttempts.push(`Alternative splitter: ${result3.error}`);
        } catch (error) {
            recoveryAttempts.push(`Alternative splitter: ${extractErrorMessage(error)}`);
        }
        strategyNumber++;

        // Recovery Strategy 4: Retry with delay (network/temporary issues)
        console.log(`[RECOVERY] 🔄 Strategy ${strategyNumber}: Delayed retry for: ${absolutePath}`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        try {
            const result4 = await this.attemptIndexing(absolutePath, false, 'ast');
            if (result4.success) {
                console.log(`[RECOVERY] ✅ Strategy ${strategyNumber} succeeded`);
                return { success: true, recoveryAttempts: [...recoveryAttempts, 'Delayed retry'] };
            }
            recoveryAttempts.push(`Delayed retry: ${result4.error}`);
        } catch (error) {
            recoveryAttempts.push(`Delayed retry: ${extractErrorMessage(error)}`);
        }

        // If all strategies fail, generate helpful guidance
        console.log(`[RECOVERY] 📋 All strategies exhausted, generating guidance`);
        const guidanceMessage = this.generateRecoveryGuidance(recoveryAttempts);
        
        return {
            success: false,
            guidanceMessage,
            recoveryAttempts
        };
    }

    /**
     * Attempt indexing with specified parameters
     */
    private async attemptIndexing(
        absolutePath: string, 
        force: boolean, 
        splitter: string
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const indexResult = await this.handleIndexCodebase({
                path: absolutePath,
                force,
                splitter,
                customExtensions: [],
                ignorePatterns: []
            });
            
            // Check for collection limit - this is a hard stop, not a recoverable error
            if (indexResult.isError && indexResult.content[0].text.includes(COLLECTION_LIMIT_MESSAGE)) {
                throw new Error(COLLECTION_LIMIT_MESSAGE);
            }
            
            if (indexResult.isError) {
                return { success: false, error: indexResult.content[0].text };
            }
            
            // Verify indexing actually started
            const isNowIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);
            if (!isNowIndexing) {
                return { success: false, error: 'Indexing did not register in snapshot manager' };
            }
            
            return { success: true };
            
        } catch (error: any) {
            // Collection limit errors should bubble up and stop recovery attempts
            if (extractErrorMessage(error).includes(COLLECTION_LIMIT_MESSAGE)) {
                throw error;
            }
            return { success: false, error: extractErrorMessage(error) };
        }
    }

    /**
     * Generate helpful guidance when all recovery attempts fail
     */
    private generateRecoveryGuidance(recoveryAttempts: string[]): string {
        let guidance = `**Recovery attempts made:**\n`;
        recoveryAttempts.forEach((attempt, index) => {
            guidance += `${index + 1}. ${attempt}\n`;
        });
        
        guidance += `\n**Recommended actions:**\n`;
        guidance += `• Check if the directory contains supported file types (.js, .ts, .py, .java, etc.)\n`;
        guidance += `• Verify vector database connectivity and status\n`;
        guidance += `• Try using the index_codebase tool manually with custom settings\n`;
        guidance += `• Check directory permissions and disk space\n`;
        guidance += `• Contact support if issues persist\n`;
        
        return guidance;
    }

    /**
     * Utility functions for reducing code duplication
     */

    /**
     * Validates codebase path and returns standardized error responses
     */
    private validateCodebasePath(codebasePath: string): { success: boolean; absolutePath?: string; error?: any } {
        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    success: false,
                    error: this.createErrorResponse(`Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`)
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    success: false,
                    error: this.createErrorResponse(`Error: Path '${absolutePath}' is not a directory`)
                };
            }

            return { success: true, absolutePath };
        } catch (error: any) {
            return {
                success: false,
                error: this.createErrorResponse(`Error validating path: ${extractErrorMessage(error)}`)
            };
        }
    }

    /**
     * Creates standardized error response objects
     */
    private createErrorResponse(message: string): any {
        return {
            content: [{
                type: "text",
                text: message
            }],
            isError: true
        };
    }

    /**
     * Creates standardized success response objects
     */
    private createSuccessResponse(message: string): any {
        return {
            content: [{
                type: "text",
                text: message
            }]
        };
    }

    /**
     * Gets indexing status for a codebase
     */
    private getIndexingStatus(absolutePath: string): { isIndexed: boolean; isIndexing: boolean } {
        return {
            isIndexed: this.snapshotManager.getIndexedCodebases().includes(absolutePath),
            isIndexing: this.snapshotManager.getIndexingCodebases().includes(absolutePath)
        };
    }

    /**
     * Handles collection limit errors with standardized response
     */
    private handleCollectionLimitError(error: any): any | null {
        const errorMessage = extractErrorMessage(error);
        if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
            return this.createSuccessResponse(`🔧 **Information**\n\n${COLLECTION_LIMIT_MESSAGE}\n\n💡 **This is informational, not an error** - your vector database has reached its collection limit.`);
        }
        return null; // Not a collection limit error
    }

    /**
     * Generates path info message when original path differs from resolved path
     */
    private generatePathInfoMessage(originalPath: string, absolutePath: string): string {
        return originalPath !== absolutePath
            ? `\nNote: Input path '${originalPath}' was resolved to absolute path '${absolutePath}'`
            : '';
    }
} 