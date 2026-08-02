// Viral Radar Worker — AI Research Director (Phase 1 Implementation - Architecture v3.1 Final)
// Architecture v3.1 Approved - Modular, Event-Driven, Policy-Enforced, LLM-Independent Intelligence
// This implementation focuses on core logic, LLM routing, capabilities, and initial agents.
// RuntimeState and EventBus are simulated in-memory for Phase 1, to be persisted in later phases.
//
// PATCHED (see comments tagged "// FIX:"):
// 1) RuntimeState.update() was losing its prototype via object spread, causing
//    "currentState.update is not a function" crash after the first agent ran.
// 2) SourceHunterAgent could crash with "Cannot read properties of undefined (reading 'join')"
//    if the LLM omitted primary_queries or keywords on a platform_strategy.

// --- CORE UTILITIES: Replicated from src/core/* for Worker self-containment ---

// 1. Runtime Configuration (Based on src/config/runtimeConfig.js)
const RUNTIME_CONFIG = {
    // Cloudflare Workers pass environment variables via the `env` object in the fetch handler.
    // For local development, these might still come from process.env if a bundler polyfills it.
    // We will rely on `env` object directly when used by capabilities/agents.
    // These constants serve as defaults or for initial setup where `env` is not yet available.
    ENVIRONMENT: 'production', // Default to production for worker, override via `env` if needed
    SERVICE_NAME: 'FWG-AI-OS-Worker',
    APP_VERSION: 'worker-v1.0.0', // Placeholder version
    GIT_SHA: 'unknown',
};

// 2. Logger Service (Simplified based on src/core/utils/logger.js)
// This is a minimal, self-contained logger for the Worker context.
class ConsoleLogger {
    constructor(context = {}) {
        this.context = context;
        this.name = context.component || 'Worker';
    }

    _log(level, message, data = {}) {
        const timestamp = new Date().toISOString();
        const fullContext = { ...this.context, ...data };
        // Cloudflare Workers console.log supports multiple arguments
        console.log(`[${timestamp}] [${this.name}] [${level.toUpperCase()}] ${message}`, fullContext);
    }

    child(newContext) {
        return new ConsoleLogger({ ...this.context, ...newContext });
    }

    info(message, data) { this._log('info', message, data); }
    warn(message, data) { this._log('warn', message, data); }
    error(message, data) { this._log('error', message, data); }
    debug(message, data) {
        // Only log debug in non-production environments or if explicitly enabled
        if (RUNTIME_CONFIG.ENVIRONMENT !== 'production') {
            this._log('debug', message, data);
        }
    }
    critical(message, data) { this._log('critical', message, data); }
}
const workerLogger = new ConsoleLogger({ component: 'MainWorker' });


// 3. AppError Hierarchy (Replicated from src/core/errors/AppErrors.js)
class AppError extends Error {
    constructor(message, code = 'GENERIC_ERROR', context = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.context = context;
        // captureStackTrace is V8 specific, often not available in pure CF Worker runtime.
        // if (Error.captureStackTrace) { Error.captureStackTrace(this, this.constructor); }
    }
}
class ConfigurationError extends AppError {
    constructor(message = "Invalid configuration.", code = 'CONFIGURATION_ERROR', context = {}) {
        super(message, code, context);
        this.name = 'ConfigurationError';
    }
}
class LLMError extends AppError {
    constructor(message = "LLM interaction failed", code = 'LLM_FAILURE', context = {}) {
        super(message, code, context);
        this.name = 'LLMError';
    }
}
class EmbeddingError extends LLMError { // Specialization of LLMError as it involves LLM for generation
    constructor(message = "Embedding generation or search failed", code = 'EMBEDDING_FAILURE', context = {}) {
        super(message, code, context);
        this.name = 'EmbeddingError';
    }
}
class ValidationError extends AppError {
    constructor(message = "Validation failed", details = {}, code = 'VALIDATION_ERROR', context = {}) {
        super(message, code, { ...context, details });
        this.name = 'ValidationError';
    }
}
class JobProcessingError extends AppError {
    constructor(message = "Job processing failed", code = 'JOB_PROCESSING_FAILURE', context = {}) {
        super(message, code, context);
        this.name = 'JobProcessingError';
    }
}
class RepositoryError extends AppError {
    constructor(message = "Repository operation failed", code = 'REPOSITORY_FAILURE', context = {}) {
        super(message, code, context);
        this.name = 'RepositoryError';
    }
}
class MomentNotFoundError extends AppError {
    constructor(message = "Moment not found", momentId, code = 'MOMENT_NOT_FOUND', context = {}) {
        super(message, code, { ...context, momentId });
        this.name = 'MomentNotFoundError';
    }
}
class DuplicateLockError extends AppError {
    constructor(message = "Job cannot acquire lock as another job is processing the same moment", lockKey, code = 'DUPLICATE_LOCK_ERROR', context = {}) {
        super(message, code, { ...context, lockKey });
        this.name = 'DuplicateLockError';
    }
}
class LLMResponseFormatError extends LLMError {
    constructor(message = "LLM response format invalid", code = 'LLM_RESPONSE_FORMAT_ERROR', context = {}) {
        super(message, code, context);
        this.name = 'LLMResponseFormatError';
    }
}


// 4. MetricsCollector (Replicated from src/core/utils/metrics.js)
// Note: This is an in-memory collector. For real production, integrate with external
// metrics services (e.g., StatsD, Prometheus exporter) via Cloudflare Workers bindings.
const ALLOWED_METRIC_LABELS = [
    'component', 'engine', 'profile', 'model', 'provider', 'eventType',
    'status', 'errorType', 'reason', 'isRetryable', 'retryCount', 'resultsCount',
    'metricName', 'policy'
];

class MetricsCollector {
    constructor(loggerInstance) {
        if (!loggerInstance) {
            throw new ConfigurationError("MetricsCollector requires a logger instance.", 'METRICS_CONFIG_ERROR');
        }
        this.counters = {};
        this.histograms = {};
        this.gauges = {};
        this.logger = loggerInstance.child({ component: 'MetricsCollector' });
        this.name = 'MetricsCollector';
        this.logger.info(`${this.name}: Initialized.`);
    }

    _getMetricKey(name, labels) {
        const filteredLabels = {};
        for (const key in labels) {
            if (Object.prototype.hasOwnProperty.call(labels, key)) {
                if (ALLOWED_METRIC_LABELS.includes(key)) {
                    const labelValue = labels[key];
                    if (typeof labelValue === 'string' || typeof labelValue === 'number' || typeof labelValue === 'boolean') {
                        filteredLabels[key] = labelValue;
                    } else {
                        this.logger.debug(`Non-primitive label value for key '${key}' in metric '${name}' was converted to string.`, { labelKey: key, metricName: name, originalValueType: typeof labelValue });
                        filteredLabels[key] = `${labelValue}`;
                    }
                } else {
                    this.logger.debug(`High cardinality label '${key}' for metric '${name}' was filtered out.`, { labelKey: key, metricName: name });
                }
            }
        }
        if (Object.keys(filteredLabels).length === 0) return name;
        const sortedLabels = Object.keys(filteredLabels).sort().map(key => `${key}=${filteredLabels[key]}`).join(',');
        return `${name}{${sortedLabels}}`;
    }

    increment(name, value = 1, labels = {}) {
        if (value === 0) { this.logger.debug(`Counter increment for '${name}' is 0, skipping.`, { name, value, labels }); return; }
        if (!Number.isFinite(value) || value < 0) { throw new AppError(`Invalid value for counter '${name}'. Must be a non-negative, finite number.`, 'METRIC_VALUE_ERROR', { name, value }); }
        const key = this._getMetricKey(name, labels);
        this.counters[key] = (this.counters[key] || 0) + value;
        this.logger.debug(`Incremented counter: ${name}`, { value, labels, current: this.counters[key] });
    }

    observe(name, value, labels = {}) {
        if (!Number.isFinite(value)) { throw new AppError(`Invalid value for histogram '${name}'. Must be a finite number.`, 'METRIC_VALUE_ERROR', { name, value }); }
        const key = this._getMetricKey(name, labels);
        if (!this.histograms[key]) { this.histograms[key] = { count: 0, sum: 0, min: Infinity, max: -Infinity }; }
        const metric = this.histograms[key];
        metric.count++; metric.sum += value;
        metric.min = Math.min(metric.min, value); metric.max = Math.max(metric.max, value);
        this.logger.debug(`Observed histogram: ${name}`, { value, labels, count: metric.count, sum: metric.sum });
    }

    setGauge(name, value, labels = {}) {
        if (!Number.isFinite(value)) { throw new AppError(`Invalid value for gauge '${name}'. Must be a finite number.`, 'METRIC_VALUE_ERROR', { name, value }); }
        const key = this._getMetricKey(name, labels);
        this.gauges[key] = value;
        this.logger.debug(`Set gauge: ${name}`, { value, labels });
    }

    getMetricsSnapshot() {
        return {
            timestamp: new Date().toISOString(),
            service: RUNTIME_CONFIG.SERVICE_NAME,
            environment: RUNTIME_CONFIG.ENVIRONMENT,
            version: RUNTIME_CONFIG.APP_VERSION,
            git_sha: RUNTIME_CONFIG.GIT_SHA,
            metrics: {
                counters: { ...this.counters },
                histograms: Object.fromEntries(
                    Object.entries(this.histograms).map(([key, data]) => [
                        key, { count: data.count, sum: data.sum, min: Number.isFinite(data.min) ? data.min : 0, max: Number.isFinite(data.max) ? data.max : 0, avg: data.count > 0 ? data.sum / data.count : 0 }
                    ])
                ),
                gauges: { ...this.gauges }
            }
        };
    }
}
const workerMetricsCollector = new MetricsCollector(workerLogger.child({ component: 'MainWorkerMetrics' }));


// --- END CORE UTILITIES ---

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

function cleanJson(text) {
  let t = (typeof text === 'string' ? text : JSON.stringify(text)).trim();
  t = t.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  const firstBrace = t.indexOf("{");
  const firstBracket = t.indexOf("[");
  let s = -1, e = -1;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    s = firstBracket; e = t.lastIndexOf("]");
  } else if (firstBrace !== -1) {
    s = firstBrace; e = t.lastIndexOf("}");
  }
  if (s !== -1 && e !== -1 && e > s) t = t.slice(s, e + 1);
  return t;
}

function coerceToArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const arrayValues = Object.values(data).filter(v => Array.isArray(v));
    if (arrayValues.length > 0) {
      return arrayValues.reduce((a, b) => (b.length > a.length ? b : a));
    }
  }
  return [];
}

const PLUGIN_TRIGGER_WORDS = {
  fails: ["fail", "fails", "prank", "karma", "clumsy", "embarrass", "blooper", "epic fail", "instant karma"]
};
function isPluginRelevant(pluginName, ...texts) {
  const triggers = PLUGIN_TRIGGER_WORDS[pluginName];
  if (!triggers) return true;
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  return triggers.some(word => haystack.includes(word));
}

// -----------------------------------------------------------------------------
// YOUTUBE CHANNEL HELPERS
// -----------------------------------------------------------------------------
function parseYouTubeChannelRef(rawUrl) {
  let u = (rawUrl || "").trim();
  u = u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^m\./i, "").replace(/^youtube\.com\//i, "");
  u = u.split(/[?#]/)[0];
  u = u.replace(/\/+$/, "");
  if (u.startsWith("@")) return { type: "handle", value: u.split("/")[0] };
  if (u.startsWith("channel/")) return { type: "id", value: u.slice("channel/".length).split("/")[0] };
  if (u.startsWith("c/")) return { type: "handle", value: "@" + u.slice("c/".length).split("/")[0] };
  if (u.startsWith("user/")) return { type: "user", value: u.slice("user/".length).split("/")[0] };
  if (rawUrl.trim().startsWith("@")) return { type: "handle", value: rawUrl.trim().split("/")[0] };
  const bare = u.split("/")[0];
  return bare ? { type: "handle", value: bare.startsWith("@") ? bare : "@" + bare } : null;
}

async function resolveYouTubeChannelId(ref, apiKey, logger, metricsCollector) { // Added logger, metricsCollector
  if (!ref) return null;
  if (ref.type === "id") return ref.value;
  const startTime = Date.now();
  let status = 'failed';
  let errorType = 'UnknownError';
  try {
    const param = ref.type === "user" ? "forUsername" : "forHandle";
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&${param}=${encodeURIComponent(ref.value)}&key=${apiKey}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.items && data.items[0]) {
        status = 'success';
        return data.items[0].id;
      }
    }
    const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(ref.value)}&key=${apiKey}`);
    if (searchResp.ok) {
      const searchData = await searchResp.json();
      const item = searchData.items && searchData.items[0];
      if (item) {
        status = 'success';
        return item.snippet?.channelId || item.id?.channelId || null;
      }
    }
    status = 'not_found';
    return null;
  } catch (e) {
    logger.warn("resolveYouTubeChannelId failed:", { error: e.message, ref: ref }); // Updated logger
    errorType = e.name || 'YouTubeAPIError';
    throw e;
  } finally {
    metricsCollector.observe('youtube_channel_resolve_latency_ms', Date.now() - startTime, { status: status, errorType: errorType, component: 'YouTubeHelpers' });
    metricsCollector.increment('youtube_channel_resolve_total', 1, { status: status, component: 'YouTubeHelpers' });
  }
}

function parseISO8601Duration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10), mi = parseInt(m[2] || "0", 10), s = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

async function fetchRecentVideosForChannel(channelId, apiKey, maxResults, logger, metricsCollector) { // Added logger, metricsCollector
  const startTime = Date.now();
  let status = 'failed';
  let errorType = 'UnknownError';
  let videoCount = 0;

  try {
    const chResp = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${apiKey}`);
    if (!chResp.ok) {
      throw new AppError(`YouTube channels API failed with status ${chResp.status}`, 'YOUTUBE_CHANNELS_API_FAILED', { status: chResp.status });
    }
    const chData = await chResp.json();
    const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) {
      status = 'no_uploads_playlist';
      return [];
    }

    const plResp = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${apiKey}`);
    if (!plResp.ok) {
      throw new AppError(`YouTube playlist items API failed with status ${plResp.status}`, 'YOUTUBE_PLAYLIST_API_FAILED', { status: plResp.status });
    }
    const plData = await plResp.json();
    const videoIds = (plData.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
    if (videoIds.length === 0) {
      status = 'no_videos_in_playlist';
      return [];
    }

    const vidResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(",")}&key=${apiKey}`);
    if (!vidResp.ok) {
      throw new AppError(`YouTube videos API failed with status ${vidResp.status}`, 'YOUTUBE_VIDEOS_API_FAILED', { status: vidResp.status });
    }
    const vidData = await vidResp.json();
    status = 'success';
    videoCount = vidData.items.length;
    return (vidData.items || []).map(v => ({
      title: v.snippet.title,
      description: (v.snippet.description || "").slice(0, 200),
      duration_sec: parseISO8601Duration(v.contentDetails.duration),
      views: parseInt(v.statistics?.viewCount || "0", 10)
    }));
  } catch (e) {
    logger.warn("fetchRecentVideosForChannel failed:", { error: e.message, channelId: channelId }); // Updated logger
    errorType = e.name || 'YouTubeAPIError';
    throw e;
  } finally {
    metricsCollector.observe('youtube_fetch_recent_videos_latency_ms', Date.now() - startTime, { status: status, errorType: errorType, videoCount: videoCount, component: 'YouTubeHelpers' });
    metricsCollector.increment('youtube_fetch_recent_videos_total', 1, { status: status, component: 'YouTubeHelpers' });
  }
}

