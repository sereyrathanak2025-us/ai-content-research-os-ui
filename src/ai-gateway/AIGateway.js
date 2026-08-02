// src/ai-gateway/AIGateway.js - FINAL UPDATED (Minor Issue Addressed)
import { llmRouter } from '../router/llmRouter.js';
import { AIGatewayResponseContractSchema } from '../core/contracts/AIGatewayResponseContractSchema.js';
import { validateContract } from '../core/validators/contractValidator.js';
import { v4 as uuidv4 } from 'uuid';
import { MODEL_PROFILES } from '../config/aiConfig.js';
import { Logger } from '../core/utils/logger.js';
// UPDATED: Removed ServiceError import as it's unused (Minor Issue)
import { LLMError, ValidationError, EmbeddingError, LLMResponseFormatError, AppError } from '../errors/AppErrors.js';
import { MetricsCollector } from '../core/utils/metrics.js';

// Placeholder for prompt templates
const PROMPT_TEMPLATES = {
    DISCOVERY_MOMENT_PROMPT: (videoId, duration) => `
        Based on video ID "${videoId}" (duration: ${duration}s), identify 3-5 distinct "moment evidences" that could be interesting.
        For each moment, provide:
        - A concise 'candidateMoment' title.
        - 'start' and 'end' timestamps (format HH:MM or HH:MM:SS).
        - A 'confidence' score (0.0-1.0) for the timestamp.
        - A 'narrativeObservation' describing what happens.
        - Potential 'humanQuestions' for review.
        - Provide at least two pieces of 'editorialEvidence' for each moment, including 'evidenceType', 'confidence', 'source', and 'explanation'.
        - Perform an initial 'sceneAnalysis' (mainObjects, activities, sentiment, description).
        - Provide 'audioAnalysis' (speechToText, soundEvents, mood) if applicable.
        - Extract 'extractedContext' from any available text (subtitles, on-screen text).
        Output in a JSON array of objects, strictly following this structure:
        [
            {
                "candidateMoment": "...",
                "start": "HH:MM",
                "end": "HH:MM",
                "confidence": 0.8,
                "narrativeObservation": "...",
                "humanQuestions": ["?", "?"],
                "editorialEvidence": [
                    {
                        "evidenceType": "visual",
                        "confidence": 0.9,
                        "source": "00:30-00:35",
                        "explanation": "Dramatic camera zoom on character's face"
                    }
                ],
                "sceneAnalysis": {
                    "mainObjects": ["person", "car"],
                    "activities": ["driving", "talking"],
                    "sentiment": "neutral",
                    "description": "A person driving a car on a city street."
                },
                "audioAnalysis": {
                    "speechToText": "Hello, how are you?",
                    "soundEvents": ["engine hum", "city traffic"],
                    "mood": "calm"
                },
                "extractedContext": "The protagonist embarks on a new journey."
            }
        ]
        `,
    JUDGMENT_SCORE_PROMPT: (moment) => `
        Given the moment "${moment.candidateMoment}" (ID: ${moment.momentId}) with narrative: "${moment.narrativeObservation}",
        and editorial evidence: ${JSON.stringify(moment.editorialEvidence)}.
        Provide a "score" (0-100), "reasoning" for the score, and suggest a "reviewState".
        Output strictly as JSON: {"score": N, "reasoning": "...", "reviewState": "..."}
        `,
    INTELLIGENCE_IMPROVEMENT_PROMPT: (moment) => `
        For moment ID "${moment.momentId}", provide improvement suggestions and editorial insights based on its content. Focus on creative enhancement and quality.
        Output strictly as JSON: { "editorialSuggestions": [], "alternativeTitles": [], "missingMetadata": [] }
    `,
    GENERATE_EMBEDDING_INPUT: (text) => text,
    SIMILARITY_VERIFICATION_PROMPT: (sourceMoment, candidateMoment, similarityScore) => `
        Given a source moment (ID: ${sourceMoment.momentId}, narrative: "${sourceMoment.narrativeObservation}")
        and a candidate moment (ID: ${candidateMoment.momentId}, narrative: "${candidateMoment.narrativeObservation}")
        with a vector similarity score of ${similarityScore.toFixed(3)}.
        Determine if these moments are:
        - "HIGH_CONFIDENCE_DUPLICATE" (almost identical content/meaning)
        - "POSSIBLE_DUPLICATE" (very similar, strong overlap in core idea)
        - "RELATED_MOMENT" (shares theme or elements, but distinct)
        - "NOT_SIMILAR" (unrelated)

        Explain your reasoning briefly. Output strictly as JSON:
        {"classification": "...", "reasoning": "..."}
        `
};

export class AIGateway {
    constructor(llmRouterInstance, loggerInstance, metricsCollectorInstance) {
        this.llmRouter = llmRouterInstance;
        this.logger = loggerInstance;
        this.metrics = metricsCollectorInstance;
        this.name = "AIGateway";
        this.logger.info(`${this.name}: Initialized.`);
    }

