// src/engines/intelligence/IntelligenceEngine.js - UPDATED for Blocker Fixes & Hardening (Metrics)
import { MomentRepository } from '../../repositories/MomentRepository.js';
import { AIGateway } from '../../ai-gateway/AIGateway.js';
import { validateMomentData } from '../../core/validators/momentValidator.js';
import { JobRepository } from '../../repositories/JobRepository.js';
import { EmbeddingService } from '../../services/EmbeddingService.js';
import { EMBEDDING_CONFIG, SIMILARITY_THRESHOLDS } from '../../config/aiConfig.js';
import { SimilarityPolicy, DuplicateStatus } from '../../policies/SimilarityPolicy.js';
import { Logger } from '../core/utils/logger.js';
import { ValidationError, EmbeddingError, LLMError, MomentNotFoundError, RepositoryError, AppError } from '../errors/AppErrors.js'; // NEW: Import AppError
import { MetricsCollector } from '../utils/metrics.js'; // NEW: Import MetricsCollector

export class IntelligenceEngine {
    constructor(momentRepository, aiGatewayInstance, jobRepositoryInstance, embeddingServiceInstance, similarityPolicyInstance, loggerInstance, metricsCollectorInstance) { // Receive metricsCollector
        this.momentRepository = momentRepository;
        this.aiGateway = aiGatewayInstance;
        this.jobRepository = jobRepositoryInstance;
        this.embeddingService = embeddingServiceInstance;
        this.similarityPolicy = similarityPolicyInstance;
        this.logger = loggerInstance;
        this.metrics = metricsCollectorInstance; // Store metricsCollector
        this.name = "IntelligenceEngine";
        this.defaultEmbeddingModel = EMBEDDING_CONFIG.EMBEDDING_DEFAULT_MODEL;
        this.defaultEmbeddingVersion = EMBEDDING_CONFIG.EMBEDDING_DEFAULT_VERSION;
        this.logger.info(`${this.name}: Initialized.`);
    }