// -----------------------------------------------------------------------------
// KNOWLEDGE BASE LAYER (Simulated - Static for Phase 1)
// -----------------------------------------------------------------------------
const KNOWLEDGE_BASE_PLUGINS = {
  core: {
    emotion_taxonomy: [
      "Humor", "Shock", "Awe", "Excitement", "Inspiration", "Curiosity", "Empathy", "Nostalgia", "Satisfaction", "Frustration"
    ],
    platform_profiles: {
      YouTube: { characteristics: "Long-form, tutorials, vlogs, high production, vertical shorts", formats: ["tutorials", "vlogs", "reaction", "ranking", "shorts"], audience: "diverse" },
      TikTok: { characteristics: "Short-form, vertical, trend-driven, music, quick cuts", formats: ["dances", "challenges", "vlogs", "reaction", "how-to", "storytime"], audience: "Gen Z, young millennials" },
      Reddit: { characteristics: "Niche communities, authentic, discussion, user-generated, raw", formats: ["r/videos", "r/damnthatsinteresting", "r/unexpected"], audience: "tech-savvy, niche interests" },
      Instagram: { characteristics: "Aesthetics, visual, influencer-driven, reels, stories", formats: ["reels", "stories", "aesthetics", "fashion", "lifestyle"], audience: "visual-focused" },
      Facebook: { characteristics: "Shareable, community, reposts, live, longer videos", formats: ["news", "community content", "live streams", "reposts"], audience: "broad, older demographics" },
    },
    copyright_rules: {
      basic: "Fair use considerations vary by region. Generally, short transformative clips with commentary are lower risk.",
      ai_generated: "Content generated by AI tools should be checked for original source material compliance.",
    },
    ai_detection_heuristics: {
      visual: "Repetitive patterns, unnatural movements, perfect symmetry, lack of genuine human flaws.",
      audio: "Robotic voice, repetitive background music, unusual sound effects.",
      metadata: "Generic titles/descriptions, rapid upload frequency from new accounts."
    },
    retention_patterns: {
      hooks: ["immediate visual punch", "curiosity gap", "direct question", "relatable scenario"],
      pacing: "Varied pacing, quick cuts for short segments, build-ups for payoffs.",
      emotional_curve: "Start with intrigue, build tension/humor, deliver strong payoff, loop potential for rewatch."
    },
    story_patterns: {
      ranking: "Intro -> #6 (interesting) -> #5 (better) -> #4 (unexpected) -> #3 (crazy) -> #2 (impossible) -> #1 (mind blown) -> Outro.",
      reveal: "Build-up -> Foreshadowing -> Twist/Reveal -> Reaction."
    },
    trend_profiles: {
      seasonal: { summer: ["vacation fails", "beach pranks"], winter: ["snow fails", "holiday crafts"] },
      evergreen: ["animal fails", "satisfying machines", "DIY transformations"]
    },
    policy_rules: {
      MIN_EVIDENCE_QUALITY_SCORE: 60,
      MAX_COPYRIGHT_RISK_SCORE: 70,
      MIN_PLATFORM_DIVERSITY: 2,
      MAX_DUPLICATION_PERCENT: 5,
      NO_COMPILATION_KEYWORDS: ["compilation", "best of", "top 10", "epic moments"],
      NO_RANKING_KEYWORDS: ["rank", "#1", "worst", "best"],
    },
    hook_types: [
      "Expectation violated", "Object suddenly breaks", "Animal interrupts",
      "Perfect timing", "Optical illusion", "Transformation",
      "Impossible skill", "Chain reaction", "Instant reversal", "Delayed realization"
    ],
    original_source_types: [
      "Reddit post", "Local news clip", "Instagram reel", "TikTok creator upload",
      "Personal vlog", "Bodycam footage", "Dashcam footage",
      "Security camera footage", "Livestream clip"
    ]
  },
  fails: {
    content_taxonomy: ["Funny Fails", "Epic Fails", "Instant Karma", "Unexpected Fails"],
    moment_taxonomy: {
      "Funny Fails": {
        "public fail": ["unexpected fall", "embarrassing moment", "prank gone wrong"],
        "animal fail": ["pets doing silly things", "animal clumsiness"],
        "gym fail": ["lifting fails", "treadmill accidents"]
      },
      "Instant Karma": {
        "bad drivers": ["road rage consequences", "parking fails"],
        "rude people": ["getting what they deserve"]
      }
    },
    moment_patterns: [
      {
        pattern: "Expectation -> Failure -> Reaction",
        searchSignals: ["original clip", "caught on camera", "full clip", "raw footage", "fail moment"]
      },
      {
        pattern: "Calm -> Sudden chaos",
        searchSignals: ["security camera", "dashcam", "livestream clip", "caught on camera"]
      },
      {
        pattern: "Confidence -> Instant consequence",
        searchSignals: ["instant karma", "caught on camera", "bodycam", "dashcam"]
      },
      {
        pattern: "Rude behavior -> Public consequence",
        searchSignals: ["instant karma clip", "caught on camera reaction", "security footage"]
      }
    ],
  }
};

// -----------------------------------------------------------------------------
// RUNTIME STATE LAYER (Simulated - In-memory for Phase 1)
// TODO Architectural Blocker: For Production, this must be persisted using
// Cloudflare Durable Objects or D1 to ensure state is not lost across Worker invocations.
// -----------------------------------------------------------------------------
const workflowStates = {};

class RuntimeState {
  constructor(id, initialInput) {
    this.workflow_id = id;
    this.timestamp = new Date().toISOString();
    this.status = "INITIALIZED";
    this.input_contract = initialInput;
    this.editorial_dna_profile = null;
    this.editorial_intent = null;
    this.moment_ontology = null;
    this.discovery_missions = [];
    this.discovery_queue_status = { pending: 0, completed: 0, failed: 0, results: [] };
    this.raw_clips_collected = [];
    this.ai_insights = null;
    this.validated_clips = [];
    this.scored_clips = [];
    this.curated_clips = [];
    this.narrative_clips = [];
    this.final_ranked_clips = [];
    this.final_report_output = null;
    this.confidence_journal = [];
    this.explainability_journal = [];
    this.agent_execution_log = [];
    this.global_constraints = initialInput.constraints || {};
  }

  update(newData) {
    const newState = Object.assign(
      Object.create(Object.getPrototypeOf(this)),
      this,
      newData,
      { timestamp: new Date().toISOString() }
    );
    return newState;
  }
}

// -----------------------------------------------------------------------------
// EVENT BUS LAYER (Simulated - In-memory for Phase 1)
// TODO Architectural Blocker: For Production, this must use a persistent
// message queue (e.g., Cloudflare Queues or Durable Objects) for reliability
// and guaranteed delivery.
// -----------------------------------------------------------------------------
const eventLog = [];

const EventPublisher = {
  publish: (type, payload, logger, metricsCollector) => { // Added logger, metricsCollector
    const event = { type, payload, timestamp: new Date().toISOString() };
    eventLog.push(event);
    logger.debug(`[EVENT BUS] Published: ${type}`, payload); // Updated logger
    metricsCollector.increment('event_bus_published_total', 1, { eventType: type, component: 'EventBus' });
  }
};

// -----------------------------------------------------------------------------
// POLICY LAYER (Simulated - Always pass for Phase 1)
// TODO Architectural Blocker: For Production, this needs a robust policy
// evaluation engine with rules loaded from a persistent store, not hardcoded.
// -----------------------------------------------------------------------------
const PolicyEngine = {
  apply: (policyId, data, context, logger, metricsCollector) => { // Added logger, metricsCollector
    logger.debug(`[POLICY ENGINE] Applied policy: ${policyId} (Always passing in Phase 1)`, { policyId, data }); // Updated logger
    context.explainabilityRecorder.record(`Policy '${policyId}' applied: PASSED (Phase 1 simulation)`, { policyId, data });
    metricsCollector.increment('policy_applied_total', 1, { policyId: policyId, status: 'passed', component: 'PolicyEngine' });
    return { passed: true, reason: "Phase 1: Policy always passes.", confidence_impact: 0 };
  }
};

// -----------------------------------------------------------------------------
// EXPLAINABILITY LAYER (Simulated - In-memory for Phase 1)
// TODO Architectural Blocker: For Production, this needs to persist detailed
// traces and explanations to a dedicated store (e.g., Cloudflare D1 table).
// -----------------------------------------------------------------------------
const ExplainabilityRecorder = {
  record: (decision, details, logger, metricsCollector) => { // Added logger, metricsCollector
    logger.debug(`[EXPLAINABILITY] ${decision}`, details); // Updated logger
    metricsCollector.increment('explainability_records_total', 1, { decision: decision, component: 'Explainability' });
  }
};


// -----------------------------------------------------------------------------
// CAPABILITY REGISTRY & LAYER
// -----------------------------------------------------------------------------