    async processLLMRequest(engineName, profileName, dataContext, overrides = {}, parentLogger = null) {
        const profile = MODEL_PROFILES[profileName];
        if (!profile) {
            this.logger.error(`Unknown model profile: ${profileName}`, { engineName, profileName, dataContext });
            this.metrics.increment('llm_request_failure_total', 1, { reason: 'unknown_profile', engine: engineName, profile: profileName, component: this.name });
            throw new LLMError(`AI Gateway: Unknown model profile: ${profileName}`, 'UNKNOWN_PROFILE', { profileName, engineName });
        }

        const requestId = uuidv4();
        const traceId = parentLogger?.getContext()?.traceId || dataContext.traceId || uuidv4();
        const childLogger = (parentLogger || this.logger).child({ requestId, traceId, profile: profileName, model: profile.model, provider: profile.provider, engine: engineName });
        childLogger.debug("Processing LLM request.", { dataContextKeys: Object.keys(dataContext), overridesKeys: Object.keys(overrides) });

        const startTime = process.hrtime.bigint();

        let requestPayload;
        let inputTokens = 0;
        let outputTokens = 0;

        if (profile.embedding_specific) {
            const input_text = PROMPT_TEMPLATES.GENERATE_EMBEDDING_INPUT(dataContext.text);
            if (!input_text) {
                childLogger.error(`No text provided for embedding generation.`, { dataContext });
                this.metrics.increment('llm_request_failure_total', 1, { reason: 'no_embedding_text', engine: engineName, profile: profileName, component: this.name });
                throw new ValidationError(`AI Gateway: No text provided for embedding generation with profile ${profileName}.`);
            }
            requestPayload = {
                input: input_text,
                temperature: profile.temperature,
                max_tokens: profile.max_tokens,
                ...overrides
            };
            childLogger.debug("Generated embedding input.", { textLength: input_text.length });
            inputTokens = Math.ceil(input_text.length / 4);
        } else {
            let prompt;
            if (engineName === "DiscoveryEngine") {
                prompt = PROMPT_TEMPLATES.DISCOVERY_MOMENT_PROMPT(dataContext.videoId, dataContext.duration);
                childLogger.debug("Generated discovery prompt.");
            } else if (engineName === "JudgmentEngine") {
                prompt = PROMPT_TEMPLATES.JUDGMENT_SCORE_PROMPT(dataContext.moment);
                childLogger.debug("Generated judgment prompt.");
            } else if (engineName === "IntelligenceEngine") {
                if (profileName === "VERIFICATION") {
                    prompt = PROMPT_TEMPLATES.SIMILARITY_VERIFICATION_PROMPT(dataContext.sourceMoment, dataContext.candidateMoment, dataContext.similarityScore);
                    childLogger.debug("Generated similarity verification prompt.");
                } else {
                    prompt = PROMPT_TEMPLATES.INTELLIGENCE_IMPROVEMENT_PROMPT(dataContext.moment);
                    childLogger.debug("Generated general intelligence prompt.");
                }
            } else {
                // Changed from ServiceError to LLMError as it's an LLM related config issue
                childLogger.error(`No prompt template for engine: ${engineName} and profile: ${profileName}.`, { engineName, profileName });
                this.metrics.increment('llm_request_failure_total', 1, { reason: 'unknown_prompt_template', engine: engineName, profile: profileName, component: this.name });
                throw new LLMError(`AI Gateway: No prompt template for engine: ${engineName} and profile: ${profileName}`, 'UNKNOWN_PROMPT_TEMPLATE', { engineName, profileName });
            }

            requestPayload = {
                prompt: prompt,
                temperature: profile.temperature,
                max_tokens: profile.max_tokens,
                ...overrides
            };
            inputTokens = Math.ceil(prompt.length / 4);
        }

        const llmRequestContract = {
            requestId: requestId,
            traceId: traceId,
            schemaVersion: "1.0.0",
            agent: this.name,
            model: profile.model,
            provider: profile.provider,
            timestamp: new Date().toISOString(),
            payload: requestPayload
        };

        this.metrics.increment('llm_requests_total', 1, { engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });
        this.metrics.increment('llm_tokens_input_total', inputTokens, { engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });

        childLogger.debug("Calling LLM Router.", { model: profile.model, provider: profile.provider, requestPayloadKeys: Object.keys(llmRequestContract.payload) });
        const llmResponseContract = await this.llmRouter.routeRequest(llmRequestContract, childLogger);
        childLogger.debug("Received response from LLM Router.", { llmResponseContractStatus: llmResponseContract.status });

        const endTime = process.hrtime.bigint();
        const durationMs = Number(endTime - startTime) / 1_000_000;
        this.metrics.observe('llm_request_latency_ms', durationMs, { engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });

        if (llmResponseContract.status === 'failure' || !llmResponseContract.payload) {
            childLogger.error("LLM Router returned failure or empty payload.", { errors: llmResponseContract.errors, responseContractStatus: llmResponseContract.status });
            this.metrics.increment('llm_request_failure_total', 1, { reason: 'llm_router_failure', engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });
            throw new LLMError("LLM request failed.", 'LLM_ROUTER_FAILURE', { errors: llmResponseContract.errors });
        }

        let parsedResponse = llmResponseContract.payload;

        if (profile.embedding_specific) {
            let vector = [];
            if (Array.isArray(parsedResponse) && parsedResponse.every(n => typeof n === 'number')) {
                vector = parsedResponse;
            } else if (typeof parsedResponse === 'object' && Array.isArray(parsedResponse.embedding) && parsedResponse.embedding.every(n => typeof n === 'number')) {
                vector = parsedResponse.embedding;
            } else if (typeof parsedResponse === 'object' && Array.isArray(parsedResponse.data?.[0]?.embedding) && parsedResponse.data[0].embedding.every(n => typeof n === 'number')) {
                vector = parsedResponse.data[0].embedding;
            } else {
                childLogger.error(`Embedding service returned non-vector data or unexpected format.`, { rawResponseSnippet: String(parsedResponse).substring(0,200) });
                this.metrics.increment('llm_request_failure_total', 1, { reason: 'embedding_format_error', engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });
                throw new EmbeddingError(`AI Gateway: Embedding service returned non-vector data or unexpected format for profile ${profileName}.`, 'EMBEDDING_FORMAT_ERROR', { rawResponse: parsedResponse });
            }

            if (!vector || vector.length === 0 || vector.some(isNaN)) {
                childLogger.error(`Generated vector is invalid (empty, contains NaN) after parsing.`, { vectorLength: vector.length, vectorSample: vector.slice(0,5) });
                this.metrics.increment('llm_request_failure_total', 1, { reason: 'invalid_embedding_vector', engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });
                throw new EmbeddingError(`AI Gateway: Generated vector is invalid (empty, contains NaN) after parsing for profile ${profileName}.`, 'INVALID_EMBEDDING_VECTOR', { vectorLength: vector.length });
            }

            outputTokens = 1; // Conceptual output token for embedding result
            this.metrics.increment('llm_tokens_output_total', outputTokens, { engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });

            childLogger.debug("Successfully parsed embedding vector response.");
            return {
                requestId: llmResponseContract.requestId,
                traceId: llmResponseContract.traceId,
                schemaVersion: "1.0.0",
                agent: this.name,
                timestamp: new Date().toISOString(),
                status: 'success',
                payload: { vector: vector },
                meta: { profile: profileName, model: profile.model, provider: profile.provider }
            };
        }

        try {
            if (typeof parsedResponse === 'string') {
                parsedResponse = JSON.parse(parsedResponse);
                childLogger.debug("Parsed LLM response from string to JSON.");
            }
        } catch (parseError) {
            childLogger.warn("LLM response payload is not valid JSON. Attempting repair/re-throw...", { parseError: parseError.message, rawResponseSnippet: String(parsedResponse).substring(0,200) });
            this.metrics.increment('llm_request_failure_total', 1, { reason: 'json_parse_error', engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });
            throw new LLMResponseFormatError("LLM response payload is unparseable JSON.", 'LLM_PARSE_ERROR', { rawResponse: parsedResponse, error: parseError.message });
        }

        outputTokens = Math.ceil(JSON.stringify(parsedResponse).length / 4);
        this.metrics.increment('llm_tokens_output_total', outputTokens, { engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });

        const aiGatewayResponse = {
            requestId: llmRequestContract.requestId,
            traceId: llmRequestContract.traceId,
            schemaVersion: "1.0.0",
            agent: this.name,
            timestamp: new Date().toISOString(),
            status: 'success',
            payload: parsedResponse,
            meta: { profile: profileName, model: profile.model, provider: profile.provider }
        };

        const validationResult = validateContract(aiGatewayResponse, 'AIGatewayResponseContract');
        if (!validationResult.isValid) {
            childLogger.error("Processed response does not conform to AIGatewayResponseContract.", { errors: validationResult.errors, responsePayloadKeys: Object.keys(aiGatewayResponse.payload || {}) });
            this.metrics.increment('llm_request_failure_total', 1, { reason: 'contract_validation_error', engine: engineName, profile: profileName, model: profile.model, provider: profile.provider, component: this.name });
            throw new ValidationError("LLM output did not conform to expected schema after parsing.", validationResult.errors, 'AIGATEWAY_CONTRACT_VIOLATION', { responsePayload: aiGatewayResponse.payload });
        }

        childLogger.debug("Successfully processed LLM request and validated response.");
        return aiGatewayResponse;
    }
}