    async analyzeMomentForIntelligence(job, jobLogger) {
        const { momentId, jobId, videoId, traceId } = job;

        const childLogger = jobLogger || this.logger.child({ jobId, momentId, videoId, traceId });
        childLogger.info("Processing intelligence analysis for moment.");

        const startTime = process.hrtime.bigint(); // Start time for overall intelligence duration
        let pipelineStatus = 'failed';
        let errorType = 'UnknownError';

        let moment;
        try {
            moment = await this.momentRepository.findById(momentId);
            if (!moment) {
                childLogger.warn(`Moment with ID ${momentId} not found.`, { job });
                this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'moment_not_found', component: this.name });
                throw new MomentNotFoundError(`Moment ${momentId} not found.`, momentId, 'MOMENT_NOT_FOUND_FOR_ANALYSIS');
            }
        } catch (error) {
            childLogger.error(`Failed to retrieve moment ${momentId}:`, { error: error.message, stack: error.stack });
            this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'moment_retrieval_failed', errorType: error.name || 'UnknownError', component: this.name });
            errorType = error.name || 'RepositoryError';
            throw error;
        }

        let embeddingVector;
        let similarEmbeddings = [];
        let duplicateInfoResult = {
            status: DuplicateStatus.UNPROCESSED,
            isDuplicate: false,
            originalMomentId: null,
            similarityScore: 0,
            audit: { decisionMethod: "NOT_EVALUATED", evaluatedAt: new Date().toISOString() }
        };
        let intelligenceSuggestions = {};

        try {
            const embeddingStartTime = process.hrtime.bigint();
            embeddingVector = await this.embeddingService.generateEmbedding(moment, this.defaultEmbeddingModel, childLogger);
            const embeddingDuration = Number(process.hrtime.bigint() - embeddingStartTime) / 1_000_000;
            this.metrics.observe('embedding_generation_latency_ms', embeddingDuration, { model: this.defaultEmbeddingModel, component: this.name });

            const sourceContent = {
                text: this.embeddingService.buildEmbeddingSourceText(moment)
            };
            await this.embeddingService.createAndStoreEmbedding(
                moment,
                embeddingVector,
                this.defaultEmbeddingModel,
                sourceContent,
                this.defaultEmbeddingVersion,
                childLogger
            );
            childLogger.info(`Embedding created and stored for Moment ${momentId}.`);

            const similarityStartTime = process.hrtime.bigint();
            similarEmbeddings = await this.embeddingService.findSimilarMomentsByVector(embeddingVector, {
                limit: 10,
                filter: { model: this.defaultEmbeddingModel, version: this.defaultEmbeddingVersion },
                minSimilarity: SIMILARITY_THRESHOLDS.IGNORE_BELOW,
                excludeMomentId: momentId
            }, childLogger);
            const similarityDuration = Number(process.hrtime.bigint() - similarityStartTime) / 1_000_000;
            this.metrics.observe('vector_search_latency_ms', similarityDuration, { model: this.defaultEmbeddingModel, resultsCount: similarEmbeddings.length, component: this.name });
            childLogger.info(`Found ${similarEmbeddings.length} similar embeddings for Moment ${momentId}.`);

            const policyStartTime = process.hrtime.bigint();
            const evaluationResult = await this.similarityPolicy.evaluateSimilarMoments(moment, similarEmbeddings, childLogger);
            const policyDuration = Number(process.hrtime.bigint() - policyStartTime) / 1_000_000;
            this.metrics.observe('similarity_policy_evaluation_duration_ms', policyDuration, { status: evaluationResult.duplicateInfo.status, component: this.name });
            
            duplicateInfoResult = evaluationResult.duplicateInfo;
            similarEmbeddings = evaluationResult.similarMoments;
            childLogger.info(`Duplicate evaluation result for Moment ${momentId}: ${duplicateInfoResult.status}.`, { duplicateInfoResultStatus: duplicateInfoResult.status, duplicateInfoResultAudit: duplicateInfoResult.audit });

        } catch (embeddingOrSimilarityError) {
            childLogger.error(`Error during embedding/similarity processing:`, { error: embeddingOrSimilarityError.message, stack: embeddingOrSimilarityError.stack });
            this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'embedding_similarity_failed', errorType: embeddingOrSimilarityError.name || 'UnknownError', component: this.name });
            duplicateInfoResult.status = DuplicateStatus.EMBEDDING_FAILED;
            duplicateInfoResult.audit = {
                decisionMethod: "EMBEDDING_FAILED",
                error: embeddingOrSimilarityError.message,
                evaluatedAt: new Date().toISOString()
            };
            errorType = embeddingOrSimilarityError.name || 'EmbeddingOrSimilarityError';
            throw embeddingOrSimilarityError;
        }

        try {
            const generalIntelStartTime = process.hrtime.bigint();
            const aiGatewayResponse = await this.aiGateway.processLLMRequest(
                this.name,
                'INTELLIGENCE',
                { moment: moment, duplicateInfo: duplicateInfoResult, similarMoments: similarEmbeddings, traceId: traceId },
                null, // Pass null for parentLogger, childLogger is already set
                childLogger // Explicitly pass childLogger for AIGateway's internal logging
            );
            const generalIntelDuration = Number(process.hrtime.bigint() - generalIntelStartTime) / 1_000_000;
            this.metrics.observe('llm_general_intelligence_latency_ms', generalIntelDuration, { component: this.name });

            if (aiGatewayResponse.status === 'failure' || !aiGatewayResponse.payload) {
                childLogger.warn(`General intelligence analysis failed: AI Gateway returned failure or empty payload.`, { errors: aiGatewayResponse.errors });
                this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'general_intel_llm_failed', errorType: 'LLMError', component: this.name });
                throw new LLMError(`General intelligence analysis failed for moment ${momentId}: Invalid AI Gateway response.`, 'LLM_GENERAL_INTEL_FAILURE', { aiGatewayErrors: aiGatewayResponse.errors });
            } else {
                intelligenceSuggestions = aiGatewayResponse.payload;
            }
        } catch (generalIntelError) {
            childLogger.error(`Error during general intelligence analysis:`, { error: generalIntelError.message, stack: generalIntelError.stack });
            this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'general_intel_llm_exception', errorType: generalIntelError.name || 'UnknownError', component: this.name });
            errorType = generalIntelError.name || 'LLMError';
            throw generalIntelError;
        }

        const updatedMomentData = {
            ...moment,
            duplicateInfo: duplicateInfoResult,
            similarMoments: similarEmbeddings,
            editorialSuggestions: intelligenceSuggestions.editorialSuggestions || moment.editorialSuggestions,
            alternativeTitles: intelligenceSuggestions.alternativeTitles || moment.alternativeTitles,
            missingMetadata: intelligenceSuggestions.missingMetadata || moment.missingMetadata,
            updatedAt: new Date().toISOString(),
            traceId: traceId
        };

        const validationResult = validateMomentData(updatedMomentData);
        if (!validationResult.isValid) {
            childLogger.error(`Updated moment data after intelligence analysis failed validation.`, { errors: validationResult.errors, momentId: updatedMomentData.momentId });
            this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'moment_update_validation_failed', errorType: 'ValidationError', component: this.name });
            errorType = 'ValidationError';
            throw new ValidationError(`Moment data validation failed after intelligence for Moment ${momentId}, job ${jobId}.`, validationResult.errors, 'MOMENT_UPDATE_VALIDATION_FAILED', { momentId: momentId, jobId: jobId });
        }

        try {
            const updateMomentStartTime = process.hrtime.bigint();
            const updatedMoment = await this.momentRepository.update(momentId, updatedMomentData);
            const updateMomentDuration = Number(process.hrtime.bigint() - updateMomentStartTime) / 1_000_000;
            this.metrics.observe('moment_update_duration_ms', updateMomentDuration, { component: this.name });
            childLogger.info(`Moment updated with intelligence insights.`);
            
            pipelineStatus = 'completed';
            return updatedMoment;
        } catch (error) {
            childLogger.error(`Failed to update moment ${momentId} with intelligence insights.`, { error: error.message, stack: error.stack });
            this.metrics.increment('intelligence_pipeline_failure_total', 1, { reason: 'moment_update_failed', errorType: error.name || 'UnknownError', component: this.name });
            errorType = error.name || 'RepositoryError';
            throw error;
        } finally {
            const overallDuration = Number(process.hrtime.bigint() - startTime) / 1_000_000;
            this.metrics.observe('intelligence_pipeline_overall_duration_ms', overallDuration, { status: pipelineStatus, errorType: errorType, component: this.name });
            if (pipelineStatus === 'completed') {
                this.metrics.increment('intelligence_pipeline_completed_total', 1, { component: this.name });
            } else {
                this.metrics.increment('intelligence_pipeline_failure_total', 1, { errorType: errorType, component: this.name });
            }
        }
    }
}