const LLMRouter = {
  // TODO Architectural Improvement: Model configurations should ideally be managed
  // dynamically (e.g., from a central config service or `env` variables for different Worker versions)
  // rather than hardcoded here. (LLMRouter Hardcoded Models)
  async route(prompt, schema, modelPreference, env, logger, metricsCollector) {
    const models = {
      cloudflare: {
        id: modelPreference.cloudflare || "@cf/meta/llama-3.1-8b-instruct-fast",
        fallback: ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/zai-org/glm-4.7-flash"]
      },
      openrouter: {
        id: modelPreference.openrouter || "openai/gpt-oss-20b:free",
        fallback: [
          "openai/gpt-oss-20b:free",
          "meta-llama/llama-3.3-70b-instruct:free",
          "google/gemini-2.0-flash-exp:free",
          "mistralai/mistral-7b-instruct:free"
        ]
      },
      google: {
        id: modelPreference.google || "gemini-2.0-flash",
        fallback: ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-pro", "gemini-pro"]
      },
    };

    const preferredProvider = modelPreference.provider || "cloudflare";
    const attempts = [...new Set([preferredProvider, "cloudflare", "openrouter", "google"])];

    let lastError = null;
    const routeStartTime = Date.now();
    const ROUTE_TIME_BUDGET_MS = 25000;

    metricsCollector.increment('llm_router_route_total', 1, { preferredProvider: preferredProvider, component: 'LLMRouter' });

    outerLoop:
    for (const provider of attempts) {
      const modelCfg = models[provider];
      if (!modelCfg) {
        logger.debug(`LLM Router: Skipping unknown provider config for '${provider}'.`);
        continue;
      }

      const modelList = [modelCfg.id, ...(modelCfg.fallback || [])].filter(Boolean);

      for (const currentModel of modelList) {
        if (Date.now() - routeStartTime > ROUTE_TIME_BUDGET_MS) {
          logger.warn(`LLM Router: time budget (${ROUTE_TIME_BUDGET_MS}ms) exceeded, stopping fallback attempts early.`, { remainingTime: ROUTE_TIME_BUDGET_MS - (Date.now() - routeStartTime) });
          metricsCollector.increment('llm_router_budget_exceeded_total', 1, { provider: provider, model: currentModel, component: 'LLMRouter' });
          break outerLoop;
        }
        try {
          let responseText = "";
          let success = false;
          let inputTokens = 0;
          let outputTokens = 0;

          const messages = [
            { role: "system", content: "You are a viral content research analyst. Always respond with valid JSON only, no markdown, no extra text. Ensure JSON is properly formatted and complete. Adhere strictly to the provided JSON schema." },
            { role: "user", content: prompt }
          ];
          
          inputTokens = messages.reduce((sum, msg) => sum + (msg.content?.length || 0) + (msg.parts?.[0]?.text?.length || 0), 0) / 4;

          metricsCollector.increment('llm_call_attempt_total', 1, { provider: provider, model: currentModel, component: 'LLMRouter' });

          switch (provider) {
            case "cloudflare":
              if (!env.AI) throw new ConfigurationError("Cloudflare AI binding not configured.", 'CF_AI_BINDING_MISSING');
              const cfResp = await withTimeout(env.AI.run(currentModel, {
                messages: messages, max_tokens: 3000, temperature: 0, response_format: { type: "json_object" }
              }), 20000, `Cloudflare AI (${currentModel})`);
              if (cfResp && (cfResp.response || cfResp.result)) {
                responseText = typeof cfResp.response === 'string' ? cfResp.response : JSON.stringify(cfResp.response || cfResp.result);
                success = true;
              }
              break;

            case "openrouter":
              if (!env.OPENROUTER_API_KEY) throw new ConfigurationError("OpenRouter API key not configured.", 'OPENROUTER_API_KEY_MISSING');
              const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST", headers: { "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://viral-discovery-proxy.fasterwgseverkh.workers.dev" },
                body: JSON.stringify({ model: currentModel, messages: messages, max_tokens: 3000, temperature: 0, response_format: { type: "json_object" } }),
                signal: AbortSignal.timeout(20000)
              });
              if (!orResp.ok) {
                  const errorBody = await orResp.json().catch(() => ({ message: "Unknown OpenRouter error" }));
                  throw new LLMError(`OpenRouter API failed: ${orResp.status} - ${errorBody.message || JSON.stringify(errorBody)}`, 'OPENROUTER_API_FAILED', { httpStatus: orResp.status, errorBody: errorBody });
              }
              const orData = await orResp.json();
              if (orData.choices && orData.choices[0] && orData.choices[0].message) {
                  responseText = typeof orData.choices[0].message.content === 'string' ? orData.choices[0].message.content : JSON.stringify(orData.choices[0].message.content);
                  success = true;
              }
              break;

            case "google":
              if (!env.GEMINI_API_KEY) throw new ConfigurationError("Gemini API key not configured.", 'GEMINI_API_KEY_MISSING');
              const googleMessages = messages.map(msg => ({
                  role: msg.role === 'system' ? 'user' : msg.role, parts: [{ text: msg.content }]
              }));
              const googleResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${env.GEMINI_API_KEY}`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: googleMessages, generationConfig: { responseMimeType: "application/json", maxOutputTokens: 3000, temperature: 0, } }),
                signal: AbortSignal.timeout(20000)
              });
              if (!googleResp.ok) {
                  const errorBody = await googleResp.json().catch(() => ({ message: "Unknown Gemini error" }));
                  throw new LLMError(`Gemini API failed: ${googleResp.status} - ${errorBody.message || JSON.stringify(errorBody)}`, 'GEMINI_API_FAILED', { httpStatus: googleResp.status, errorBody: errorBody });
              }
              const googleData = await googleResp.json();
              if (googleData.candidates && googleData.candidates[0] && googleData.candidates[0].content && googleData.candidates[0].content.parts) {
                  responseText = googleData.candidates[0].content.parts[0].text;
                  success = true;
              }
              break;

            default:
              throw new ConfigurationError(`Unsupported LLM provider: ${provider}`, 'UNSUPPORTED_LLM_PROVIDER', { provider: provider });
          }

          if (success && responseText.trim()) {
            outputTokens = responseText.length / 4;
            metricsCollector.increment('llm_tokens_input_total', inputTokens, { provider: provider, model: currentModel, component: 'LLMRouter' });
            metricsCollector.increment('llm_tokens_output_total', outputTokens, { provider: provider, model: currentModel, component: 'LLMRouter' });

            const cleaned = cleanJson(responseText);
            try {
              const parsedData = JSON.parse(cleaned);
              metricsCollector.increment('llm_call_success_total', 1, { provider: provider, model: currentModel, component: 'LLMRouter' });
              return { data: parsedData, provider: provider, model: currentModel, confidence: 0.9 };
            } catch (jsonErr) {
              try {
                const repaired = cleaned.replace(/,(\s*[}\]])/g, "$1");
                const parsedData = JSON.parse(repaired);
                logger.warn(`JSON repaired (trailing comma) from ${provider}/${currentModel}.`, { error: jsonErr.message });
                metricsCollector.increment('llm_json_repair_success_total', 1, { provider: provider, model: currentModel, component: 'LLMRouter' });
                return { data: parsedData, provider: provider, model: currentModel, confidence: 0.85 };
              } catch (repairErr) {
                lastError = new LLMError(`JSON parsing failed from ${provider}/${currentModel}: ${jsonErr.message}. Raw: ${responseText}`, 'LLM_JSON_PARSE_FAILED', { provider, model: currentModel, rawResponse: responseText });
                logger.error(lastError.message, { error: repairErr.message });
                metricsCollector.increment('llm_json_repair_failure_total', 1, { provider: provider, model: currentModel, component: 'LLMRouter' });
              }
            }
          } else if (success) {
            lastError = new LLMError(`Empty response from ${provider}/${currentModel}.`, 'LLM_EMPTY_RESPONSE', { provider, model: currentModel });
            logger.warn(lastError.message);
            metricsCollector.increment('llm_call_empty_response_total', 1, { provider: provider, model: currentModel, component: 'LLMRouter' });
          }
        } catch (e) {
          lastError = e;
          logger.error(`LLM call failed for ${provider}/${currentModel}:`, { error: e.message, stack: e.stack });
          metricsCollector.increment('llm_call_failure_total', 1, { provider: provider, model: currentModel, errorType: e.name || 'UnknownError', component: 'LLMRouter' });
        }
      }
    }
    workerLogger.critical("All LLM attempts failed: " + (lastError ? lastError.message : "No models responded."));
    throw new LLMError("All LLM attempts failed: " + (lastError ? lastError.message : "No models responded."), 'ALL_LLM_ATTEMPTS_FAILED', { lastError: lastError?.message });
  }
};


const capabilityRegistry = {
  LLMServiceCapability: {
    id: "LLMServiceCapability",
    description: "Executes LLM calls via LLM Router.",
    execute: async (prompt, schema, modelPreference, env, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const { data, provider, model, confidence } = await LLMRouter.route(prompt, schema, modelPreference, env, logger.child({ component: 'LLMServiceCapability' }), metricsCollector);
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'LLMServiceCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'LLMServiceCapability', component: 'CapabilityRegistry' });
        return { data, provider, model, confidence };
      } catch (e) {
        logger.error(`LLMServiceCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'LLMServiceCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'LLMServiceCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  TaxonomyLookupCapability: {
    id: "TaxonomyLookupCapability",
    description: "Queries the Knowledge Base for relevant taxonomies, rules, or profiles.",
    execute: (pluginName, key, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const plugin = KNOWLEDGE_BASE_PLUGINS[pluginName];
        if (!plugin) {
          logger.warn(`Knowledge Base Plugin '${pluginName}' not found.`, { pluginName });
          metricsCollector.increment('kb_lookup_failure_total', 1, { reason: 'plugin_not_found', pluginName: pluginName, component: 'TaxonomyLookupCapability' });
          return null;
        }
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'TaxonomyLookupCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'TaxonomyLookupCapability', component: 'CapabilityRegistry' });
        return plugin[key] || null;
      } catch (e) {
        logger.error(`TaxonomyLookupCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'TaxonomyLookupCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'TaxonomyLookupCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  SearchExecutionCapability: {
    id: "SearchExecutionCapability",
    description: "Interacts with external search APIs (YouTube direct; TikTok and Reddit via Apify).",
    execute: async (platform, query, filters, env, logger, metricsCollector) => {
      const startTime = Date.now();
      let searchStatus = 'failed';
      let errorType = 'UnknownError';
      let resultsCount = 0;

      try {
        metricsCollector.increment('search_execution_total', 1, { platform: platform, component: 'SearchExecutionCapability' }); // New metric

        if (platform.toLowerCase() === "youtube") {
          if (!env.YOUTUBE_API_KEY) {
            logger.warn("YouTube search skipped: YOUTUBE_API_KEY not configured on this Worker.", { platform });
            metricsCollector.increment('search_skipped_total', 1, { platform: 'youtube', reason: 'api_key_missing', component: 'SearchExecutionCapability' });
            return [];
          }

          const ageMonths = Number(filters.max_age_months) > 0 ? Number(filters.max_age_months) : 12;
          const publishedAfter = new Date(Date.now() - ageMonths * 30 * 24 * 60 * 60 * 1000).toISOString();

          const paramsObj = {
            part: "snippet", q: query, key: env.YOUTUBE_API_KEY, maxResults: String(filters.max_results || 10),
            type: "video", videoDuration: "short", order: "viewCount", publishedAfter: publishedAfter
          };
          const params = new URLSearchParams(paramsObj);

          try {
            const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
            if (!searchResp.ok) {
              const errBody = await searchResp.text().catch(() => "");
              logger.warn("YT search failed:", { status: searchResp.status, errorBody: errBody.slice(0, 300) });
              throw new RepositoryError(`YouTube search API failed with status ${searchResp.status}`, 'YOUTUBE_SEARCH_API_FAILED', { status: searchResp.status, responseBody: errBody }); // Standardized Error
            }
            const searchData = await searchResp.json();
            const ids = searchData.items.map(i => i.id.videoId).filter(Boolean).join(",");
            if (!ids) { searchStatus = 'success_no_results'; return []; }
            
            const detResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${env.YOUTUBE_API_KEY}`);
            if (!detResp.ok) {
                const errBody = await detResp.text().catch(() => "");
                logger.warn("YT details fetch failed:", { status: detResp.status, errorBody: errBody.slice(0, 300) });
                throw new RepositoryError(`YouTube video details API failed with status ${detResp.status}`, 'YOUTUBE_DETAILS_API_FAILED', { status: detResp.status, responseBody: errBody }); // Standardized Error
            }
            const detData = await detResp.json();
            searchStatus = 'success';
            resultsCount = detData.items.length;
            metricsCollector.increment('search_results_total', resultsCount, { platform: 'youtube', component: 'SearchExecutionCapability' });
            return (detData.items || []).map(v => ({
              id: v.id, url: `https://www.youtube.com/watch?v=${v.id}`, title: v.snippet.title,
              platform: "YouTube", creator_handle: v.snippet.channelTitle, channelId: v.snippet.channelId,
              thumbnail_url: v.snippet.thumbnails?.medium?.url || "", tags: v.snippet.tags || [],
              description_snippet: (v.snippet.description || "").slice(0, 300),
              views_approx: parseInt(v.statistics.viewCount || "0", 10),
              likes_approx: parseInt(v.statistics.likeCount || "0", 10),
              comments: parseInt(v.statistics.commentCount || "0", 10),
              published_at: v.snippet.publishedAt, source_type: "YouTube_API"
            }));
          } catch (e) {
            logger.warn("YouTube API search failed:", { error: e.message });
            errorType = e.name || 'YouTubeAPIError';
            throw e;
          }
        }

        if (platform.toLowerCase() === "tiktok") {
          if (!env.APIFY_API_TOKEN) {
            logger.warn("TikTok search skipped: APIFY_API_TOKEN not configured on this Worker.", { platform });
            metricsCollector.increment('search_skipped_total', 1, { platform: 'tiktok', reason: 'api_key_missing', component: 'SearchExecutionCapability' });
            return [];
          }
          try {
            const apifyUrl = `https://api.apify.com/v2/actors/clockworks~tiktok-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(env.APIFY_API_TOKEN)}`;
            const body = {
              searchQueries: [query], resultsPerPage: Math.min(Number(filters.max_results) || 10, 30), searchSection: "/video"
            };
            const resp = await fetch(apifyUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!resp.ok) {
              const errBody = await resp.text().catch(() => "");
              logger.warn("TikTok (Apify) search failed:", { status: resp.status, errorBody: errBody.slice(0, 300) });
              throw new RepositoryError(`TikTok search API failed with status ${resp.status}`, 'TIKTOK_SEARCH_API_FAILED', { status: resp.status, responseBody: errBody }); // Standardized Error
            }
            const items = await resp.json();
            searchStatus = 'success';
            resultsCount = items.length;
            metricsCollector.increment('search_results_total', resultsCount, { platform: 'tiktok', component: 'SearchExecutionCapability' });
            return (Array.isArray(items) ? items : []).map(v => ({
              id: v.id || v.videoId || v.webVideoUrl, url: v.webVideoUrl || v.videoUrl || "",
              title: (v.text || v.desc || "").slice(0, 200), platform: "TikTok",
              creator_handle: v.authorMeta?.name || v.authorMeta?.nickName || v.author?.uniqueId || "",
              thumbnail_url: v.videoMeta?.coverUrl || v.covers?.default || "",
              tags: (v.hashtags || []).map(h => (typeof h === "string" ? h : h.name)).filter(Boolean),
              description_snippet: (v.text || v.desc || "").slice(0, 300),
              views_approx: Number(v.playCount || v.videoMeta?.playCount || 0),
              likes_approx: Number(v.diggCount || 0), comments: Number(v.commentCount || 0),
              published_at: v.createTimeISO || "", source_type: "TikTok_Apify"
            })).filter(c => c.url);
          } catch (e) {
            logger.warn("TikTok (Apify) search failed:", { error: e.message });
            errorType = e.name || 'TikTokAPIError';
            throw e;
          }
        }

        if (platform.toLowerCase() === "reddit") {
          if (!env.APIFY_API_TOKEN) {
            logger.warn("Reddit search skipped: APIFY_API_TOKEN not configured on this Worker.", { platform });
            metricsCollector.increment('search_skipped_total', 1, { platform: 'reddit', reason: 'api_key_missing', component: 'SearchExecutionCapability' });
            return [];
          }
          try {
            const apifyUrl = `https://api.apify.com/v2/actors/solidcode~reddit-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(env.APIFY_API_TOKEN)}`;
            const body = {
              searches: [query], searchPosts: true, searchComments: false, searchCommunities: false, searchUsers: false,
              sort: "relevance", maxItems: Math.min(Number(filters.max_results) || 10, 30), skipComments: true
            };
            const resp = await fetch(apifyUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!resp.ok) {
              const errBody = await resp.text().catch(() => "");
              logger.warn("Reddit (Apify) search failed:", { status: resp.status, errorBody: errBody.slice(0, 300) });
              throw new RepositoryError(`Reddit search API failed with status ${resp.status}`, 'REDDIT_SEARCH_API_FAILED', { status: resp.status, responseBody: errBody }); // Standardized Error
            }
            const items = await resp.json();
            const posts = (Array.isArray(items) ? items : []).filter(v => !v.recordType || v.recordType === "post");
            searchStatus = 'success';
            resultsCount = posts.length;
            metricsCollector.increment('search_results_total', resultsCount, { platform: 'reddit', component: 'SearchExecutionCapability' });
            return posts.map(v => {
              const permalink = v.permalink || v.url || "";
              const url = permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
              return {
                id: v.id || v.postId || url, url, title: v.title || "", platform: "Reddit",
                creator_handle: v.author || v.username || "",
                thumbnail_url: (v.thumbnail && v.thumbnail.startsWith("http")) ? v.thumbnail : "",
                tags: v.subreddit ? [v.subreddit] : [],
                description_snippet: (v.selftext || v.text || "").slice(0, 300),
                views_approx: 0, likes_approx: Number(v.score || v.upvotes || 0), comments: Number(v.commentCount || 0),
                published_at: v.createdAt || v.createdUtc || "", source_type: "Reddit_Apify"
              };
            }).filter(c => c.url);
          } catch (e) {
            logger.warn("Reddit (Apify) search failed:", { error: e.message });
            errorType = e.name || 'RedditAPIError';
            throw e;
          }
        }
        searchStatus = 'skipped';
        return [];
      } finally {
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'SearchExecutionCapability', status: searchStatus, errorType: errorType, platform: platform, resultsCount: resultsCount, component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_total', 1, { capability: 'SearchExecutionCapability', status: searchStatus, platform: platform, component: 'CapabilityRegistry' });
      }
    }
  },
  DataValidationCapability: {
    id: "DataValidationCapability",
    description: "Applies rules-based validation.",
    execute: (clips, rules, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const uniqueClips = [];
        const seenUrls = new Set();
        for (const clip of clips) {
          if (!seenUrls.has(clip.url)) {
            uniqueClips.push(clip);
            seenUrls.add(clip.url);
          }
        }
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'DataValidationCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'DataValidationCapability', component: 'CapabilityRegistry' });
        return uniqueClips;
      } catch (e) {
        logger.error(`DataValidationCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'DataValidationCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'DataValidationCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  FeatureExtractionCapability: {
    id: "FeatureExtractionCapability",
    description: "Future: Extracts features from video/images.",
    execute: (logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        logger.info("FeatureExtractionCapability: Not implemented in Phase 1.");
        metricsCollector.increment('capability_not_implemented_total', 1, { capability: 'FeatureExtractionCapability', component: 'CapabilityRegistry' });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'FeatureExtractionCapability', status: 'skipped', component: 'CapabilityRegistry' });
        return {};
      } catch (e) {
        logger.error(`FeatureExtractionCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'FeatureExtractionCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'FeatureExtractionCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  ScoringAlgorithmCapability: {
    id: "ScoringAlgorithmCapability",
    description: "Applies predefined scoring algorithms.",
    execute: (clip, criteria, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const score = Math.round(Math.random() * 100);
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'ScoringAlgorithmCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'ScoringAlgorithmCapability', component: 'CapabilityRegistry' });
        return { score: score, reasoning: "Heuristic score in Phase 1." };
      } catch (e) {
        logger.error(`ScoringAlgorithmCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'ScoringAlgorithmCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'ScoringAlgorithmCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  NarrativeConstructionCapability: {
    id: "NarrativeConstructionCapability",
    description: "Applies algorithms or rules to arrange data into a narrative.",
    execute: (clips, rules, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'NarrativeConstructionCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'NarrativeConstructionCapability', component: 'CapabilityRegistry' });
        return clips;
      } catch (e) {
        logger.error(`NarrativeConstructionCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'NarrativeConstructionCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'NarrativeConstructionCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  PersistenceCapability: {
    id: "PersistenceCapability",
    description: "Handles saving/loading data to/from Project Memory and Runtime State.",
    execute: async (action, key, data, logger, metricsCollector, env) => {
      const startTime = Date.now();
      let status = 'failed';
      let errorType = 'UnknownError';
      try {
        logger.debug(`[PERSISTENCE] Action: ${action}, Key: ${key}, Data:`, data);
        if (action === "save" && key === "final_report" && env.DB) {
            // TODO Architectural Blocker: Real D1 write implementation needed.
            // Placeholder for D1 write. Actual implementation needs to map 'report' to D1 schema.
            // await env.DB.prepare("INSERT INTO reports (workflow_id, report_data, timestamp) VALUES (?, ?, ?)")
            //             .bind(data.workflowId, JSON.stringify(data.report), data.timestamp)
            //             .run();
            logger.info(`PersistenceCapability: Would save final_report to D1 for workflow ${data.workflowId}`);
            status = 'success';
        } else if (action === "save" && key === "final_report" && !env.DB) {
            logger.warn(`PersistenceCapability: Skipping D1 save for final_report as env.DB is not configured.`);
            status = 'skipped_no_db';
        } else {
            // Other persistence actions (e.g., loading from D1/KV) would go here in future phases.
            status = 'success'; // Assume success for simulated/logged actions
        }
        return;
      } catch (e) {
        logger.error(`PersistenceCapability failed: ${e.message}`, { error: e.stack, action: action, key: key });
        errorType = e.name || 'PersistenceError';
        throw e;
      } finally {
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'PersistenceCapability', status: status, action: action, errorType: errorType, component: 'CapabilityRegistry' });
        if (status === 'success') {
            metricsCollector.increment('capability_execution_success_total', 1, { capability: 'PersistenceCapability', action: action, component: 'CapabilityRegistry' });
        } else {
            metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'PersistenceCapability', action: action, errorType: errorType, component: 'CapabilityRegistry' });
        }
      }
    }
  },
  ConfidenceCalculationCapability: {
    id: "ConfidenceCalculationCapability",
    description: "Computes and propagates confidence scores.",
    execute: (inputConfidences, agentSpecificFactors, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const score = 85;
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'ConfidenceCalculationCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'ConfidenceCalculationCapability', component: 'CapabilityRegistry' });
        return { score: score, reasoning: "Phase 1: Heuristic confidence." };
      } catch (e) {
        logger.error(`ConfidenceCalculationCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'ConfidenceCalculationCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'ConfidenceCalculationCapability', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  PolicyEnforcementCapability: {
    id: "PolicyEnforcementCapability",
    description: "Applies policies from the Policy Layer.",
    execute: (policyId, data, context, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const result = PolicyEngine.apply(policyId, data, context, logger, metricsCollector); // Pass logger, metrics
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'PolicyEnforcementCapability', status: 'success', policyId: policyId, component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'PolicyEnforcementCapability', component: 'CapabilityRegistry' });
        return result;
      } catch (e) {
        logger.error(`PolicyEnforcementCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'PolicyEnforcementCapability', status: 'failed', policyId: policyId, errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'PolicyEnforcementCapability', errorType: errorType, component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  EventPublishingCapability: {
    id: "EventPublishingCapability",
    description: "Publishes events to the Event Bus.",
    execute: (type, payload, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        EventPublisher.publish(type, payload, logger, metricsCollector); // Pass logger, metrics
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'EventPublishingCapability', status: 'success', eventType: type, component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'EventPublishingCapability', component: 'CapabilityRegistry' });
      } catch (e) {
        logger.error(`EventPublishingCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'EventPublishingCapability', status: 'failed', eventType: type, errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'EventPublishingCapability', errorType: errorType, component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  StateAccessCapability: {
    id: "StateAccessCapability",
    description: "Provides controlled interface for agents to read/write to the Runtime State.",
    execute: (workflowId, action, data = null, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        const currentState = workflowStates[workflowId];
        if (!currentState) {
            throw new MomentNotFoundError(`Workflow state not found for ID: ${workflowId}`, workflowId, 'WORKFLOW_STATE_NOT_FOUND'); // Standardized error
        }
        if (action === "read") {
            metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'StateAccessCapability', status: 'success', action: action, component: 'CapabilityRegistry' });
            metricsCollector.increment('capability_execution_success_total', 1, { capability: 'StateAccessCapability', action: action, component: 'CapabilityRegistry' });
            return currentState;
        } else if (action === "update" && data) {
            const newState = currentState.update(data);
            workflowStates[workflowId] = newState;
            metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'StateAccessCapability', status: 'success', action: action, component: 'CapabilityRegistry' });
            metricsCollector.increment('capability_execution_success_total', 1, { capability: 'StateAccessCapability', action: action, component: 'CapabilityRegistry' });
            return newState;
        }
        throw new ValidationError(`Invalid action '${action}' for StateAccessCapability.`, 'INVALID_STATE_ACCESS_ACTION', { action }); // Standardized error
      } catch (e) {
        logger.error(`StateAccessCapability failed: ${e.message}`, { error: e.stack, workflowId: workflowId, action: action });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'StateAccessCapability', status: 'failed', action: action, errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'StateAccessCapability', action: action, errorType: errorType, component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
  ExplainabilityRecordingCapability: {
    id: "ExplainabilityRecordingCapability",
    description: "Records decision traces to the Explainability Layer.",
    execute: (decision, details, logger, metricsCollector) => {
      const startTime = Date.now();
      try {
        ExplainabilityRecorder.record(decision, details, logger, metricsCollector); // Pass logger, metrics
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'ExplainabilityRecordingCapability', status: 'success', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_success_total', 1, { capability: 'ExplainabilityRecordingCapability', component: 'CapabilityRegistry' });
      } catch (e) {
        logger.error(`ExplainabilityRecordingCapability failed: ${e.message}`, { error: e.stack });
        metricsCollector.observe('capability_execution_latency_ms', Date.now() - startTime, { capability: 'ExplainabilityRecordingCapability', status: 'failed', errorType: e.name || 'UnknownError', component: 'CapabilityRegistry' });
        metricsCollector.increment('capability_execution_failure_total', 1, { capability: 'ExplainabilityRecordingCapability', errorType: errorType, component: 'CapabilityRegistry' });
        throw e;
      }
    }
  },
};

// -----------------------------------------------------------------------------
// AGENT CONTRACT & IMPLEMENTATIONS
// -----------------------------------------------------------------------------

function createAgentContext(workflowId, env, logger, metricsCollector) {
  return {
    workflowId: workflowId,
    knowledge_base: capabilityRegistry.TaxonomyLookupCapability,
    capability_registry: capabilityRegistry,
    project_memory: capabilityRegistry.PersistenceCapability,
    global_constraints: {}, // Will be read from RuntimeState in agent run methods
    event_bus: capabilityRegistry.EventPublishingCapability,
    policy_engine: capabilityRegistry.PolicyEnforcementCapability,
    explainability_recorder: capabilityRegistry.ExplainabilityRecordingCapability,
    env: env, // Pass env to context for capabilities to access bindings
    logger: logger.child({ component: `AgentContext-${workflowId}` }), // Pass child logger
    metricsCollector: metricsCollector // Pass metrics collector
  };
}

const AGENT_REGISTRY = {
  EditorialDNAExtractionAgent: {
    id: "EditorialDNAExtractionAgent",
    version: "1.0.0",
    description: "Fetches real recent videos from reference channels and extracts a structured Editorial DNA profile from actual evidence (not channel-name text alone).",
    input_schema: { type: "object", properties: { referenceChannels: { type: "array" } } },
    output_schema: { type: "object" },
    dependencies: [],
    required_capabilities: ["LLMServiceCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Medium", estimated_latency_ms: 9000, max_retries: 2,
    read_state_keys: ["input_contract"],
    write_state_keys: ["editorial_dna_profile"],
    run: async (runtimeState, context) => {
      const { capability_registry, env, explainability_recorder, logger, metricsCollector } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const referenceChannels = (runtimeState.input_contract.referenceChannels || []).map(c => (c || "").trim()).filter(Boolean);
      
      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      const emptyResult = (reason) => {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, status: 'skipped', reason: reason, component: 'AgentRegistry' });
        agentMetrics.increment('agent_execution_skipped_total', 1, { agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, reason: reason, component: 'AgentRegistry' });
        return {
          success: true,
          result: { editorialDnaProfile: null },
          metadata: { agent_id: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, version: AGENT_REGISTRY.EditorialDNAExtractionAgent.version, confidence_score: 0, explainability_trace_id: 'trace_dna_1' },
          new_state_data: { editorial_dna_profile: null },
          events_to_publish: [{ type: "EDITORIAL_DNA_SKIPPED", payload: { reason } }]
        };
      };

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, component: 'AgentRegistry' });

        if (referenceChannels.length === 0) {
          explainability_recorder.execute("EditorialDNAExtractionAgent: No reference channels provided, skipping", {}, agentLogger, agentMetrics); // Pass logger, metrics
          return emptyResult("no_reference_channels");
        }
        if (!env.YOUTUBE_API_KEY) {
          explainability_recorder.execute("EditorialDNAExtractionAgent: YOUTUBE_API_KEY not configured, skipping", {}, agentLogger, agentMetrics); // Pass logger, metrics
          return emptyResult("youtube_api_key_missing");
        }

        const channelResults = await Promise.all(referenceChannels.slice(0, 4).map(async (link) => {
          try {
            const ref = parseYouTubeChannelRef(link);
            const channelId = await resolveYouTubeChannelId(ref, env.YOUTUBE_API_KEY, agentLogger, agentMetrics); // Pass logger, metrics
            if (!channelId) {
              explainability_recorder.execute("EditorialDNAExtractionAgent: Could not resolve channel", { link }, agentLogger, agentMetrics); // Pass logger, metrics
              return null;
            }
            const videos = await fetchRecentVideosForChannel(channelId, env.YOUTUBE_API_KEY, 12, agentLogger, agentMetrics); // Pass logger, metrics
            return videos.length > 0 ? { channel: link, videos } : null;
          } catch (e) {
            agentLogger.warn("EditorialDNAExtractionAgent: failed for", { link: link, error: e.message });
            return null;
          }
        }));
        const channelSummaries = channelResults.filter(Boolean);

        if (channelSummaries.length === 0) {
          explainability_recorder.execute("EditorialDNAExtractionAgent: Could not fetch real data for any reference channel", { referenceChannels }, agentLogger, agentMetrics); // Pass logger, metrics
          return emptyResult("no_channel_data_fetched");
        }

        const prompt =
          "You are analyzing REAL, actual recent videos from one or more YouTube creator channels that a user wants to model new content after. " +
          "This is REAL evidence — not a guess from a channel name. Base your analysis ONLY on what you observe below.\n\n" +
          "Channel data (channel, then its recent videos with title/description/duration in seconds/views):\n" +
          JSON.stringify(channelSummaries) + "\n\n" +
          "Extract a structured Editorial DNA profile per this exact contract:\n" +
          "- clip_archetypes: SPECIFIC recurring moment types you can infer from these titles (e.g. 'public fail with instant crowd reaction'), not generic labels like 'funny'\n" +
          "- hook_patterns: how these videos open / grab attention in the first moments (e.g. 'cold open directly on the failure moment, no intro or narration')\n" +
          "- emotion_patterns: the VIEWER'S EMOTIONAL ARC across a video, as a sequence (e.g. 'confusion -> shock -> laugh'), not a single word\n" +
          "- reject_patterns: content types this channel's style clearly does NOT do based on what you see (e.g. 'long-form commentary', 'tutorials', 'news')\n" +
          "- ranking_logic: ONE sentence on what you infer separates a #1 (best) from a #6 (weakest) for this channel's countdown format\n" +
          "- clip_length_range: object {min_sec, max_sec} — typical length of an individual moment referenced, inferred from video duration/pacing\n" +
          "- source_platforms: array of platforms this kind of content is typically sourced from (e.g. 'TikTok', 'YouTube Shorts', 'Instagram Reels', 'Reddit videos')\n" +
          "Be honest: you are inferring this from titles/descriptions/durations, not watching the actual footage. Do not overstate certainty.\n" +
          "Return ONLY JSON matching this structure.";

        const schema = {
          type: "object",
          properties: {
            clip_archetypes: { type: "array", items: { type: "string" } },
            hook_patterns: { type: "array", items: { type: "string" } },
            emotion_patterns: { type: "array", items: { type: "string" } },
            reject_patterns: { type: "array", items: { type: "string" } },
            ranking_logic: { type: "string" },
            clip_length_range: { type: "object", properties: { min_sec: { type: "number" }, max_sec: { type: "number" } } },
            source_platforms: { type: "array", items: { type: "string" } }
          },
          required: ["clip_archetypes", "hook_patterns", "emotion_patterns", "reject_patterns", "ranking_logic", "clip_length_range", "source_platforms"]
        };

        const { data, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env, agentLogger, agentMetrics);
        if (error) {
          agentLogger.warn("EditorialDNAExtractionAgent: LLM failed:", { error: error });
          throw new LLMError("EditorialDNAExtractionAgent: LLM failed to extract DNA.", 'DNA_LLM_FAILED', { originalError: error }); // Standardized error
        }

        const dnaProfile = {
          clip_archetypes: coerceToArray(data?.clip_archetypes), hook_patterns: coerceToArray(data?.hook_patterns), emotion_patterns: coerceToArray(data?.emotion_patterns),
          reject_patterns: coerceToArray(data?.reject_patterns), ranking_logic: typeof data?.ranking_logic === 'string' ? data.ranking_logic : "",
          clip_length_range: (data?.clip_length_range && typeof data.clip_length_range === 'object') ? data.clip_length_range : { min_sec: 5, max_sec: 20 },
          source_platforms: coerceToArray(data?.source_platforms), source_channels: referenceChannels,
          based_on_real_video_count: channelSummaries.reduce((sum, c) => sum + c.videos.length, 0)
        };

        explainability_recorder.execute("EditorialDNAExtractionAgent: Extracted DNA profile from real channel data", { dnaProfile, model, provider, confidence }, agentLogger, agentMetrics); // Pass logger, metrics
        agentStatus = 'completed';
        return {
          success: true, result: { editorialDnaProfile: dnaProfile },
          metadata: { agent_id: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, version: AGENT_REGISTRY.EditorialDNAExtractionAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_dna_1' },
          new_state_data: { editorial_dna_profile: dnaProfile },
          events_to_publish: [{ type: "EDITORIAL_DNA_EXTRACTED", payload: { channels: referenceChannels.length, videos_analyzed: dnaProfile.based_on_real_video_count } }]
        };
      } catch (e) {
        agentLogger.error("EditorialDNAExtractionAgent failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },

  OpportunityGenerator: {
    id: "OpportunityGenerator",
    version: "1.0.0",
    description: "Generates novel, trending, and high-potential Content Opportunity Topics.",
    input_schema: {},
    output_schema: { type: "array", items: { type: "string" } },
    dependencies: [],
    required_capabilities: ["LLMServiceCapability", "TaxonomyLookupCapability", "ConfidenceCalculationCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Low", estimated_latency_ms: 5000, max_retries: 2,
    read_state_keys: ["global_constraints"],
    write_state_keys: ["opportunity_topics"],
    run: async (runtimeState, context) => {
      const { capability_registry, knowledge_base, env, explainability_recorder, logger, metricsCollector } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const topicTaxonomy = knowledge_base.execute('core', 'content_taxonomy', logger, metricsCollector);
      const trendProfiles = knowledge_base.execute('core', 'trend_profiles', logger, metricsCollector);

      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.OpportunityGenerator.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.OpportunityGenerator.id, component: 'AgentRegistry' });
        const prompt = "Based on current trends (e.g., seasonal, evergreen from " + JSON.stringify(trendProfiles) + ") and content categories (" + JSON.stringify(topicTaxonomy) + "), generate 5-8 novel and high-potential \"Ranking\" format video topic ideas. Focus on unique combinations, current relevance, and high replay value. Ensure varied topics. Return ONLY JSON array of strings.";
        
        const { data: topics, confidence, error, model, provider } = await llmService.execute(prompt, { type: "array", items: { type: "string" } }, runtimeState.input_contract.model_preference, env, agentLogger, agentMetrics);

        if (error) {
            agentLogger.warn("LLM for OpportunityGenerator failed:", { error: error });
            throw new LLMError("LLM for OpportunityGenerator failed: " + error, 'OPPORTUNITY_LLM_FAILED', { originalError: error });
        }
        const safeTopics = coerceToArray(topics);
        explainability_recorder.execute("OpportunityGenerator: Generated topics", { topics: safeTopics, model, provider, confidence }, agentLogger, agentMetrics); // Pass logger, metrics
        agentStatus = 'completed';
        return {
          success: true, result: { topics: safeTopics },
          metadata: { agent_id: AGENT_REGISTRY.OpportunityGenerator.id, version: AGENT_REGISTRY.OpportunityGenerator.version, confidence_score: confidence, explainability_trace_id: 'trace_og_1' },
          new_state_data: { opportunity_topics: safeTopics },
          events_to_publish: [{ type: "OPPORTUNITIES_GENERATED", payload: { topics: safeTopics } }]
        };
      } catch (e) {
        agentLogger.error("OpportunityGenerator failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.OpportunityGenerator.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.OpportunityGenerator.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.OpportunityGenerator.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },

  EditorialIntentAgent: {
    id: "EditorialIntentAgent",
    version: "1.0.0",
    description: "Translates user input into a precise and actionable Editorial Intent.",
    input_schema: { type: "object", properties: { topic: { type: "string" }, creativeBrief: { type: "string" } } },
    output_schema: { type: "object" },
    dependencies: ["OpportunityGenerator", "EditorialDNAExtractionAgent"],
    required_capabilities: ["LLMServiceCapability", "TaxonomyLookupCapability", "ConfidenceCalculationCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Low", estimated_latency_ms: 6000, max_retries: 2,
    read_state_keys: ["input_contract", "opportunity_topics", "editorial_dna_profile"],
    write_state_keys: ["editorial_intent"],
    run: async (runtimeState, context) => {
      const { capability_registry, knowledge_base, env, explainability_recorder, logger, metricsCollector } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const emotionTaxonomy = knowledge_base.execute('core', 'emotion_taxonomy', logger, metricsCollector);
      const platformProfiles = knowledge_base.execute('core', 'platform_profiles', logger, metricsCollector);
      const contentTaxonomy = knowledge_base.execute('core', 'content_taxonomy', logger, metricsCollector);

      const { topic, creativeBrief, referenceChannels, constraints } = runtimeState.input_contract;
      const dnaProfile = runtimeState.editorial_dna_profile;

      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.EditorialIntentAgent.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.EditorialIntentAgent.id, component: 'AgentRegistry' });
        const prompt = "Given the topic \"" + topic + "\", creative brief \"" + creativeBrief + "\", and reference channels \"" + (referenceChannels || 'none') + "\", define the precise Editorial Intent.\n" +
        (dnaProfile
          ? "IMPORTANT: an Editorial DNA profile was already extracted from REAL recent videos on the reference channel(s) (based on " + dnaProfile.based_on_real_video_count + " actual videos analyzed): " + JSON.stringify(dnaProfile) + ". Align the Editorial Intent tightly with this real, evidence-based profile — its reject_patterns in particular should directly inform reject_content_types below.\n"
          : "") +
        "Consider target emotions (" + JSON.stringify(emotionTaxonomy) + "), platform characteristics (" + JSON.stringify(platformProfiles) + "), and content categories (" + JSON.stringify(contentTaxonomy) + ").\n" +
        "Think like a human video editor planning a research strategy for THIS SPECIFIC topic — not a generic search. " +
        "For 'acceptable_event_types', list 5-8 SPECIFIC real-world scenario types that would genuinely satisfy this topic as single short moments (e.g. for \"perfect timing coincidences\": photobombs, object collisions, camera-timing illusions, lucky near-misses — NOT generic restatements of the topic words). " +
        "For 'reject_content_types', list content categories a search for this topic could easily surface but that DO NOT belong (e.g. DIY/craft tutorials, podcasts, news reports, movie/TV clips, reaction videos, gaming clips, long compilations — pick whichever of these are actually plausible false positives for THIS topic, add others if relevant).\n" +
        "Output JSON with fields: topic, creative_brief_summary, primary_moment_categories[], acceptable_event_types[], reject_content_types[], target_emotions[], desired_clip_characteristics{}, target_platform_intents[] (platform, specific_criteria, priority_score), target_audience_profile, overall_content_goal.";

        const schema = {
          type: "object",
          properties: {
            topic: { type: "string" }, creative_brief_summary: { type: "string" }, primary_moment_categories: { type: "array", items: { type: "string" } },
            acceptable_event_types: { type: "array", items: { type: "string" } }, reject_content_types: { type: "array", items: { type: "string" } },
            target_emotions: { type: "array", items: { type: "string" } }, desired_clip_characteristics: { type: "object" },
            target_platform_intents: { type: "array", items: { type: "object" } }, target_audience_profile: { type: "string" },
            overall_content_goal: { type: "string" },
          },
          required: ["topic", "creative_brief_summary", "primary_moment_categories", "acceptable_event_types", "reject_content_types", "target_emotions", "desired_clip_characteristics", "target_platform_intents", "target_audience_profile", "overall_content_goal"]
        };

        const { data: llmData, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env, agentLogger, agentMetrics);

        if (error) {
            agentLogger.warn("LLM for EditorialIntentAgent failed:", { error: error });
            throw new LLMError("LLM for EditorialIntentAgent failed: " + error, 'EDITORIAL_INTENT_LLM_FAILED', { originalError: error });
        }
        
        const finalEditorialIntent = {
            ...llmData,
            topic: llmData.topic || topic,
            creative_brief_summary: llmData.creative_brief_summary || creativeBrief,
            acceptable_event_types: coerceToArray(llmData.acceptable_event_types),
            reject_content_types: coerceToArray(llmData.reject_content_types)
        };

        explainability_recorder.execute("EditorialIntentAgent: Generated intent", { editorialIntent: finalEditorialIntent, model, provider, confidence }, agentLogger, agentMetrics);
        agentStatus = 'completed';
        return {
          success: true, result: { editorialIntent: finalEditorialIntent || {} },
          metadata: { agent_id: AGENT_REGISTRY.EditorialIntentAgent.id, version: AGENT_REGISTRY.EditorialIntentAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_ei_1' },
          new_state_data: { editorial_intent: finalEditorialIntent || {} },
          events_to_publish: [{ type: "EDITORIAL_INTENT_GENERATED", payload: { editorialIntent: finalEditorialIntent || {} } }]
        };
      } catch (e) {
        agentLogger.error("EditorialIntentAgent failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.EditorialIntentAgent.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.EditorialIntentAgent.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.EditorialIntentAgent.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },

  MomentOntologyAgent: {
    id: "MomentOntologyAgent",
    version: "1.0.0",
    description: "Generates a detailed Moment Ontology from categories to granular moment and scene types.",
    input_schema: { type: "object", properties: { primary_moment_categories: { type: "array" } } },
    output_schema: { type: "array", items: { type: "object" } },
    dependencies: ["EditorialIntentAgent"],
    required_capabilities: ["LLMServiceCapability", "TaxonomyLookupCapability", "ConfidenceCalculationCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Low", estimated_latency_ms: 7000, max_retries: 2,
    read_state_keys: ["editorial_intent"],
    write_state_keys: ["moment_ontology"],
    run: async (runtimeState, context) => {
      const { capability_registry, knowledge_base, env, explainability_recorder, logger, metricsCollector } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const primaryCategories = runtimeState.editorial_intent?.primary_moment_categories || [];

      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.MomentOntologyAgent.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.MomentOntologyAgent.id, component: 'AgentRegistry' });
        const momentTaxonomyCore = knowledge_base.execute('core', 'moment_taxonomy', agentLogger, agentMetrics);
        const topicText = runtimeState.editorial_intent?.topic || runtimeState.input_contract?.topic || "";
        const briefText = runtimeState.editorial_intent?.creative_brief_summary || runtimeState.input_contract?.creativeBrief || "";
        const momentTaxonomyFails = isPluginRelevant("fails", topicText, briefText)
          ? (knowledge_base.execute('fails', 'moment_taxonomy', agentLogger, agentMetrics) || {})
          : {};
        const combinedMomentTaxonomy = { ...momentTaxonomyCore, ...momentTaxonomyFails };


        const prompt = "Given primary moment categories " + JSON.stringify(primaryCategories) + " and existing moment taxonomies like " + JSON.stringify(combinedMomentTaxonomy) + ", expand them into detailed Moment Types and associated Scene Types (visualizable scenarios).\n" +
        "Output JSON as an array of objects, each with 'category', 'moment_types' (array of {type:string, scene_types:string[]}).";

        const schema = {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string" }, moment_types: { type: "array", items: { type: "object", properties: { type: { type: "string" }, scene_types: { type: "array", items: { type: "string" } } } } }
            }
          }
        };

        const { data: momentOntology, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env, agentLogger, agentMetrics);

        if (error) {
            agentLogger.warn("LLM for MomentOntologyAgent failed:", { error: error });
            throw new LLMError("LLM for MomentOntologyAgent failed: " + error, 'MOMENT_ONTOLOGY_LLM_FAILED', { originalError: error });
        }
        const safeMomentOntology = coerceToArray(momentOntology);
        explainability_recorder.execute("MomentOntologyAgent: Generated ontology", { momentOntology: safeMomentOntology, model, provider, confidence }, agentLogger, agentMetrics);
        agentStatus = 'completed';
        return {
          success: true, result: { momentOntology: safeMomentOntology },
          metadata: { agent_id: AGENT_REGISTRY.MomentOntologyAgent.id, version: AGENT_REGISTRY.MomentOntologyAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_mo_1' },
          new_state_data: { moment_ontology: safeMomentOntology },
          events_to_publish: [{ type: "MOMENT_ONTOLOGY_CREATED", payload: { momentOntology: safeMomentOntology } }]
        };
      } catch (e) {
        agentLogger.error("MomentOntologyAgent failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.MomentOntologyAgent.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.MomentOntologyAgent.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.MomentOntologyAgent.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },

  DiscoveryStrategyPlannerAgent: {
    id: "DiscoveryStrategyPlannerAgent",
    version: "1.0.0",
    description: "Develops highly targeted Discovery Missions with prioritization, cost estimation, and expected yield.",
    input_schema: { type: "object", properties: { editorial_intent: { type: "object" }, moment_ontology: { type: "array" } } },
    output_schema: { type: "array", items: { type: "object" } },
    dependencies: ["EditorialIntentAgent", "MomentOntologyAgent"],
    required_capabilities: ["LLMServiceCapability", "TaxonomyLookupCapability", "ConfidenceCalculationCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Medium", estimated_latency_ms: 10000, max_retries: 2,
    read_state_keys: ["editorial_intent", "moment_ontology", "global_constraints"],
    write_state_keys: ["discovery_missions"],
    run: async (runtimeState, context) => {
      const { capability_registry, knowledge_base, env, explainability_recorder, logger, metricsCollector } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const platformProfiles = knowledge_base.execute('core', 'platform_profiles', logger, metricsCollector);
      const hookTypes = knowledge_base.execute('core', 'hook_types', logger, metricsCollector) || [];
      const originalSourceTypes = knowledge_base.execute('core', 'original_source_types', logger, metricsCollector) || [];
      const dspTopicText = runtimeState.editorial_intent?.topic || runtimeState.input_contract?.topic || "";
      const dspBriefText = runtimeState.editorial_intent?.creative_brief_summary || runtimeState.input_contract?.creativeBrief || "";
      const momentPatternsFails = isPluginRelevant("fails", dspTopicText, dspBriefText)
        ? knowledge_base.execute('fails', 'moment_patterns', logger, metricsCollector)
        : null;

      const editorialIntent = runtimeState.editorial_intent;
      const momentOntology = runtimeState.moment_ontology;
      const constraints = runtimeState.global_constraints;

      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id, component: 'AgentRegistry' });
        const prompt = "Based on the Editorial Intent (" + JSON.stringify(editorialIntent) + "), Moment Ontology (" + JSON.stringify(momentOntology) + "), global constraints (" + JSON.stringify(constraints) + "), and platform profiles (" + JSON.stringify(platformProfiles) + "), generate 4-6 Discovery Missions (keep this count — more than 6 tends to get truncated by smaller models).\n" +
        "IMPORTANT: build primary_queries/keywords from the SPECIFIC acceptable_event_types in the Editorial Intent (e.g. 'photobomb', 'object collision') — do NOT just restate the topic words verbatim as the only query, since that tends to surface pre-made compilation/ranking videos about the topic rather than raw individual moments.\n" +
        "Hook mechanisms to consider when framing missions (what actually makes a moment grab attention, not just a topic label): " + JSON.stringify(hookTypes) + ".\n" +
        "Prefer search terms that point at RAW original footage types: " + JSON.stringify(originalSourceTypes) + " — these surface single original moments far more reliably than generic topic searches.\n" +
        (momentPatternsFails
          ? "Relevant moment patterns for this topic (each with narrative shape + searchSignals that are already policy-safe, i.e. never 'compilation'/'best of'/'top 10', which are already globally rejected above): " + JSON.stringify(momentPatternsFails) + ". Use the searchSignals as a starting point for primary_queries/keywords, combined with the specific acceptable_event_types.\n"
          : "") +
        "Each mission should include: mission_focus, clip_criteria (from editorialIntent.desired_clip_characteristics), priority_score (1-100), confidence_score (1-100), estimated_cost (Low/Medium/High), expected_yield (Low/Medium/High), and platform_strategies[] (platform, search_approach, primary_queries[], secondary_queries[], hashtags[], keywords[], filters{}).\n" +
        "Return ONLY JSON array of Discovery Mission objects.";

        const schema = {
          type: "array",
          items: {
            type: "object",
            properties: {
              mission_focus: { type: "string" }, clip_criteria: { type: "object" }, priority_score: { type: "integer" },
              confidence_score: { type: "integer" }, estimated_cost: { type: "string" }, expected_yield: { type: "string" },
              platform_strategies: {
                type: "array",
                items: {
                  type: "object", properties: {
                    platform: { type: "string" }, search_approach: { type: "string" },
                    primary_queries: { type: "array", items: { type: "string" } }, secondary_queries: { type: "array", items: { type: "string" } },
                    hashtags: { type: "array", items: { type: "string" } }, keywords: { type: "array", items: { type: "string" } }, filters: { type: "object" }
                  }
                }
              }
            },
            required: ["mission_focus", "clip_criteria", "priority_score", "confidence_score", "estimated_cost", "expected_yield", "platform_strategies"]
          }
        };

        const { data: discoveryMissions, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env, agentLogger, agentMetrics);

        if (error) {
            agentLogger.warn("LLM for DiscoveryStrategyPlannerAgent failed:", { error: error });
            throw new LLMError("LLM for DiscoveryStrategyPlannerAgent failed: " + error, 'DISCOVERY_PLANNER_LLM_FAILED', { originalError: error });
        }
        const safeDiscoveryMissions = coerceToArray(discoveryMissions);
        explainability_recorder.execute("DiscoveryStrategyPlannerAgent: Generated missions", { discoveryMissions: safeDiscoveryMissions, model, provider, confidence }, agentLogger, agentMetrics);
        const sortedMissions = safeDiscoveryMissions.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
        agentStatus = 'completed';
        return {
          success: true, result: { discoveryMissions: sortedMissions },
          metadata: { agent_id: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id, version: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_dsp_1' },
          new_state_data: { discovery_missions: sortedMissions },
          events_to_publish: [{ type: "DISCOVERY_MISSIONS_PLANNED", payload: { missions: sortedMissions } }]
        };
      } catch (e) {
        agentLogger.error("DiscoveryStrategyPlannerAgent failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },

  SourceHunterAgent: {
    id: "SourceHunterAgent",
    version: "1.0.0",
    description: "Executes Discovery Missions across platforms to retrieve Raw Clips.",
    input_schema: { type: "object", properties: { discovery_missions: { type: "array" } } },
    output_schema: { type: "object", properties: { raw_clips: { type: "array" } } },
    dependencies: ["DiscoveryStrategyPlannerAgent"],
    required_capabilities: ["SearchExecutionCapability", "PersistenceCapability", "EventPublishingCapability", "ConfidenceCalculationCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Medium", estimated_latency_ms: 15000, max_retries: 3,
    read_state_keys: ["discovery_missions", "editorial_intent", "editorial_dna_profile"],
    write_state_keys: ["raw_clips_collected", "discovery_queue_status"],
    run: async (runtimeState, context) => {
      const { capability_registry, env, explainability_recorder, logger, metricsCollector } = context;
      const searchExecution = capability_registry.SearchExecutionCapability;
      const persistence = capability_registry.PersistenceCapability;
      const eventPublishing = capability_registry.EventPublishingCapability;

      const discoveryMissions = runtimeState.discovery_missions || [];
      const allRawClips = [];
      let pendingSearches = 0;

      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.SourceHunterAgent.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.SourceHunterAgent.id, component: 'AgentRegistry' });
        explainability_recorder.execute("SourceHunterAgent: Starting clip discovery", { missions: discoveryMissions.length }, agentLogger, agentMetrics);

        const searchPromises = discoveryMissions.flatMap(mission =>
          (mission.platform_strategies || []).map(async (strategy) => {
            pendingSearches++;
            const primaryQueries = strategy.primary_queries || [];
            const keywords = strategy.keywords || [];
            const query = (primaryQueries.length ? primaryQueries : keywords).join(" ");

            if (!query) {
              pendingSearches--;
              explainability_recorder.execute("SourceHunterAgent: Skipped strategy with no query terms", { mission_focus: mission.mission_focus, platform: strategy.platform }, agentLogger, agentMetrics);
              agentLogger.debug("Skipped search strategy due to no query terms.", { mission_focus: mission.mission_focus, platform: strategy.platform });
              return;
            }

            const clips = await searchExecution.execute(strategy.platform, query, {
              ...strategy.filters,
              max_results: 10,
              max_age_months: runtimeState.editorial_intent?.desired_clip_characteristics?.max_age_months
            }, env, agentLogger, agentMetrics);

            allRawClips.push(...clips);
            eventPublishing.execute("RAW_CLIP_COLLECTED", { workflowId: context.workflowId, mission_focus: mission.mission_focus, platform: strategy.platform, count: clips.length }, agentLogger, agentMetrics);
            explainability_recorder.execute("SourceHunterAgent: Found " + clips.length + " clips for '" + mission.mission_focus + "' on " + strategy.platform, { query, count: clips.length }, agentLogger, agentMetrics);
            pendingSearches--;
          })
        );

        await Promise.all(searchPromises);

        const dcc = runtimeState.editorial_intent?.desired_clip_characteristics || {};
        const wantsNoCompilation = dcc.not_compilation !== false;
        const wantsNoRanking = dcc.not_ranking_video !== false;
        const policyRules = knowledge_base.execute('core', 'policy_rules', agentLogger, agentMetrics) || {};
        const compilationWords = policyRules.NO_COMPILATION_KEYWORDS || [];
        const rankingWords = policyRules.NO_RANKING_KEYWORDS || [];

        const STOPWORDS = new Set(["videos", "video", "content", "clips", "clip", "and", "or", "the", "a", "an", "long"]);
        const dnaRejectWords = (runtimeState.editorial_dna_profile?.reject_patterns || [])
          .flatMap(phrase => phrase.toLowerCase().split(/\s+/))
          .filter(w => w.length > 3 && !STOPWORDS.has(w));

        const intentRejectWords = (runtimeState.editorial_intent?.reject_content_types || [])
          .flatMap(phrase => phrase.toLowerCase().split(/\s+/))
          .filter(w => w.length > 3 && !STOPWORDS.has(w));

        const looksLikeCompilationOrRanking = (clip) => {
          const haystack = ((clip.title || "") + " " + (clip.description_snippet || "")).toLowerCase();
          if (wantsNoCompilation && compilationWords.some(w => haystack.includes(w.toLowerCase()))) return true;
          if (wantsNoRanking && rankingWords.some(w => haystack.includes(w.toLowerCase()))) return true;
          if (dnaRejectWords.some(w => haystack.includes(w))) return true;
          if (intentRejectWords.some(w => haystack.includes(w))) return true;
          return false;
        };

        const filteredOut = allRawClips.filter(looksLikeCompilationOrRanking);
        const keptClips = allRawClips.filter(c => !looksLikeCompilationOrRanking(c));
        if (filteredOut.length > 0) {
          explainability_recorder.execute(
            "SourceHunterAgent: Policy filter removed " + filteredOut.length + " compilation/ranking-style results",
            { removed_titles: filteredOut.slice(0, 10).map(c => c.title) }, agentLogger, agentMetrics
          );
          agentLogger.info(`Policy filter removed ${filteredOut.length} compilation/ranking-style results.`, { removed_count: filteredOut.length });
        }
        const finalClips = keptClips.length > 0 ? keptClips : allRawClips;

        const confidence = capability_registry.ConfidenceCalculationCapability.execute({
          search_coverage_success: finalClips.length > 0 ? 1 : 0
        }, null, agentLogger, agentMetrics);

        const newDiscoveryQueueStatus = {
          pending: pendingSearches,
          completed: discoveryMissions.length - pendingSearches,
          failed: 0,
          results: finalClips.map(clip => ({ id: clip.id, url: clip.url }))
        };
        agentStatus = 'completed';
        return {
          success: true, result: { raw_clips: finalClips },
          metadata: { agent_id: AGENT_REGISTRY.SourceHunterAgent.id, version: AGENT_REGISTRY.SourceHunterAgent.version, confidence_score: confidence.score, explainability_trace_id: 'trace_sh_1' },
          new_state_data: {
            raw_clips_collected: finalClips,
            discovery_queue_status: newDiscoveryQueueStatus
          },
          events_to_publish: [
            { type: "DISCOVERY_PHASE_COMPLETED", payload: { total_clips: allRawClips.length } }
          ]
        };
      } catch (e) {
        agentLogger.error("SourceHunterAgent failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.SourceHunterAgent.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.SourceHunterAgent.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.SourceHunterAgent.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },

  RankingAgent: {
    id: "RankingAgent",
    version: "1.0.0",
    description: "Uses the LLM to select, rank, and explain a #6-#1 countdown from the raw clips collected, and generates real (non-placeholder) actionable insights.",
    input_schema: { type: "object", properties: { raw_clips_collected: { type: "array" }, editorial_intent: { type: "object" } } },
    output_schema: { type: "object" },
    dependencies: ["SourceHunterAgent"],
    required_capabilities: ["LLMServiceCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Medium", estimated_latency_ms: 12000, max_retries: 2,
    read_state_keys: ["raw_clips_collected", "editorial_intent", "input_contract"],
    write_state_keys: ["ai_insights"],
    run: async (runtimeState, context) => {
      const { capability_registry, env, explainability_recorder, logger, metricsCollector } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const clips = runtimeState.raw_clips_collected || [];
      const editorialIntent = runtimeState.editorial_intent || {};
      const topic = editorialIntent.topic || runtimeState.input_contract?.topic || "";

      const agentLogger = logger.child({ agentId: AGENT_REGISTRY.RankingAgent.id });
      const agentMetrics = metricsCollector;
      const startTime = Date.now();
      let agentStatus = 'failed';
      let errorType = 'UnknownError';

      try {
        agentMetrics.increment('agent_execution_total', 1, { agentId: AGENT_REGISTRY.RankingAgent.id, component: 'AgentRegistry' });
        if (clips.length === 0) {
          const emptyInsights = {
            overall_opportunity_reasoning: "No source clips were collected for this topic, so no ranking could be generated. Try a broader topic, a longer date window, or check that platform API keys/tokens are configured.",
            trend_status: "Unknown",
            hook_suggestions: [], hashtag_strategy: [], key_search_phrases_for_discoverability: [],
            seo_elements_for_upload: { title_insights: "", description_hook: "", tags_to_prioritize: [] },
            ranked_clip_opportunities: []
          };
          explainability_recorder.execute("RankingAgent: No clips to rank", {}, agentLogger, agentMetrics);
          agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.RankingAgent.id, status: 'skipped', reason: 'no_clips', component: 'AgentRegistry' });
          agentMetrics.increment('agent_execution_skipped_total', 1, { agentId: AGENT_REGISTRY.RankingAgent.id, reason: 'no_clips', component: 'AgentRegistry' });
          return {
            success: true, result: { aiInsights: emptyInsights },
            metadata: { agent_id: AGENT_REGISTRY.RankingAgent.id, version: AGENT_REGISTRY.RankingAgent.version, confidence_score: 0, explainability_trace_id: 'trace_ra_1' },
            new_state_data: { ai_insights: emptyInsights },
            events_to_publish: [{ type: "RANKING_COMPLETED", payload: { count: 0 } }]
          };
        }

        const candidates = clips.slice(0, 40).map((c, i) => ({
          index: i, url: c.url, platform: c.platform, title: c.title,
          description: (c.description_snippet || "").slice(0, 200),
          views: c.views_approx || 0, likes: c.likes_approx || 0, comments: c.comments || 0
        }));

        const dnaProfile = runtimeState.editorial_dna_profile;

        const prompt =
          "You are curating a ranked #6-#1 countdown video for the topic \"" + topic + "\".\n" +
          "Creative brief: " + (editorialIntent.creative_brief_summary || "") + "\n" +
          "Target emotions: " + JSON.stringify(editorialIntent.target_emotions || []) + "\n" +
          "Acceptable event types: " + JSON.stringify(editorialIntent.acceptable_event_types || []) + "\n" +
          (dnaProfile
            ? "Editorial DNA profile (from " + dnaProfile.based_on_real_video_count + " real reference videos): " + JSON.stringify(dnaProfile) + " — every selection MUST be justified against this DNA, not generic virality.\n"
            : "No reference channel DNA is available for this run — judge against the creative brief and target emotions only.\n") +
          "Here are candidate source clips actually found (index, url, platform, title, description, views, likes, comments):\n" +
          JSON.stringify(candidates) + "\n\n" +
          "Select up to 6 of the BEST, most distinct real moments from this list (avoid near-duplicates). " +
          "Rank as a countdown: rank 1 = single best/most impactful (final reveal), rank 6 = weakest of your chosen set (opens the countdown). " +
          "You MUST reuse the exact 'url' from the candidate list above for each pick — never invent a URL. " +
          "IMPORTANT — moment_strength bar: viral countdown channels (like PolarRanks/Oogway Ranks) only use moments with a genuinely SHOCKING, jaw-dropping, or 'wait, WHAT?' quality — not mundane, mild, or merely-mildly-amusing fails. When scoring moment_strength, actively PENALIZE clips that are just an ordinary fail with nothing exceptional about the reaction, timing, or outcome. A high moment_strength score requires the clip to make someone stop scrolling.\n" +
          "For EVERY selected clip you MUST provide ALL of these non-empty, specific (not generic) reasoning fields:\n" +
          "- moment_idea: the SPECIFIC visual moment as a punchy countdown phrase (not the raw title)\n" +
          "- style_dna_match_reason: specifically why this fits the Editorial DNA / creative brief (not a generic 'it's funny')\n" +
          "- countdown_position_reason: why THIS rank specifically, not a different one\n" +
          "- viral_mechanism: the specific mechanic that makes it shareable (e.g. 'expectation subversion', 'relatable failure')\n" +
          "- emotion_trigger: the specific emotional trigger for the viewer\n" +
          "- source_confidence: why this looks like an original/traceable source (not just 'it has views')\n" +
          "- suggested_caption_overlay: a punchy, HIGH-ENERGY caption with emoji the creator could overlay on this clip when editing the final countdown video (e.g. '\uD83D\uDE31\uD83D\uDC80 HE DIDN'T SEE THAT COMING...') — this is packaging guidance for the finished edit, not a claim about the raw source clip itself\n" +
          "- score_breakdown: object with style_dna_match, moment_strength, viewer_emotion, original_source, engagement — each 0-100, justified by the fields above\n" +
          "If you cannot honestly justify all of these for a candidate, DO NOT include it — fewer than 6 well-justified picks is better than 6 weak ones.\n" +
          "Also produce overall_opportunity_reasoning (2-3 sentences), trend_status (Growing/Stable/Declining/Emerging), " +
          "hook_suggestions (3-5 short lines), hashtag_strategy (5-8 tags), and key_search_phrases_for_discoverability (3-5 phrases).\n" +
          "Return ONLY JSON matching the schema.";

        const scoreProps = {
          style_dna_match: { type: "integer" }, moment_strength: { type: "integer" },
          viewer_emotion: { type: "integer" }, original_source: { type: "integer" }, engagement: { type: "integer" }
        };

        const schema = {
          type: "object",
          properties: {
            overall_opportunity_reasoning: { type: "string" }, trend_status: { type: "string" },
            hook_suggestions: { type: "array", items: { type: "string" } }, hashtag_strategy: { type: "array", items: { type: "string" } },
            key_search_phrases_for_discoverability: { type: "array", items: { type: "string" } },
            ranked_clip_opportunities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "integer" }, moment_idea: { type: "string" }, suggested_source_platform: { type: "string" },
                  url_to_potential_original_clip: { type: "string" }, style_dna_match_reason: { type: "string" },
                  countdown_position_reason: { type: "string" }, viral_mechanism: { type: "string" },
                  emotion_trigger: { type: "string" }, source_confidence: { type: "string" },
                  suggested_caption_overlay: { type: "string" }, score_breakdown: { type: "object", properties: scoreProps }
                },
                required: ["rank", "moment_idea", "suggested_source_platform", "url_to_potential_original_clip", "style_dna_match_reason", "countdown_position_reason", "viral_mechanism", "emotion_trigger", "source_confidence", "score_breakdown"]
              }
            }
          },
          required: ["overall_opportunity_reasoning", "trend_status", "ranked_clip_opportunities"]
        };

        const { data, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env, agentLogger, agentMetrics);
        if (error) {
          agentLogger.warn("LLM for RankingAgent failed:", { error: error });
          throw new LLMError("LLM for RankingAgent failed: " + error, 'RANKING_LLM_FAILED', { originalError: error });
        }

        const normalizeUrl = (u) => (u || "").trim().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "").split(/[?#]/)[0].toLowerCase();
        const extractYouTubeVideoId = (u) => {
          const m = /(?:[?&]v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{6,})/.exec(u || "");
          return m ? m[1] : null;
        };
        const urlToClip = new Map();
        const videoIdToClip = new Map();
        clips.forEach(c => {
          urlToClip.set(normalizeUrl(c.url), c);
          const vid = extractYouTubeVideoId(c.url);
          if (vid) videoIdToClip.set(vid, c);
        });

        const REQUIRED_REASONING_FIELDS = ["style_dna_match_reason", "countdown_position_reason", "viral_mechanism", "emotion_trigger", "source_confidence"];
        const rawRanked = coerceToArray(data?.ranked_clip_opportunities);
        const rejectedForMissingReasoning = [];
        const finalRanked = rawRanked
          .map(r => {
            if (!r) return null;
            const givenUrl = r.url_to_potential_original_clip;
            const norm = normalizeUrl(givenUrl);
            const vid = extractYouTubeVideoId(givenUrl);
            const matchedClip = urlToClip.get(norm) || (vid && videoIdToClip.get(vid));
            if (!matchedClip) {
                agentLogger.warn(`RankingAgent: LLM suggested URL not found in raw clips: ${givenUrl}`);
                return null;
            }

            const missingFields = REQUIRED_REASONING_FIELDS.filter(f => !r[f] || typeof r[f] !== 'string' || !r[f].trim());
            if (missingFields.length > 0) {
              rejectedForMissingReasoning.push({ title: matchedClip.title, missingFields });
              return null;
            }

            const sb = r.score_breakdown || {};
            const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
            const scoreBreakdown = {
              style_dna_match: clamp(sb.style_dna_match), moment_strength: clamp(sb.moment_strength),
              viewer_emotion: clamp(sb.viewer_emotion), original_source: clamp(sb.original_source), engagement: clamp(sb.engagement)
            };
            const finalScore = Math.round(
              scoreBreakdown.style_dna_match * 0.30 + scoreBreakdown.moment_strength * 0.25 +
              scoreBreakdown.viewer_emotion * 0.20 + scoreBreakdown.original_source * 0.15 +
              scoreBreakdown.engagement * 0.10
            );

            const searchTerms = (matchedClip.tags && matchedClip.tags.length > 0) ? matchedClip.tags.slice(0, 5) : [topic];

            return {
              rank: Number(r.rank) || 0, moment_idea: r.moment_idea || matchedClip.title,
              suggested_source_platform: matchedClip.platform, url_to_potential_original_clip: matchedClip.url,
              style_dna_match_reason: r.style_dna_match_reason, countdown_position_reason: r.countdown_position_reason,
              viral_mechanism: r.viral_mechanism, emotion_trigger: r.emotion_trigger,
              source_confidence: r.source_confidence, suggested_caption_overlay: r.suggested_caption_overlay || "",
              score_breakdown: scoreBreakdown, final_score: finalScore, confidence_score: finalScore,
              human_editor_search_terms: searchTerms
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.rank - a.rank)
          .slice(0, 6);

        if (rejectedForMissingReasoning.length > 0) {
          explainability_recorder.execute("RankingAgent: rejected clips missing required reasoning (contract §3)", { rejected: rejectedForMissingReasoning }, agentLogger, agentMetrics);
          agentLogger.warn(`RankingAgent: ${rejectedForMissingReasoning.length} clips rejected for missing required reasoning.`);
        }
        if (finalRanked.length === 0) {
          explainability_recorder.execute("RankingAgent: 0 clips passed the editorial reasoning bar this run — honestly reporting empty, no engagement fallback per contract", { candidate_count: clips.length }, agentLogger, agentMetrics);
          agentLogger.warn("RankingAgent: 0 clips passed the editorial reasoning bar this run.");
        }

        const finalInsights = {
          overall_opportunity_reasoning: data?.overall_opportunity_reasoning || (finalRanked.length === 0 ? "Ranking could not be generated with the required editorial reasoning this run. Try again, broaden the topic, or provide reference channels for a stronger Editorial DNA match." : ""),
          trend_status: data?.trend_status || "Unknown",
          hook_suggestions: coerceToArray(data?.hook_suggestions), hashtag_strategy: coerceToArray(data?.hashtag_strategy), key_search_phrases_for_discoverability: coerceToArray(data?.key_search_phrases_for_discoverability),
          seo_elements_for_upload: { title_insights: "", description_hook: "", tags_to_prioritize: [] },
          ranked_clip_opportunities: finalRanked
        };
        agentStatus = 'completed';
        explainability_recorder.execute("RankingAgent: Ranked clips", { count: finalRanked.length, model, provider, confidence }, agentLogger, agentMetrics);

        return {
          success: true, result: { aiInsights: finalInsights },
          metadata: { agent_id: AGENT_REGISTRY.RankingAgent.id, version: AGENT_REGISTRY.RankingAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_ra_1' },
          new_state_data: { ai_insights: finalInsights },
          events_to_publish: [{ type: "RANKING_COMPLETED", payload: { count: finalRanked.length } }]
        };
      } catch (e) {
        agentLogger.error("RankingAgent failed:", { error: e.message, stack: e.stack });
        errorType = e.name || 'AgentError';
        throw e;
      } finally {
        agentMetrics.observe('agent_execution_latency_ms', Date.now() - startTime, { agentId: AGENT_REGISTRY.RankingAgent.id, status: agentStatus, errorType: errorType, component: 'AgentRegistry' });
        if (agentStatus === 'completed') {
            agentMetrics.increment('agent_execution_success_total', 1, { agentId: AGENT_REGISTRY.RankingAgent.id, component: 'AgentRegistry' });
        } else {
            agentMetrics.increment('agent_execution_failure_total', 1, { agentId: AGENT_REGISTRY.RankingAgent.id, errorType: errorType, component: 'AgentRegistry' });
        }
      }
    }
  },
};

// -----------------------------------------------------------------------------
// ORCHESTRATOR LAYER
// -----------------------------------------------------------------------------
async function generateViralOpportunity(env, modelPreference, dnaProfile, logger, metricsCollector) {
  const trendProfiles = KNOWLEDGE_BASE_PLUGINS.core.trend_profiles;
  const storyPatterns = KNOWLEDGE_BASE_PLUGINS.core.story_patterns;

  const llmService = capabilityRegistry.LLMServiceCapability;
  const explainabilityRecorder = capabilityRegistry.ExplainabilityRecordingCapability;

  const startTime = Date.now();
  let status = 'failed';
  let errorType = 'UnknownError';

  try {
    metricsCollector.increment('api_generate_opportunity_total', 1, { component: 'Orchestrator' });

    const prompt =
      "You are a viral short-form video editor brainstorming a new \"Ranking #6-#1 countdown\" video idea. " +
      "Trend context: " + JSON.stringify(trendProfiles) + ". Countdown story structure: " + JSON.stringify(storyPatterns) + ".\n" +
      (dnaProfile
        ? "IMPORTANT: base this idea on the user's own Editorial DNA profile (extracted from " + dnaProfile.based_on_real_video_count + " real videos on their reference channel(s)): " + JSON.stringify(dnaProfile) + ". The idea must fit this DNA, not just be generically viral.\n"
        : "No reference channel DNA is available yet — brainstorm a generally strong, specific countdown idea.\n") +
      "Generate ONE single viral opportunity idea. Output JSON with:\n" +
      "- title: a specific 'Ranking [specific thing]' style topic (NOT generic, e.g. 'Ranking Don't Trust Your Eyes Moments' not 'Ranking Funny Videos')\n" +
      "- format: one short phrase describing the visual/structural format (e.g. 'Visual illusion + unexpected reveal')\n" +
      "- viewer_emotion_arc: the emotional sequence a viewer goes through, as 'A -> B -> C' (e.g. 'Confusion -> surprise -> laugh')\n" +
      "- search_strategy: array of 4-6 SPECIFIC search phrases to find source clips for this idea (not just the title restated)\n" +
      "- reject: array of 4-6 content types to explicitly avoid surfacing for this idea (e.g. 'tutorial', 'compilation', 'news')\n" +
      "Return ONLY JSON matching this structure.";

    const schema = {
      type: "object",
      properties: {
        title: { type: "string" }, format: { type: "string" }, viewer_emotion_arc: { type: "string" },
        search_strategy: { type: "array", items: { type: "string" } }, reject: { type: "array", items: { type: "string" } }
      },
      required: ["title", "format", "viewer_emotion_arc", "search_strategy", "reject"]
    };

    const { data, confidence, error } = await llmService.execute(prompt, schema, modelPreference, env, logger.child({ component: 'generateViralOpportunity' }), metricsCollector);
    if (error) {
        logger.warn("Viral Opportunity generation failed:", { error: error });
        throw new LLMError("Viral Opportunity generation failed: " + error, 'VIRAL_OPP_LLM_FAILED', { originalError: error });
    }
    status = 'success';
    return {
      title: data?.title || "", format: data?.format || "", viewer_emotion_arc: data?.viewer_emotion_arc || "",
      search_strategy: coerceToArray(data?.search_strategy), reject: coerceToArray(data?.reject), confidence
    };
  } catch (e) {
    logger.error("generateViralOpportunity failed:", { error: e.message, stack: e.stack });
    errorType = e.name || 'OrchestrationError';
    throw e;
  } finally {
    metricsCollector.observe('api_generate_opportunity_latency_ms', Date.now() - startTime, { status: status, errorType: errorType, component: 'Orchestrator' });
    if (status === 'success') {
        metricsCollector.increment('api_generate_opportunity_success_total', 1, { component: 'Orchestrator' });
    } else {
        metricsCollector.increment('api_generate_opportunity_failure_total', 1, { errorType: errorType, component: 'Orchestrator' });
    }
  }
}

async function orchestrate(workflowId, inputContract, env, logger, metricsCollector) {
  const stateAccess = capabilityRegistry.StateAccessCapability;
  let runtimeState = new RuntimeState(workflowId, inputContract);
  workflowStates[workflowId] = runtimeState;

  const agentContext = createAgentContext(workflowId, env, logger, metricsCollector);
  
  runtimeState = await stateAccess.execute(workflowId, "update", { global_constraints: inputContract.constraints || {} }, logger, metricsCollector);

  const executionLog = [];

  const executeAgent = async (agentId) => {
    const agent = AGENT_REGISTRY[agentId];
    if (!agent) {
        throw new ConfigurationError(`Agent '${agentId}' not found in registry.`, 'AGENT_NOT_FOUND', { agentId });
    }

    const startTime = Date.now();
    let agentOutput;
    try {
      agentOutput = await agent.run(workflowStates[workflowId], agentContext);
      
      runtimeState = await stateAccess.execute(workflowId, "update", {
        ...agentOutput.new_state_data,
        agent_execution_log: [...runtimeState.agent_execution_log, {
          agent_id: agentId,
          status: "COMPLETED",
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          metadata: agentOutput.metadata
        }]
      }, logger, metricsCollector);

      (agentOutput.events_to_publish || []).forEach(event => {
        agentContext.event_bus.execute(event.type, { workflowId, ...event.payload }, logger, metricsCollector);
      });

    } catch (e) {
      logger.error("Orchestration: Agent '" + agentId + "' failed:", { error: e.message, stack: e.stack, agentId });
      runtimeState = await stateAccess.execute(workflowId, "update", {
        status: "FAILED",
        agent_execution_log: [...runtimeState.agent_execution_log, {
          agent_id: agentId,
          status: "FAILED",
          error: e.message,
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString()
        }]
      }, logger, metricsCollector);
      throw e;
    }
    executionLog.push({ agent: agentId, status: "completed", duration: Date.now() - startTime });
    return agentOutput;
  };

  try {
    metricsCollector.increment('orchestration_workflow_total', 1, { workflowId: workflowId, component: 'Orchestrator' });

    await Promise.all([
      executeAgent("EditorialDNAExtractionAgent"),
      executeAgent("OpportunityGenerator")
    ]);
    await executeAgent("EditorialIntentAgent");
    await executeAgent("MomentOntologyAgent");
    await executeAgent("DiscoveryStrategyPlannerAgent");
    await executeAgent("SourceHunterAgent");
    await executeAgent("RankingAgent");

    runtimeState = await stateAccess.execute(workflowId, "update", { status: "COMPLETED" }, logger, metricsCollector);
    agentContext.event_bus.execute("WORKFLOW_COMPLETED", { workflowId, finalStatus: "COMPLETED" }, logger, metricsCollector);
    
    metricsCollector.increment('orchestration_workflow_success_total', 1, { workflowId: workflowId, component: 'Orchestrator' });
    const finalResult = {
      pipeline: { status: runtimeState.status, steps: runtimeState.agent_execution_log },
      editorial_objective: {
        topic: runtimeState.editorial_intent?.topic || inputContract.topic, creative_brief_summary: runtimeState.editorial_intent?.creative_brief_summary || inputContract.creativeBrief,
        editorial_dna: (() => {
          const dcc = runtimeState.editorial_intent?.desired_clip_characteristics || {};
          const clipLength = (dcc.min_duration_sec != null && dcc.max_duration_sec != null)
            ? `${dcc.min_duration_sec}-${dcc.max_duration_sec}s`
            : 'N/A';
          return {
            clip_length: clipLength, hook_style: dcc.content_tone || 'N/A',
            emotion_focus: (runtimeState.editorial_intent?.target_emotions || []).join(', ') || 'N/A',
            source_preference: 'Original Clips'
          };
        })(),
        research_constraints_applied: (() => {
          const c = runtimeState.global_constraints || {};
          const applied = [];
          if (c.max_age_months) applied.push(`Published within the last ${c.max_age_months} month(s)`);
          if (c.clip_duration_range && c.clip_duration_range !== 'any') applied.push(`Clip duration: ${c.clip_duration_range}`);
          if (c.video_orientation && c.video_orientation !== 'any') applied.push(`Orientation: ${c.video_orientation}`);
          if (c.min_engagement_level && c.min_engagement_level !== 'any') applied.push(`Minimum engagement level: ${c.min_engagement_level}`);
          if (c.content_tone && c.content_tone !== 'any') applied.push(`Content tone: ${c.content_tone}`);
          if (c.target_language && c.target_language !== 'any') applied.push(`Language: ${c.target_language}`);
          if (Array.isArray(c.user_defined_constraints)) applied.push(...c.user_defined_constraints);
          return applied;
        })()
      },
      raw_evidence_found: (() => {
        const allClips = runtimeState.raw_clips_collected || [];
        const byPlatform = (name) => allClips.filter(c => (c.platform || "").trim().toLowerCase() === name);
        const youtube_clips = byPlatform("youtube"); const tiktok_clips = byPlatform("tiktok");
        const reddit_posts = byPlatform("reddit"); const instagram_reels = byPlatform("instagram");
        const facebook_posts = byPlatform("facebook"); const telegram_clips = byPlatform("telegram");
        return {
          youtube_clips, tiktok_clips, reddit_posts, instagram_reels, facebook_posts, telegram_clips,
          total_youtube: youtube_clips.length, total_tiktok: tiktok_clips.length, total_reddit: reddit_posts.length,
          past_clips_from_memory: 0, platform_search_links: {}
        };
      })(),
      ai_actionable_insights: runtimeState.ai_insights || {
        overall_opportunity_reasoning: "Ranking could not be generated for this run.",
        trend_status: "Unknown", hook_suggestions: [], hashtag_strategy: [], key_search_phrases_for_discoverability: [],
        seo_elements_for_upload: { title_insights: "", description_hook: "", tags_to_prioritize: [] },
        ranked_clip_opportunities: []
      },
      ref_channel_analysis: runtimeState.editorial_dna_profile,
      overall_confidence_score: capabilityRegistry.ConfidenceCalculationCapability.execute(null, null, logger, metricsCollector).score,
      explainability_trace_id: 'workflow_trace_1'
    };

    if (env.DB) {
      capabilityRegistry.PersistenceCapability.execute("save", "final_report", {
        workflowId, report: finalResult, timestamp: new Date().toISOString()
      }, logger, metricsCollector, env);
    }
    return finalResult;
  } catch (e) {
    logger.error("Orchestration workflow failed:", { error: e.message, stack: e.stack });
    metricsCollector.increment('orchestration_workflow_failure_total', 1, { workflowId: workflowId, errorType: e.name || 'UnknownError', component: 'Orchestrator' });
    return {
      pipeline: { status: "FAILED", steps: workflowStates[workflowId]?.agent_execution_log || [] },
      editorial_objective: {
        topic: inputContract.topic, creative_brief_summary: inputContract.creativeBrief,
        editorial_dna: {}, research_constraints_applied: inputContract.constraints || []
      },
      raw_evidence_found: null, ai_actionable_insights: null, ref_channel_analysis: null,
      error: "Workflow orchestration failed: " + e.message, overall_confidence_score: 0,
      explainability_trace_id: 'workflow_trace_fail_final'
    };
  } finally {
  }
}

// -----------------------------------------------------------------------------
// WORKER FETCH HANDLER (API routes only)
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const requestLogger = workerLogger.child({ requestId: Math.random().toString(36).substring(2, 9), traceId: Math.random().toString(36).substring(2, 9) });
    const requestMetrics = workerMetricsCollector;

    requestLogger.info(`Incoming request: ${request.method} ${url.pathname}`);
    requestMetrics.increment('http_requests_total', 1, { method: request.method, pathname: url.pathname, component: 'WorkerFetchHandler' });
    const startTime = Date.now();
    let handlerStatus = 'failed';
    let errorType = 'UnknownError';
    let httpStatusCode = 500; // Default error status

    if (request.method === "OPTIONS") {
        handlerStatus = 'success';
        httpStatusCode = 200;
        requestMetrics.observe('http_request_latency_ms', Date.now() - startTime, { method: request.method, pathname: url.pathname, status: handlerStatus, component: 'WorkerFetchHandler' });
        requestMetrics.increment('http_requests_success_total', 1, { method: request.method, pathname: url.pathname, component: 'WorkerFetchHandler' });
        return new Response(null, { headers: CORS });
    }

    try {
        if (url.pathname === "/api/status" && request.method === "GET") {
            handlerStatus = 'success';
            httpStatusCode = 200;
            return json({
                status: "ok",
                providers_configured: {
                    cloudflare: Boolean(env.AI), openrouter: Boolean(env.OPENROUTER_API_KEY),
                    google: Boolean(env.GEMINI_API_KEY), github: Boolean(env.GITHUB_MODELS_TOKEN),
                    huggingface: Boolean(env.HF_TOKEN), cloudflare_account_id: Boolean(env.CLOUDFLARE_ACCOUNT_ID)
                },
                bindings: {
                    ai: Boolean(env.AI), youtube: Boolean(env.YOUTUBE_API_KEY), apify: Boolean(env.APIFY_API_TOKEN),
                    d1: Boolean(env.DB), r2: Boolean(env.MY_BUCKET), ai_search: Boolean(env.AI_SEARCH),
                    media: Boolean(env.MEDIA), images: Boolean(env.IMAGES), stream: Boolean(env.STREAM),
                },
                worker_metrics_snapshot: requestMetrics.getMetricsSnapshot()
            });
        }

        if (url.pathname === "/api/generate-opportunity" && request.method === "POST") {
            let body;
            try { body = await request.json(); } catch (e) {
                requestLogger.warn("Invalid JSON body for generate-opportunity.", { error: e.message });
                errorType = 'InvalidJsonBody';
                httpStatusCode = 400;
                return json({ error: "Invalid JSON body" }, httpStatusCode);
            }
            const { provider, model, dnaProfile } = body || {};
            try {
                const opportunity = await generateViralOpportunity(env, { provider, [provider]: model }, dnaProfile || null, requestLogger, requestMetrics);
                handlerStatus = 'success';
                httpStatusCode = 200;
                return json(opportunity);
            } catch (e) {
                requestLogger.error("generate-opportunity failed:", { error: e.message, stack: e.stack });
                errorType = e.name || 'OpportunityGenerationError';
                httpStatusCode = (e instanceof ConfigurationError || e instanceof LLMError) ? 500 : 500; // Standardize HTTP status
                return json({ error: e.message }, httpStatusCode);
            }
        }

        if (url.pathname === "/api/complete" && request.method === "POST") {
            let body;
            try { body = await request.json(); } catch (e) {
                requestLogger.warn("Invalid JSON body for /api/complete.", { error: e.message });
                errorType = 'InvalidJsonBody';
                httpStatusCode = 400;
                return json({ error: "Invalid JSON body" }, httpStatusCode);
            }
            const { prompt, provider, model, outputSchema } = body;
            if (!prompt || !provider || !model) {
                requestLogger.warn("Missing required fields for /api/complete.", { prompt: Boolean(prompt), provider: Boolean(provider), model: Boolean(model) });
                errorType = 'MissingRequiredFields';
                httpStatusCode = 400;
                return json({ error: "Missing required fields: prompt, provider, or model" }, httpStatusCode);
            }
            try {
                const llmService = capabilityRegistry.LLMServiceCapability;
                const { data, provider: usedProvider, model: usedModel } = await llmService.execute(
                  prompt, outputSchema, { provider, [provider]: model }, env, requestLogger, requestMetrics
                );
                handlerStatus = 'success';
                httpStatusCode = 200;
                return json({ text: JSON.stringify(data), provider_used: usedProvider, model_used: usedModel });
            } catch (e) {
                requestLogger.error("/api/complete failed:", { error: e.message, stack: e.stack });
                errorType = e.name || 'LLMCompleteError';
                httpStatusCode = (e instanceof ConfigurationError || e instanceof LLMError) ? 500 : 500;
                return json({ error: e.message }, httpStatusCode);
            }
        }

        if (url.pathname === "/api/generate-insights" && request.method === "POST") {
            let body;
            try { body = await request.json(); } catch (e) {
                requestLogger.warn("Invalid JSON body for generate-insights.", { error: e.message });
                errorType = 'InvalidJsonBody';
                httpStatusCode = 400;
                return json({ error: "Invalid JSON body" }, httpStatusCode);
            }
            const { topic, creativeBrief, referenceChannels, provider, model, constraints } = body;
            if (!topic) {
                requestLogger.warn("Missing required field 'topic' for generate-insights.");
                errorType = 'MissingRequiredFields';
                httpStatusCode = 400;
                return json({ error: "Missing required field: topic" }, httpStatusCode);
            }

            const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
            const inputContract = { topic, creativeBrief, referenceChannels, constraints, model_preference: { provider, [provider]: model } };

            try {
                const result = await orchestrate(workflowId, inputContract, env, requestLogger, requestMetrics);
                handlerStatus = 'success';
                httpStatusCode = 200;
                return json(result);
            } catch (e) {
                requestLogger.error("Workflow orchestration failed:", { error: e.message, stack: e.stack });
                errorType = e.name || 'OrchestrationWorkflowError';
                // Issue 6: Change API Error Status Codes
                httpStatusCode = (e instanceof ConfigurationError || e instanceof LLMError || e instanceof EmbeddingError || e instanceof MomentNotFoundError) ? 500 : 500;
                return json({
                    pipeline: { status: "FAILED", steps: workflowStates[workflowId]?.agent_execution_log || [] },
                    editorial_objective: {
                        topic: inputContract.topic, creative_brief_summary: inputContract.creativeBrief,
                        editorial_dna: {}, research_constraints_applied: inputContract.constraints || []
                    },
                    raw_evidence_found: null, ai_actionable_insights: null, ref_channel_analysis: null,
                    error: "Workflow orchestration failed: " + e.message, overall_confidence_score: 0,
                    explainability_trace_id: 'workflow_trace_fail_final'
                }, httpStatusCode);
            }
        }

        if (url.pathname === "/api/history" && request.method === "GET") {
            if (!env.DB) {
                requestLogger.warn("D1 binding not configured for history fetch.");
                errorType = 'DB_BindingMissing';
                httpStatusCode = 500;
                return json({ history: [] }, httpStatusCode);
            }
            try {
                const result = await env.DB.prepare("SELECT topic, created_at FROM research_history ORDER BY created_at DESC LIMIT 10").all();
                handlerStatus = 'success';
                httpStatusCode = 200;
                return json({ history: result.results || [] });
            } catch (e) {
                requestLogger.error("D1 history fetch failed:", { error: e.message, stack: e.stack });
                errorType = e.name || 'DBFetchError';
                httpStatusCode = 500;
                return json({ history: [] }, httpStatusCode);
            }
        }

        requestLogger.warn("API route not found.", { pathname: url.pathname, method: request.method });
        errorType = 'NotFound';
        httpStatusCode = 404;
        return json({ error: "Not found" }, httpStatusCode);
    } catch (outerError) {
        requestLogger.critical("Unhandled error in Worker fetch handler:", { error: outerError.message, stack: outerError.stack });
        errorType = outerError.name || 'UnhandledWorkerError';
        httpStatusCode = 500;
        return json({ error: `An unhandled server error occurred: ${outerError.message}` }, httpStatusCode);
    } finally {
        requestMetrics.observe('http_request_latency_ms', Date.now() - startTime, { method: request.method, pathname: url.pathname, status: handlerStatus, errorType: errorType, httpStatus: httpStatusCode, component: 'WorkerFetchHandler' });
        if (handlerStatus === 'success') {
            requestMetrics.increment('http_requests_success_total', 1, { method: request.method, pathname: url.pathname, httpStatus: httpStatusCode, component: 'WorkerFetchHandler' });
        } else {
            requestMetrics.increment('http_requests_failure_total', 1, { method: request.method, pathname: url.pathname, errorType: errorType, httpStatus: httpStatusCode, component: 'WorkerFetchHandler' });
        }
    }
  },
};
