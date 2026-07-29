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

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function cleanJson(text) {
  let t = (typeof text === 'string' ? text : JSON.stringify(text)).trim();
  t = t.replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  // BUGFIX: previously this only ever looked for { }, which silently mangled
  // any response whose JSON root was an array (e.g. "[{...},{...}]") by
  // stripping the outer brackets and leaving invalid, comma-separated JSON.
  // Now we detect whichever root (object or array) actually starts first.
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

// BUGFIX: some providers' JSON-mode APIs (response_format: json_object) only
// allow a top-level JSON *object*, so even when a prompt asks for "a JSON
// array", the model may wrap it, e.g. { "missions": [...] } or { "result": [...] }.
// This coerces that shape back into a plain array so callers can safely use
// array methods (.sort, .map, .flatMap, etc.) without crashing.
function coerceToArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const arrayValues = Object.values(data).filter(v => Array.isArray(v));
    if (arrayValues.length > 0) {
      // Prefer the longest array in case of multiple array-valued keys
      return arrayValues.reduce((a, b) => (b.length > a.length ? b : a));
    }
  }
  return [];
}

// BUGFIX: the 'fails' knowledge base plugin (gym fails, pranks, instant karma, etc.)
// was unconditionally injected into every single research run's prompts, regardless
// of the actual topic. That's why unrelated "gym prank"/"fail" clips showed up mixed
// into results for completely unrelated topics like "don't trust your eyes illusions"
// — the LLM was explicitly told to "integrate keywords from the fails plugin if
// relevant", and it often did even when the topic had nothing to do with fails.
// This checks whether the topic/creative brief actually relates to a plugin's theme
// before including its keywords, so niche plugins stop polluting unrelated research.
const PLUGIN_TRIGGER_WORDS = {
  fails: ["fail", "fails", "prank", "karma", "clumsy", "embarrass", "blooper", "epic fail", "instant karma"]
};
function isPluginRelevant(pluginName, ...texts) {
  const triggers = PLUGIN_TRIGGER_WORDS[pluginName];
  if (!triggers) return true; // unknown plugin: no gating, include as before
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  return triggers.some(word => haystack.includes(word));
}

// -----------------------------------------------------------------------------
// YOUTUBE CHANNEL HELPERS — used by EditorialDNAExtractionAgent
// FEATURE: previously "Style DNA Sources" (reference channel links) were only ever
// passed to the LLM as a literal text string ("reference channels: youtube.com/@x") —
// the AI never actually saw what those channels post. These helpers fetch the REAL,
// current videos from a channel via the YouTube Data API so the LLM can infer an
// actual editorial pattern (clip length, format, emotion, editing style) from real
// evidence instead of guessing from a URL.
// -----------------------------------------------------------------------------
function parseYouTubeChannelRef(rawUrl) {
  let u = (rawUrl || "").trim();
  u = u.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/^m\./i, "").replace(/^youtube\.com\//i, "");
  u = u.split(/[?#]/)[0]; // drop query/hash
  u = u.replace(/\/+$/, ""); // drop trailing slash
  if (u.startsWith("@")) return { type: "handle", value: u.split("/")[0] };
  if (u.startsWith("channel/")) return { type: "id", value: u.slice("channel/".length).split("/")[0] };
  if (u.startsWith("c/")) return { type: "handle", value: "@" + u.slice("c/".length).split("/")[0] };
  if (u.startsWith("user/")) return { type: "user", value: u.slice("user/".length).split("/")[0] };
  if (rawUrl.trim().startsWith("@")) return { type: "handle", value: rawUrl.trim().split("/")[0] };
  // Bare name with no recognizable prefix: try it as a handle.
  const bare = u.split("/")[0];
  return bare ? { type: "handle", value: bare.startsWith("@") ? bare : "@" + bare } : null;
}

async function resolveYouTubeChannelId(ref, apiKey) {
  if (!ref) return null;
  if (ref.type === "id") return ref.value;
  try {
    const param = ref.type === "user" ? "forUsername" : "forHandle";
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=id&${param}=${encodeURIComponent(ref.value)}&key=${apiKey}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.items && data.items[0]) return data.items[0].id;
    }
    // Fallback: search by name (handles legacy custom URLs / misc formats).
    const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(ref.value)}&key=${apiKey}`);
    if (searchResp.ok) {
      const searchData = await searchResp.json();
      const item = searchData.items && searchData.items[0];
      if (item) return item.snippet?.channelId || item.id?.channelId || null;
    }
  } catch (e) {
    console.warn("resolveYouTubeChannelId failed:", e.message);
  }
  return null;
}

function parseISO8601Duration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  const h = parseInt(m[1] || "0", 10), mi = parseInt(m[2] || "0", 10), s = parseInt(m[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

async function fetchRecentVideosForChannel(channelId, apiKey, maxResults) {
  try {
    const chResp = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${apiKey}`);
    if (!chResp.ok) return [];
    const chData = await chResp.json();
    const uploadsPlaylistId = chData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return [];

    const plResp = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${apiKey}`);
    if (!plResp.ok) return [];
    const plData = await plResp.json();
    const videoIds = (plData.items || []).map(i => i.contentDetails?.videoId).filter(Boolean);
    if (videoIds.length === 0) return [];

    const vidResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${videoIds.join(",")}&key=${apiKey}`);
    if (!vidResp.ok) return [];
    const vidData = await vidResp.json();
    return (vidData.items || []).map(v => ({
      title: v.snippet.title,
      description: (v.snippet.description || "").slice(0, 200),
      duration_sec: parseISO8601Duration(v.contentDetails.duration),
      views: parseInt(v.statistics?.viewCount || "0", 10)
    }));
  } catch (e) {
    console.warn("fetchRecentVideosForChannel failed:", e.message);
    return [];
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
      MAX_COPYRIGHT_RISK_SCORE: 70, // 0-100, 100 is highest risk
      MIN_PLATFORM_DIVERSITY: 2,
      MAX_DUPLICATION_PERCENT: 5,
      NO_COMPILATION_KEYWORDS: ["compilation", "best of", "top 10", "epic moments"],
      NO_RANKING_KEYWORDS: ["rank", "#1", "worst", "best"],
    }
  },
  // Example Plugin: 'fails'
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
    discovery_keywords: {
      "Funny Fails": ["fail compilation", "funny fails", "epic fail", "prank reaction"],
      "Instant Karma": ["instant karma video", "bad driver karma", "rude person fail"]
    },
    // ... other plugin-specific data
  }
};

// -----------------------------------------------------------------------------
// RUNTIME STATE LAYER (Simulated - In-memory for Phase 1)
// -----------------------------------------------------------------------------
const workflowStates = {}; // Stores RuntimeState for active workflows { workflow_id: RuntimeState }

// Represents a snapshot of the workflow state
class RuntimeState {
  constructor(id, initialInput) {
    this.workflow_id = id;
    this.timestamp = new Date().toISOString();
    this.status = "INITIALIZED"; // INITIALIZED, RUNNING, PAUSED, COMPLETED, FAILED
    this.input_contract = initialInput;
    this.editorial_dna_profile = null; // Populated by EditorialDNAExtractionAgent, from real channel data
    this.editorial_intent = null;
    this.moment_ontology = null;
    this.discovery_missions = [];
    this.discovery_queue_status = { pending: 0, completed: 0, failed: 0, results: [] }; // results: RawClips[]
    this.raw_clips_collected = [];
    this.ai_insights = null; // Populated by RankingAgent
    this.validated_clips = [];
    this.scored_clips = [];
    this.curated_clips = [];
    this.narrative_clips = [];
    this.final_ranked_clips = [];
    this.final_report_output = null;
    this.confidence_journal = []; // [{ agent_id, score, reasoning, timestamp }]
    this.explainability_journal = []; // [{ agent_id, decision, reason, timestamp, trace_id }]
    this.agent_execution_log = []; // [{ agent_id, input_hash, output_hash, duration_ms, status, timestamp }]
    this.global_constraints = initialInput.constraints || {};
  }

  // Returns a new state with updates (immutable concept simulation)
  // FIX: The previous implementation did `{ ...this, ...newData }`, which produces
  // a *plain object* — object spread does NOT copy the prototype chain, so the
  // returned value lost the `.update()` method itself. The very next call to
  // `currentState.update(...)` in StateAccessCapability then threw
  // "currentState.update is not a function", crashing the orchestrator right
  // after the first agent completed. We now clone onto the same prototype so
  // every future state snapshot remains a real RuntimeState instance.
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
// -----------------------------------------------------------------------------
const eventLog = []; // Simple in-memory log of events for debugging

const EventPublisher = {
  publish: (type, payload) => {
    const event = { type, payload, timestamp: new Date().toISOString() };
    eventLog.push(event);
    console.log(`[EVENT BUS] Published: ${type}`, payload);
    // In a real implementation, this would push to Cloudflare Queues/Durable Objects.
  }
};

// -----------------------------------------------------------------------------
// POLICY LAYER (Simulated - Always pass for Phase 1)
// -----------------------------------------------------------------------------
const PolicyEngine = {
  apply: (policyId, data, context) => {
    // For Phase 1, policies always pass.
    // In later phases, this will load rules from KB and execute them.
    console.log(`[POLICY ENGINE] Applied policy: ${policyId} (Always passing in Phase 1)`);
    context.explainabilityRecorder.record(`Policy '${policyId}' applied: PASSED (Phase 1 simulation)`, { policyId, data });
    return { passed: true, reason: "Phase 1: Policy always passes.", confidence_impact: 0 };
  }
};

// -----------------------------------------------------------------------------
// EXPLAINABILITY LAYER (Simulated - In-memory for Phase 1)
// -----------------------------------------------------------------------------
const ExplainabilityRecorder = {
  record: (decision, details) => {
    // In a real implementation, this would persist detailed traces.
    console.log(`[EXPLAINABILITY] ${decision}`, details);
    // For Phase 1, we just log to console.
    // Full traces would be stored in RuntimeState or a dedicated D1 table.
  }
};


// -----------------------------------------------------------------------------
// CAPABILITY REGISTRY & LAYER
// -----------------------------------------------------------------------------

// LLM Router Independence
const LLMRouter = {
  async route(prompt, schema, modelPreference, env) {
    const models = {
      cloudflare: {
        id: modelPreference.cloudflare || "@cf/meta/llama-3.1-8b-instruct-fast",
        fallback: ["@cf/meta/llama-3.1-8b-instruct-fast", "@cf/zai-org/glm-4.7-flash"]
      },
      openrouter: {
        id: modelPreference.openrouter || "openai/gpt-4o",
        fallback: ["openai/gpt-4o", "anthropic/claude-3.5-sonnet", "google/gemini-pro"]
      },
      google: {
        id: modelPreference.google || "gemini-pro",
        fallback: ["gemini-pro", "gemini-1.5-flash-latest"]
      },
      // Add other providers as needed: github, huggingface, etc.
    };

    const preferredProvider = modelPreference.provider || "cloudflare";
    const attempts = [preferredProvider];
    // Add other providers as fallback if preferred fails
    if (preferredProvider !== "cloudflare") attempts.push("cloudflare");
    if (preferredProvider !== "openrouter") attempts.push("openrouter");
    if (preferredProvider !== "google") attempts.push("google");


    let lastError = null;

    for (const provider of [...new Set(attempts)]) { // Use Set to ensure unique attempts
      const modelCfg = models[provider];
      if (!modelCfg) continue; // Skip if provider config not found

      const modelList = [modelCfg.id, ...(modelCfg.fallback || [])].filter(Boolean);

      for (const currentModel of modelList) {
        try {
          let responseText = "";
          let success = false;

          const messages = [
            { role: "system", content: "You are a viral content research analyst. Always respond with valid JSON only, no markdown, no extra text. Ensure JSON is properly formatted and complete. Adhere strictly to the provided JSON schema." },
            { role: "user", content: prompt }
          ];

          switch (provider) {
            case "cloudflare":
              if (!env.AI) throw new Error("Cloudflare AI binding not configured.");
              const cfResp = await env.AI.run(currentModel, {
                messages: messages,
                max_tokens: 2000,
                response_format: { type: "json_object" }
              });
              if (cfResp && (cfResp.response || cfResp.result)) {
                responseText = typeof cfResp.response === 'string' ? cfResp.response : JSON.stringify(cfResp.response || cfResp.result);
                success = true;
              }
              break;

            case "openrouter":
              if (!env.OPENROUTER_API_KEY) throw new Error("OpenRouter API key not configured.");
              const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                  "Content-Type": "application/json",
                  "HTTP-Referer": "https://viral-discovery-proxy.fasterwgseverkh.workers.dev" // Worker's domain
                },
                body: JSON.stringify({
                  model: currentModel,
                  messages: messages,
                  max_tokens: 2000,
                  response_format: { type: "json_object" }
                })
              });
              if (!orResp.ok) {
                  const errorBody = await orResp.json().catch(() => ({ message: "Unknown OpenRouter error" }));
                  throw new Error(`OpenRouter API failed: ${orResp.status} - ${errorBody.message || JSON.stringify(errorBody)}`);
              }
              const orData = await orResp.json();
              if (orData.choices && orData.choices[0] && orData.choices[0].message) {
                  responseText = typeof orData.choices[0].message.content === 'string' ? orData.choices[0].message.content : JSON.stringify(orData.choices[0].message.content);
                  success = true;
              }
              break;

            case "google":
              if (!env.GEMINI_API_KEY) throw new Error("Gemini API key not configured.");
              const googleMessages = messages.map(msg => ({
                  role: msg.role === 'system' ? 'user' : msg.role, // Gemini doesn't have system role directly
                  parts: [{ text: msg.content }]
              }));
              const googleResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${env.GEMINI_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: googleMessages,
                  generationConfig: {
                    responseMimeType: "application/json",
                    maxOutputTokens: 2000,
                  }
                })
              });
              if (!googleResp.ok) {
                  const errorBody = await googleResp.json().catch(() => ({ message: "Unknown Gemini error" }));
                  throw new Error(`Gemini API failed: ${googleResp.status} - ${errorBody.message || JSON.stringify(errorBody)}`);
              }
              const googleData = await googleResp.json();
              if (googleData.candidates && googleData.candidates[0] && googleData.candidates[0].content && googleData.candidates[0].content.parts) {
                  responseText = googleData.candidates[0].content.parts[0].text;
                  success = true;
              }
              break;

            default:
              throw new Error(`Unsupported LLM provider: ${provider}`);
          }

          if (success && responseText.trim()) {
            try {
              const parsedData = JSON.parse(cleanJson(responseText));
              return { data: parsedData, provider: provider, model: currentModel, confidence: 0.9 }; // Placeholder confidence
            } catch (jsonErr) {
              lastError = new Error(`JSON parsing failed from ${provider}/${currentModel}: ${jsonErr.message}. Raw: ${responseText}`);
              console.warn(lastError.message);
              // Try next model/provider
            }
          } else if (success) {
            lastError = new Error(`Empty response from ${provider}/${currentModel}.`);
            console.warn(lastError.message);
          }
        } catch (e) {
          lastError = e;
          console.warn(`LLM call failed for ${provider}/${currentModel}:`, e.message);
        }
      }
    }
    throw new Error("All LLM attempts failed: " + (lastError ? lastError.message : "No models responded."));
  }
};


const capabilityRegistry = {
  // 11.1 LLMServiceCapability
  LLMServiceCapability: {
    id: "LLMServiceCapability",
    description: "Executes LLM calls via LLM Router.",
    execute: async (prompt, schema, modelPreference, env) => {
      // LLM Router handles model selection based on preferences and availability
      const { data, provider, model, confidence } = await LLMRouter.route(prompt, schema, modelPreference, env);
      return { data, provider, model, confidence };
    }
  },
  // 11.2 TaxonomyLookupCapability
  TaxonomyLookupCapability: {
    id: "TaxonomyLookupCapability",
    description: "Queries the Knowledge Base for relevant taxonomies, rules, or profiles.",
    execute: (pluginName, key) => {
      const plugin = KNOWLEDGE_BASE_PLUGINS[pluginName];
      if (!plugin) {
        console.warn(`Knowledge Base Plugin '${pluginName}' not found.`);
        return null;
      }
      return plugin[key] || null;
    }
  },
  // 11.3 SearchExecutionCapability
  SearchExecutionCapability: {
    id: "SearchExecutionCapability",
    description: "Interacts with external search APIs (YouTube direct; TikTok and Reddit via Apify).",
    execute: async (platform, query, filters, env) => {
      // FIX: LLM-generated platform strings vary in casing ("youtube", "Youtube", "YouTube").
      // A strict === comparison silently dropped every clip whenever the casing didn't match
      // exactly. Normalize before comparing.
      const normalizedPlatform = (platform || "").trim().toLowerCase();

      if (normalizedPlatform === "youtube") {
        if (!env.YOUTUBE_API_KEY) {
          console.warn("YouTube search skipped: YOUTUBE_API_KEY not configured on this Worker.");
          return [];
        }

        // FIX: When filters.max_age_months is missing (LLM omitted the field), the old code
        // passed `publishedAfter: undefined` straight into URLSearchParams, which stringifies
        // it to the literal text "undefined" — an invalid ISO date. YouTube's API then
        // rejected the whole request with a 400, and every single search silently returned
        // zero clips. We now only add the parameter when we have a real date, and otherwise
        // default to a sane 12-month window so results aren't accidentally unbounded.
        const ageMonths = Number(filters.max_age_months) > 0 ? Number(filters.max_age_months) : 12;
        const publishedAfter = new Date(Date.now() - ageMonths * 30 * 24 * 60 * 60 * 1000).toISOString();

        const paramsObj = {
          part: "snippet",
          q: query,
          key: env.YOUTUBE_API_KEY,
          maxResults: String(filters.max_results || 10),
          type: "video",
          videoDuration: "short",
          order: "viewCount", // default to viewCount for viral potential
          publishedAfter: publishedAfter
        };
        const params = new URLSearchParams(paramsObj);

        try {
          const searchResp = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
          if (!searchResp.ok) {
            const errBody = await searchResp.text().catch(() => "");
            console.warn("YT search failed:", searchResp.status, errBody.slice(0, 300));
            return [];
          }
          const searchData = await searchResp.json();
          const ids = searchData.items.map(i => i.id.videoId).filter(Boolean).join(",");
          if (!ids) return [];
          
          const detResp = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ids}&key=${env.YOUTUBE_API_KEY}`);
          if (!detResp.ok) return [];
          const detData = await detResp.json();
          
          return (detData.items || []).map(v => ({
            id: v.id,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            title: v.snippet.title,
            platform: "YouTube",
            creator_handle: v.snippet.channelTitle,
            channelId: v.snippet.channelId,
            thumbnail_url: v.snippet.thumbnails?.medium?.url || "",
            tags: v.snippet.tags || [],
            description_snippet: (v.snippet.description || "").slice(0, 300),
            views_approx: parseInt(v.statistics.viewCount || "0", 10),
            likes_approx: parseInt(v.statistics.likeCount || "0", 10),
            comments: parseInt(v.statistics.commentCount || "0", 10),
            published_at: v.snippet.publishedAt,
            source_type: "YouTube_API"
          }));
        } catch (e) {
          console.warn("YouTube API search failed:", e.message);
          return [];
        }
      }

      // NEW: TikTok via Apify's clockworks/tiktok-scraper Actor.
      if (normalizedPlatform === "tiktok") {
        if (!env.APIFY_API_TOKEN) {
          console.warn("TikTok search skipped: APIFY_API_TOKEN not configured on this Worker.");
          return [];
        }
        try {
          const apifyUrl = `https://api.apify.com/v2/actors/clockworks~tiktok-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(env.APIFY_API_TOKEN)}`;
          const body = {
            searchQueries: [query],
            resultsPerPage: Math.min(Number(filters.max_results) || 10, 30),
            searchSection: "/video"
          };
          const resp = await fetch(apifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            console.warn("TikTok (Apify) search failed:", resp.status, errBody.slice(0, 300));
            return [];
          }
          const items = await resp.json();
          // Field names follow clockworks/tiktok-scraper's documented dataset item shape.
          // Wrapped defensively (?? / optional chaining) in case of minor field drift.
          return (Array.isArray(items) ? items : []).map(v => ({
            id: v.id || v.videoId || v.webVideoUrl,
            url: v.webVideoUrl || v.videoUrl || "",
            title: (v.text || v.desc || "").slice(0, 200),
            platform: "TikTok",
            creator_handle: v.authorMeta?.name || v.authorMeta?.nickName || v.author?.uniqueId || "",
            thumbnail_url: v.videoMeta?.coverUrl || v.covers?.default || "",
            tags: (v.hashtags || []).map(h => (typeof h === "string" ? h : h.name)).filter(Boolean),
            description_snippet: (v.text || v.desc || "").slice(0, 300),
            views_approx: Number(v.playCount || v.videoMeta?.playCount || 0),
            likes_approx: Number(v.diggCount || 0),
            comments: Number(v.commentCount || 0),
            published_at: v.createTimeISO || "",
            source_type: "TikTok_Apify"
          })).filter(c => c.url);
        } catch (e) {
          console.warn("TikTok (Apify) search failed:", e.message);
          return [];
        }
      }

      // NEW: Reddit via Apify's solidcode/reddit-scraper Actor.
      if (normalizedPlatform === "reddit") {
        if (!env.APIFY_API_TOKEN) {
          console.warn("Reddit search skipped: APIFY_API_TOKEN not configured on this Worker.");
          return [];
        }
        try {
          const apifyUrl = `https://api.apify.com/v2/actors/solidcode~reddit-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(env.APIFY_API_TOKEN)}`;
          const body = {
            searches: [query],
            searchPosts: true,
            searchComments: false,
            searchCommunities: false,
            searchUsers: false,
            sort: "relevance",
            maxItems: Math.min(Number(filters.max_results) || 10, 30),
            skipComments: true
          };
          const resp = await fetch(apifyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          });
          if (!resp.ok) {
            const errBody = await resp.text().catch(() => "");
            console.warn("Reddit (Apify) search failed:", resp.status, errBody.slice(0, 300));
            return [];
          }
          const items = await resp.json();
          // recordType discriminator (per actor docs) lets us keep posts only, in case
          // searchPosts/searchComments settings still return a mixed dataset.
          const posts = (Array.isArray(items) ? items : []).filter(v => !v.recordType || v.recordType === "post");
          return posts.map(v => {
            const permalink = v.permalink || v.url || "";
            const url = permalink.startsWith("http") ? permalink : `https://www.reddit.com${permalink}`;
            return {
              id: v.id || v.postId || url,
              url,
              title: v.title || "",
              platform: "Reddit",
              creator_handle: v.author || v.username || "",
              thumbnail_url: (v.thumbnail && v.thumbnail.startsWith("http")) ? v.thumbnail : "",
              tags: v.subreddit ? [v.subreddit] : [],
              description_snippet: (v.selftext || v.text || "").slice(0, 300),
              views_approx: 0,
              likes_approx: Number(v.score || v.upvotes || 0),
              comments: Number(v.numComments || v.commentCount || 0),
              published_at: v.createdAt || v.createdUtc || "",
              source_type: "Reddit_Apify"
            };
          }).filter(c => c.url);
        } catch (e) {
          console.warn("Reddit (Apify) search failed:", e.message);
          return [];
        }
      }

      return []; // Return empty for unsupported platforms
    }
  },
  // 11.4 DataValidationCapability (Simplified for Phase 1)
  DataValidationCapability: {
    id: "DataValidationCapability",
    description: "Applies rules-based validation.",
    execute: (clips, rules) => {
      // Phase 1: Simple deduplication by URL
      const uniqueClips = [];
      const seenUrls = new Set();
      for (const clip of clips) {
        if (!seenUrls.has(clip.url)) {
          uniqueClips.push(clip);
          seenUrls.add(clip.url);
        }
      }
      // Placeholder for actual rule application from KB
      return uniqueClips;
    }
  },
  // 11.5 FeatureExtractionCapability (Future)
  FeatureExtractionCapability: {
    id: "FeatureExtractionCapability",
    description: "Future: Extracts features from video/images.",
    execute: () => {
      console.log("FeatureExtractionCapability: Not implemented in Phase 1.");
      return {};
    }
  },
  // 11.6 ScoringAlgorithmCapability (Placeholder for Phase 1)
  ScoringAlgorithmCapability: {
    id: "ScoringAlgorithmCapability",
    description: "Applies predefined scoring algorithms.",
    execute: (clip, criteria) => {
      // Phase 1: Simple scoring heuristic
      return { score: Math.round(Math.random() * 100), reasoning: "Heuristic score in Phase 1." };
    }
  },
  // 11.7 NarrativeConstructionCapability (Placeholder for Phase 1)
  NarrativeConstructionCapability: {
    id: "NarrativeConstructionCapability",
    description: "Applies algorithms or rules to arrange data into a narrative.",
    execute: (clips, rules) => {
      // Phase 1: Simple pass-through
      return clips;
    }
  },
  // 11.8 PersistenceCapability (Simulated in-memory for Phase 1)
  PersistenceCapability: {
    id: "PersistenceCapability",
    description: "Handles saving/loading data to/from Project Memory and Runtime State.",
    execute: (action, key, data) => {
      // In Phase 1, just logs. In later phases, would interact with D1/KV.
      console.log(`[PERSISTENCE] Action: ${action}, Key: ${key}, Data:`, data);
    }
  },
  // 11.9 ConfidenceCalculationCapability (Simplified for Phase 1)
  ConfidenceCalculationCapability: {
    id: "ConfidenceCalculationCapability",
    description: "Computes and propagates confidence scores.",
    execute: (inputConfidences, agentSpecificFactors) => {
      // Phase 1: Simple average or fixed score
      return { score: 85, reasoning: "Phase 1: Heuristic confidence." };
    }
  },
  // 11.10 PolicyEnforcementCapability (Simplified for Phase 1)
  PolicyEnforcementCapability: {
    id: "PolicyEnforcementCapability",
    description: "Applies policies from the Policy Layer.",
    execute: (policyId, data, context) => {
      return PolicyEngine.apply(policyId, data, context);
    }
  },
  // 11.11 EventPublishingCapability
  EventPublishingCapability: {
    id: "EventPublishingCapability",
    description: "Publishes events to the Event Bus.",
    execute: (type, payload) => {
      EventPublisher.publish(type, payload);
    }
  },
  // 11.12 StateAccessCapability
  StateAccessCapability: {
    id: "StateAccessCapability",
    description: "Provides controlled interface for agents to read/write to the Runtime State.",
    execute: (workflowId, action, data = null) => {
      const currentState = workflowStates[workflowId];
      if (!currentState) throw new Error(`Workflow state not found for ID: ${workflowId}`);
      if (action === "read") {
        return currentState; // Return current state snapshot
      } else if (action === "update" && data) {
        const newState = currentState.update(data);
        workflowStates[workflowId] = newState; // Update in-memory state
        return newState;
      }
      return null;
    }
  },
  // 11.13 ExplainabilityRecordingCapability
  ExplainabilityRecordingCapability: {
    id: "ExplainabilityRecordingCapability",
    description: "Records decision traces to the Explainability Layer.",
    execute: (decision, details) => {
      ExplainabilityRecorder.record(decision, details);
    }
  },
};

// -----------------------------------------------------------------------------
// AGENT CONTRACT & IMPLEMENTATIONS
// -----------------------------------------------------------------------------

// Helper to create AgentContext
function createAgentContext(workflowId, env) {
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
  };
}

const AGENT_REGISTRY = {
  // (0) Editorial DNA Extraction Agent — NEW
  // FEATURE: this is the direct response to Dev VOF's feedback — "Style DNA Sources"
  // (reference channel links) were previously only ever passed to the LLM as a literal
  // text string; the AI never actually saw what those channels post, so it couldn't
  // really learn their editorial pattern. This agent fetches REAL recent videos from
  // each reference channel via the YouTube Data API (title, description, duration,
  // views) and asks the LLM to infer a structured Editorial DNA profile from that real
  // evidence — content type, clip type, preferred emotions, clip length range, editing
  // pattern, source platforms, and an explicit reject list — matching the format Dev
  // VOF specified. Downstream agents (EditorialIntentAgent, SourceHunterAgent) then use
  // this profile to guide research and filtering instead of guessing from a topic string.
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
      const { capability_registry, env, explainability_recorder } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const referenceChannels = (runtimeState.input_contract.referenceChannels || []).map(c => (c || "").trim()).filter(Boolean);

      const emptyResult = (reason) => ({
        success: true,
        result: { editorialDnaProfile: null },
        metadata: { agent_id: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, version: AGENT_REGISTRY.EditorialDNAExtractionAgent.version, confidence_score: 0, explainability_trace_id: 'trace_dna_1' },
        new_state_data: { editorial_dna_profile: null },
        events_to_publish: [{ type: "EDITORIAL_DNA_SKIPPED", payload: { reason } }]
      });

      if (referenceChannels.length === 0) {
        explainability_recorder.execute("EditorialDNAExtractionAgent: No reference channels provided, skipping", {});
        return emptyResult("no_reference_channels");
      }
      if (!env.YOUTUBE_API_KEY) {
        explainability_recorder.execute("EditorialDNAExtractionAgent: YOUTUBE_API_KEY not configured, skipping", {});
        return emptyResult("youtube_api_key_missing");
      }

      // Resolve each reference channel to real recent video data (capped at 4 channels,
      // 12 videos each, to keep the LLM prompt a reasonable size and cost).
      // PERF: process channels in parallel (was a sequential for-loop) — with 2+
      // reference channels this alone was adding several extra seconds of latency,
      // contributing to the frontend's request timeout on the expanded pipeline.
      const channelResults = await Promise.all(referenceChannels.slice(0, 4).map(async (link) => {
        try {
          const ref = parseYouTubeChannelRef(link);
          const channelId = await resolveYouTubeChannelId(ref, env.YOUTUBE_API_KEY);
          if (!channelId) {
            explainability_recorder.execute("EditorialDNAExtractionAgent: Could not resolve channel", { link });
            return null;
          }
          const videos = await fetchRecentVideosForChannel(channelId, env.YOUTUBE_API_KEY, 12);
          return videos.length > 0 ? { channel: link, videos } : null;
        } catch (e) {
          console.warn("EditorialDNAExtractionAgent: failed for", link, e.message);
          return null;
        }
      }));
      const channelSummaries = channelResults.filter(Boolean);

      if (channelSummaries.length === 0) {
        explainability_recorder.execute("EditorialDNAExtractionAgent: Could not fetch real data for any reference channel", { referenceChannels });
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

      const { data, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env);
      if (error) {
        console.warn("EditorialDNAExtractionAgent: LLM failed:", error);
        return emptyResult("llm_failed");
      }

      // CONTRACT §1: this exact shape (clip_archetypes/hook_patterns/emotion_patterns/
      // reject_patterns/ranking_logic) is what every downstream agent reads. No agent
      // may invent alternate field names for DNA data.
      const dnaProfile = {
        clip_archetypes: coerceToArray(data?.clip_archetypes),
        hook_patterns: coerceToArray(data?.hook_patterns),
        emotion_patterns: coerceToArray(data?.emotion_patterns),
        reject_patterns: coerceToArray(data?.reject_patterns),
        ranking_logic: typeof data?.ranking_logic === 'string' ? data.ranking_logic : "",
        clip_length_range: (data?.clip_length_range && typeof data.clip_length_range === 'object') ? data.clip_length_range : { min_sec: 5, max_sec: 20 },
        source_platforms: coerceToArray(data?.source_platforms),
        source_channels: referenceChannels,
        based_on_real_video_count: channelSummaries.reduce((sum, c) => sum + c.videos.length, 0)
      };

      explainability_recorder.execute("EditorialDNAExtractionAgent: Extracted DNA profile from real channel data", { dnaProfile, model, provider, confidence });

      return {
        success: true,
        result: { editorialDnaProfile: dnaProfile },
        metadata: { agent_id: AGENT_REGISTRY.EditorialDNAExtractionAgent.id, version: AGENT_REGISTRY.EditorialDNAExtractionAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_dna_1' },
        new_state_data: { editorial_dna_profile: dnaProfile },
        events_to_publish: [{ type: "EDITORIAL_DNA_EXTRACTED", payload: { channels: referenceChannels.length, videos_analyzed: dnaProfile.based_on_real_video_count } }]
      };
    }
  },

  // (A) Opportunity Generator
  OpportunityGenerator: {
    id: "OpportunityGenerator",
    version: "1.0.0",
    description: "Generates novel, trending, and high-potential Content Opportunity Topics.",
    input_schema: {}, // Will use global_constraints
    output_schema: { type: "array", items: { type: "string" } },
    dependencies: [],
    required_capabilities: ["LLMServiceCapability", "TaxonomyLookupCapability", "ConfidenceCalculationCapability", "ExplainabilityRecordingCapability"],
    estimated_cost: "Low", estimated_latency_ms: 5000, max_retries: 2,
    read_state_keys: ["global_constraints"],
    write_state_keys: ["opportunity_topics"],
    run: async (runtimeState, context) => {
      const { capability_registry, knowledge_base, env, explainability_recorder } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const topicTaxonomy = knowledge_base.execute('core', 'content_taxonomy');
      const trendProfiles = knowledge_base.execute('core', 'trend_profiles');

      const prompt = "Based on current trends (e.g., seasonal, evergreen from " + JSON.stringify(trendProfiles) + ") and content categories (" + JSON.stringify(topicTaxonomy) + "), generate 5-8 novel and high-potential \"Ranking\" format video topic ideas. Focus on unique combinations, current relevance, and high replay value. Ensure varied topics. Return ONLY JSON array of strings.";
      
      const { data: topics, confidence, error, model, provider } = await llmService.execute(prompt, { type: "array", items: { type: "string" } }, runtimeState.input_contract.model_preference, env);

      if (error) throw new Error("LLM for OpportunityGenerator failed: " + error);
      const safeTopics = coerceToArray(topics);
      explainability_recorder.execute("OpportunityGenerator: Generated topics", { topics: safeTopics, model, provider, confidence });
      
      return {
        success: true,
        result: { topics: safeTopics },
        metadata: { agent_id: AGENT_REGISTRY.OpportunityGenerator.id, version: AGENT_REGISTRY.OpportunityGenerator.version, confidence_score: confidence, explainability_trace_id: 'trace_og_1' },
        new_state_data: { opportunity_topics: safeTopics },
        events_to_publish: [{ type: "OPPORTUNITIES_GENERATED", payload: { topics: safeTopics } }]
      };
    }
  },

  // (B) Editorial Intent Agent
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
      const { capability_registry, knowledge_base, env, explainability_recorder } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const emotionTaxonomy = knowledge_base.execute('core', 'emotion_taxonomy');
      const platformProfiles = knowledge_base.execute('core', 'platform_profiles');
      const contentTaxonomy = knowledge_base.execute('core', 'content_taxonomy'); // General content taxonomy

      const { topic, creativeBrief, referenceChannels, constraints } = runtimeState.input_contract;
      // FEATURE: use the REAL, evidence-based Editorial DNA profile (extracted from
      // actual channel videos) when available, instead of just the raw channel URL text.
      const dnaProfile = runtimeState.editorial_dna_profile;

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
          topic: { type: "string" },
          creative_brief_summary: { type: "string" },
          primary_moment_categories: { type: "array", items: { type: "string" } },
          acceptable_event_types: { type: "array", items: { type: "string" } },
          reject_content_types: { type: "array", items: { type: "string" } },
          target_emotions: { type: "array", items: { type: "string" } },
          desired_clip_characteristics: { type: "object" },
          target_platform_intents: { type: "array", items: { type: "object" } },
          target_audience_profile: { type: "string" },
          overall_content_goal: { type: "string" },
        },
        required: ["topic", "creative_brief_summary", "primary_moment_categories", "acceptable_event_types", "reject_content_types", "target_emotions", "desired_clip_characteristics", "target_platform_intents", "target_audience_profile", "overall_content_goal"]
      };

      const { data: llmData, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env);

      if (error) throw new Error("LLM for EditorialIntentAgent failed: " + error);
      
      const finalEditorialIntent = {
          ...llmData,
          topic: llmData.topic || topic, // Fallback to original input
          creative_brief_summary: llmData.creative_brief_summary || creativeBrief, // Fallback to original input
          acceptable_event_types: coerceToArray(llmData.acceptable_event_types),
          reject_content_types: coerceToArray(llmData.reject_content_types)
      };

      explainability_recorder.execute("EditorialIntentAgent: Generated intent", { editorialIntent: finalEditorialIntent, model, provider, confidence });

      return {
        success: true,
        result: { editorialIntent: finalEditorialIntent || {} },
        metadata: { agent_id: AGENT_REGISTRY.EditorialIntentAgent.id, version: AGENT_REGISTRY.EditorialIntentAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_ei_1' },
        new_state_data: { editorial_intent: finalEditorialIntent || {} },
        events_to_publish: [{ type: "EDITORIAL_INTENT_GENERATED", payload: { editorialIntent: finalEditorialIntent || {} } }]
      };
    }
  },

  // (C) Moment Ontology Agent
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
      const { capability_registry, knowledge_base, env, explainability_recorder } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const primaryCategories = runtimeState.editorial_intent?.primary_moment_categories || [];

      // Example: Load specific plugin taxonomy for 'fails'
      const momentTaxonomyCore = knowledge_base.execute('core', 'moment_taxonomy') || {};
      // BUGFIX: only pull in the 'fails' plugin taxonomy when the topic is actually
      // about fails/pranks — previously this ran unconditionally on every topic.
      const topicText = runtimeState.editorial_intent?.topic || runtimeState.input_contract?.topic || "";
      const briefText = runtimeState.editorial_intent?.creative_brief_summary || runtimeState.input_contract?.creativeBrief || "";
      const momentTaxonomyFails = isPluginRelevant("fails", topicText, briefText)
        ? (knowledge_base.execute('fails', 'moment_taxonomy') || {})
        : {};
      const combinedMomentTaxonomy = { ...momentTaxonomyCore, ...momentTaxonomyFails };


      const prompt = "Given primary moment categories " + JSON.stringify(primaryCategories) + " and existing moment taxonomies like " + JSON.stringify(combinedMomentTaxonomy) + ", expand them into detailed Moment Types and associated Scene Types (visualizable scenarios).\n" +
      "Output JSON as an array of objects, each with 'category', 'moment_types' (array of {type:string, scene_types:string[]}).";

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" },
            moment_types: {
              type: "array",
              items: {
                type: "object",
                properties: { type: { type: "string" }, scene_types: { type: "array", items: { type: "string" } } }
              }
            }
          }
        }
      };

      const { data: momentOntology, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env);

      if (error) throw new Error("LLM for MomentOntologyAgent failed: " + error);
      const safeMomentOntology = coerceToArray(momentOntology);
      explainability_recorder.execute("MomentOntologyAgent: Generated ontology", { momentOntology: safeMomentOntology, model, provider, confidence });

      return {
        success: true,
        result: { momentOntology: safeMomentOntology },
        metadata: { agent_id: AGENT_REGISTRY.MomentOntologyAgent.id, version: AGENT_REGISTRY.MomentOntologyAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_mo_1' },
        new_state_data: { moment_ontology: safeMomentOntology },
        events_to_publish: [{ type: "MOMENT_ONTOLOGY_CREATED", payload: { momentOntology: safeMomentOntology } }]
      };
    }
  },

  // (E) Discovery Strategy Planner Agent
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
      const { capability_registry, knowledge_base, env, explainability_recorder } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const platformProfiles = knowledge_base.execute('core', 'platform_profiles');
      // BUGFIX: only pull in the 'fails' plugin discovery keywords when the topic is
      // actually about fails/pranks — previously this ran unconditionally on every
      // topic, biasing the LLM toward generating gym-fail/prank discovery missions
      // even for completely unrelated topics (e.g. "don't trust your eyes illusions").
      const dspTopicText = runtimeState.editorial_intent?.topic || runtimeState.input_contract?.topic || "";
      const dspBriefText = runtimeState.editorial_intent?.creative_brief_summary || runtimeState.input_contract?.creativeBrief || "";
      const discoveryKeywordsFails = isPluginRelevant("fails", dspTopicText, dspBriefText)
        ? knowledge_base.execute('fails', 'discovery_keywords')
        : null;

      const editorialIntent = runtimeState.editorial_intent;
      const momentOntology = runtimeState.moment_ontology;
      const constraints = runtimeState.global_constraints;

      const prompt = "Based on the Editorial Intent (" + JSON.stringify(editorialIntent) + "), Moment Ontology (" + JSON.stringify(momentOntology) + "), global constraints (" + JSON.stringify(constraints) + "), and platform profiles (" + JSON.stringify(platformProfiles) + "), generate 5-10 Discovery Missions.\n" +
      "IMPORTANT: build primary_queries/keywords from the SPECIFIC acceptable_event_types in the Editorial Intent (e.g. 'photobomb', 'object collision') — do NOT just restate the topic words verbatim as the only query, since that tends to surface pre-made compilation/ranking videos about the topic rather than raw individual moments.\n" +
      "Each mission should include: mission_focus, clip_criteria (from editorialIntent.desired_clip_characteristics), priority_score (1-100), confidence_score (1-100), estimated_cost (Low/Medium/High), expected_yield (Low/Medium/High), and platform_strategies[] (platform, search_approach, primary_queries[], secondary_queries[], hashtags[], keywords[], filters{}).\n" +
      "Integrate keywords from specific plugin knowledge bases like 'fails' if relevant: " + JSON.stringify(discoveryKeywordsFails || {}) + ".\n" +
      "Return ONLY JSON array of Discovery Mission objects.";

      const schema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            mission_focus: { type: "string" },
            clip_criteria: { type: "object" },
            priority_score: { type: "integer" },
            confidence_score: { type: "integer" },
            estimated_cost: { type: "string" },
            expected_yield: { type: "string" },
            platform_strategies: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  platform: { type: "string" }, search_approach: { type: "string" },
                  primary_queries: { type: "array", items: { type: "string" } },
                  secondary_queries: { type: "array", items: { type: "string" } },
                  hashtags: { type: "array", items: { type: "string" } },
                  keywords: { type: "array", items: { type: "string" } },
                  filters: { type: "object" }
                }
              }
            }
          },
          required: ["mission_focus", "clip_criteria", "priority_score", "confidence_score", "estimated_cost", "expected_yield", "platform_strategies"]
        }
      };

      const { data: discoveryMissions, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env);

      if (error) throw new Error("LLM for DiscoveryStrategyPlannerAgent failed: " + error);
      // BUGFIX: discoveryMissions can arrive as a non-array (e.g. an object like
      // { "missions": [...] } when the provider's JSON mode forces an object
      // root), which previously crashed here with "(discoveryMissions || []).sort
      // is not a function" because `|| []` only triggers on falsy values, not
      // on truthy non-array objects. coerceToArray() normalizes it safely.
      const safeDiscoveryMissions = coerceToArray(discoveryMissions);
      explainability_recorder.execute("DiscoveryStrategyPlannerAgent: Generated missions", { discoveryMissions: safeDiscoveryMissions, model, provider, confidence });

      // Sort missions by priority_score descending
      const sortedMissions = safeDiscoveryMissions.sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));

      return {
        success: true,
        result: { discoveryMissions: sortedMissions },
        metadata: { agent_id: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.id, version: AGENT_REGISTRY.DiscoveryStrategyPlannerAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_dsp_1' },
        new_state_data: { discovery_missions: sortedMissions },
        events_to_publish: [{ type: "DISCOVERY_MISSIONS_PLANNED", payload: { missions: sortedMissions } }]
      };
    }
  },

  // (F) Source Hunter Agent
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
      const { capability_registry, env, explainability_recorder } = context;
      const searchExecution = capability_registry.SearchExecutionCapability;
      const persistence = capability_registry.PersistenceCapability;
      const eventPublishing = capability_registry.EventPublishingCapability;

      const discoveryMissions = runtimeState.discovery_missions || [];
      const allRawClips = [];
      let pendingSearches = 0;

      explainability_recorder.execute("SourceHunterAgent: Starting clip discovery", { missions: discoveryMissions.length });

      // Execute search for each mission across platforms in parallel
      const searchPromises = discoveryMissions.flatMap(mission =>
        (mission.platform_strategies || []).map(async (strategy) => {
          pendingSearches++;
          // FIX: primary_queries and/or keywords can be undefined if the LLM
          // omits a field. Guard each with `|| []` before calling .join(),
          // otherwise this throws "Cannot read properties of undefined (reading 'join')"
          // and silently kills the whole SourceHunterAgent (and therefore the workflow).
          const primaryQueries = strategy.primary_queries || [];
          const keywords = strategy.keywords || [];
          const query = (primaryQueries.length ? primaryQueries : keywords).join(" ");

          if (!query) {
            pendingSearches--;
            explainability_recorder.execute("SourceHunterAgent: Skipped strategy with no query terms", { mission_focus: mission.mission_focus, platform: strategy.platform });
            return;
          }

          const clips = await searchExecution.execute(strategy.platform, query, {
            ...strategy.filters,
            max_results: 10, // Limit results per query for Phase 1
            max_age_months: runtimeState.editorial_intent?.desired_clip_characteristics?.max_age_months
          }, env);

          allRawClips.push(...clips);
          eventPublishing.execute("RAW_CLIP_COLLECTED", { mission_focus: mission.mission_focus, platform: strategy.platform, count: clips.length });
          explainability_recorder.execute("SourceHunterAgent: Found " + clips.length + " clips for '" + mission.mission_focus + "' on " + strategy.platform, { query, count: clips.length });
          pendingSearches--;
        })
      );

      await Promise.all(searchPromises);

      // BUGFIX/FEATURE: NO_COMPILATION_KEYWORDS / NO_RANKING_KEYWORDS were defined in
      // the knowledge base's policy_rules, and editorial_intent even captures explicit
      // not_compilation/not_ranking_video flags from the LLM — but nothing ever actually
      // checked a clip's title against them. PolicyEngine.apply() always returned
      // "passed: true" unconditionally, and no agent even called it. So every search
      // just returned whatever YouTube/TikTok/Reddit's own algorithm ranked highest for
      // the query — which, for a topic like "funniest chicken scream compilations", is
      // dominated by *other creators' own ranking/compilation videos*, not raw single
      // moments. That's the real reason results looked like "manual search" instead of
      // curated original clips. This applies the policy for real.
      const dcc = runtimeState.editorial_intent?.desired_clip_characteristics || {};
      const wantsNoCompilation = dcc.not_compilation !== false; // default true: this tool's whole point is original clips
      const wantsNoRanking = dcc.not_ranking_video !== false;
      const policyRules = context.knowledge_base.execute('core', 'policy_rules') || {};
      const compilationWords = policyRules.NO_COMPILATION_KEYWORDS || [];
      const rankingWords = policyRules.NO_RANKING_KEYWORDS || [];

      // FEATURE: also reject anything matching the real, evidence-based reject_list from
      // EditorialDNAExtractionAgent (e.g. "Commentary videos", "Podcasts", "Reaction
      // videos", "News videos") — derived from actual reference-channel videos, not a
      // static hardcoded list. Reduce each reject phrase to its meaningful keyword(s).
      const STOPWORDS = new Set(["videos", "video", "content", "clips", "clip", "and", "or", "the", "a", "an", "long"]);
      const dnaRejectWords = (runtimeState.editorial_dna_profile?.reject_patterns || [])
        .flatMap(phrase => phrase.toLowerCase().split(/\s+/))
        .filter(w => w.length > 3 && !STOPWORDS.has(w));

      // FEATURE: this is the direct fix for topics leaking irrelevant categories (DIY,
      // news, podcasts, gaming, movie clips, etc.) when no reference channels were given —
      // EditorialIntentAgent now generates a per-topic reject_content_types list via LLM
      // reasoning about THIS specific topic, independent of the (optional) DNA profile.
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
          { removed_titles: filteredOut.slice(0, 10).map(c => c.title) }
        );
      }
      // Safety net: if the filter would wipe out every single result (e.g. because the
      // whole niche is inherently "ranking"-named on YouTube), keep the originals rather
      // than handing RankingAgent an empty list and a dead report.
      const finalClips = keptClips.length > 0 ? keptClips : allRawClips;

      const confidence = capability_registry.ConfidenceCalculationCapability.execute({
        search_coverage_success: finalClips.length > 0 ? 1 : 0
      });

      // Update queue status and raw clips collected in RuntimeState
      const newDiscoveryQueueStatus = {
        pending: pendingSearches,
        completed: discoveryMissions.length - pendingSearches,
        failed: 0, // Placeholder
        results: finalClips.map(clip => ({ id: clip.id, url: clip.url })) // Only store minimal info in queue status
      };

      return {
        success: true,
        result: { raw_clips: finalClips },
        metadata: { agent_id: AGENT_REGISTRY.SourceHunterAgent.id, version: AGENT_REGISTRY.SourceHunterAgent.version, confidence_score: confidence.score, explainability_trace_id: 'trace_sh_1' },
        new_state_data: {
          raw_clips_collected: finalClips,
          discovery_queue_status: newDiscoveryQueueStatus
        },
        events_to_publish: [
          { type: "DISCOVERY_PHASE_COMPLETED", payload: { total_clips: allRawClips.length } }
        ]
      };
    }
  },

  // (G) Ranking Agent — NEW
  // BUGFIX/FEATURE: previously "ranked_clip_opportunities" was NOT actually ranked by AI at
  // all — it was just `raw_clips_collected.slice(0, 6)` (whatever order the search APIs
  // happened to return) with completely hardcoded text: "editorial_repost_analysis: 'High
  // view count clip found (Phase 1 placeholder)'" and "confidence_score: 75" for every single
  // clip. ScoringAlgorithmCapability was also just `Math.round(Math.random() * 100)`. None of
  // that was real curation. This agent sends the actually-collected clips to the LLM and asks
  // it to select and rank a genuine #6→#1 countdown with real per-clip reasoning tied to the
  // editorial brief, plus real (non-placeholder) insight text.
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
      const { capability_registry, env, explainability_recorder } = context;
      const llmService = capability_registry.LLMServiceCapability;
      const clips = runtimeState.raw_clips_collected || [];
      const editorialIntent = runtimeState.editorial_intent || {};
      const topic = editorialIntent.topic || runtimeState.input_contract?.topic || "";

      if (clips.length === 0) {
        const emptyInsights = {
          overall_opportunity_reasoning: "No source clips were collected for this topic, so no ranking could be generated. Try a broader topic, a longer date window, or check that platform API keys/tokens are configured.",
          trend_status: "Unknown",
          hook_suggestions: [],
          hashtag_strategy: [],
          key_search_phrases_for_discoverability: [],
          seo_elements_for_upload: { title_insights: "", description_hook: "", tags_to_prioritize: [] },
          ranked_clip_opportunities: []
        };
        explainability_recorder.execute("RankingAgent: No clips to rank", {});
        return {
          success: true,
          result: { aiInsights: emptyInsights },
          metadata: { agent_id: AGENT_REGISTRY.RankingAgent.id, version: AGENT_REGISTRY.RankingAgent.version, confidence_score: 0, explainability_trace_id: 'trace_ra_1' },
          new_state_data: { ai_insights: emptyInsights },
          events_to_publish: [{ type: "RANKING_COMPLETED", payload: { count: 0 } }]
        };
      }

      // Cap prompt size: summarize at most 40 candidate clips (LLM only needs enough
      // signal to pick 6 good ones, not every field of every clip).
      const candidates = clips.slice(0, 40).map((c, i) => ({
        index: i,
        url: c.url,
        platform: c.platform,
        title: c.title,
        description: (c.description_snippet || "").slice(0, 200),
        views: c.views_approx || 0,
        likes: c.likes_approx || 0,
        comments: c.comments || 0
      }));

      const dnaProfile = runtimeState.editorial_dna_profile;

      // CONTRACT §3: every ranked clip must carry explicit reasoning across 5 required
      // fields plus a weighted score_breakdown. No field is optional; entries missing
      // any of them are dropped (see REJECT-over-FALLBACK rule below), never shipped
      // with a placeholder.
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
        "For EVERY selected clip you MUST provide ALL of these non-empty, specific (not generic) reasoning fields:\n" +
        "- moment_idea: the SPECIFIC visual moment as a punchy countdown phrase (not the raw title)\n" +
        "- style_dna_match_reason: specifically why this fits the Editorial DNA / creative brief (not a generic 'it's funny')\n" +
        "- countdown_position_reason: why THIS rank specifically, not a different one\n" +
        "- viral_mechanism: the specific mechanic that makes it shareable (e.g. 'expectation subversion', 'relatable failure')\n" +
        "- emotion_trigger: the specific emotional trigger for the viewer\n" +
        "- source_confidence: why this looks like an original/traceable source (not just 'it has views')\n" +
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
          overall_opportunity_reasoning: { type: "string" },
          trend_status: { type: "string" },
          hook_suggestions: { type: "array", items: { type: "string" } },
          hashtag_strategy: { type: "array", items: { type: "string" } },
          key_search_phrases_for_discoverability: { type: "array", items: { type: "string" } },
          ranked_clip_opportunities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rank: { type: "integer" },
                moment_idea: { type: "string" },
                suggested_source_platform: { type: "string" },
                url_to_potential_original_clip: { type: "string" },
                style_dna_match_reason: { type: "string" },
                countdown_position_reason: { type: "string" },
                viral_mechanism: { type: "string" },
                emotion_trigger: { type: "string" },
                source_confidence: { type: "string" },
                score_breakdown: { type: "object", properties: scoreProps }
              },
              required: ["rank", "moment_idea", "suggested_source_platform", "url_to_potential_original_clip", "style_dna_match_reason", "countdown_position_reason", "viral_mechanism", "emotion_trigger", "source_confidence", "score_breakdown"]
            }
          }
        },
        required: ["overall_opportunity_reasoning", "trend_status", "ranked_clip_opportunities"]
      };

      const { data, confidence, error, model, provider } = await llmService.execute(prompt, schema, runtimeState.input_contract.model_preference, env);
      if (error) throw new Error("LLM for RankingAgent failed: " + error);

      // BUGFIX: normalizeUrl previously did NOT strip a "www." prefix, so a clip stored
      // as "https://www.youtube.com/watch?v=X" would never match the LLM echoing back
      // "https://youtube.com/watch?v=X" (no www) — causing every ranked entry to fail
      // validation. Also extract the YouTube video ID as a second, more robust key.
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

      // CONTRACT §3 — REJECT over FALLBACK: a clip is only kept if (a) its URL matches
      // a real collected clip, AND (b) every required reasoning field is present and
      // non-empty. There is no views/likes-only fallback path — if nothing survives,
      // ranked_clip_opportunities is honestly empty.
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
          if (!matchedClip) return null;

          const missingFields = REQUIRED_REASONING_FIELDS.filter(f => !r[f] || typeof r[f] !== 'string' || !r[f].trim());
          if (missingFields.length > 0) {
            rejectedForMissingReasoning.push({ title: matchedClip.title, missingFields });
            return null;
          }

          const sb = r.score_breakdown || {};
          const clamp = (n) => Math.max(0, Math.min(100, Number.isFinite(n) ? n : 0));
          const scoreBreakdown = {
            style_dna_match: clamp(sb.style_dna_match),
            moment_strength: clamp(sb.moment_strength),
            viewer_emotion: clamp(sb.viewer_emotion),
            original_source: clamp(sb.original_source),
            engagement: clamp(sb.engagement)
          };
          // CONTRACT: weighted editorial score — engagement contributes only 10%.
          const finalScore = Math.round(
            scoreBreakdown.style_dna_match * 0.30 +
            scoreBreakdown.moment_strength * 0.25 +
            scoreBreakdown.viewer_emotion * 0.20 +
            scoreBreakdown.original_source * 0.15 +
            scoreBreakdown.engagement * 0.10
          );

          const searchTerms = (matchedClip.tags && matchedClip.tags.length > 0) ? matchedClip.tags.slice(0, 5) : [topic];

          return {
            rank: Number(r.rank) || 0,
            moment_idea: r.moment_idea || matchedClip.title,
            suggested_source_platform: matchedClip.platform,
            url_to_potential_original_clip: matchedClip.url,
            style_dna_match_reason: r.style_dna_match_reason,
            countdown_position_reason: r.countdown_position_reason,
            viral_mechanism: r.viral_mechanism,
            emotion_trigger: r.emotion_trigger,
            source_confidence: r.source_confidence,
            score_breakdown: scoreBreakdown,
            final_score: finalScore,
            confidence_score: finalScore, // kept for backward-compat with older frontend field name
            human_editor_search_terms: searchTerms
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.rank - a.rank) // rank 6 first, rank 1 last (countdown order)
        .slice(0, 6);

      if (rejectedForMissingReasoning.length > 0) {
        explainability_recorder.execute("RankingAgent: rejected clips missing required reasoning (contract §3)", { rejected: rejectedForMissingReasoning });
      }
      if (finalRanked.length === 0) {
        explainability_recorder.execute("RankingAgent: 0 clips passed the editorial reasoning bar this run — honestly reporting empty, no engagement fallback per contract", { candidate_count: clips.length });
      }

      const finalInsights = {
        overall_opportunity_reasoning: data?.overall_opportunity_reasoning || (finalRanked.length === 0 ? "Ranking could not be generated with the required editorial reasoning this run. Try again, broaden the topic, or provide reference channels for a stronger Editorial DNA match." : ""),
        trend_status: data?.trend_status || "Unknown",
        hook_suggestions: coerceToArray(data?.hook_suggestions),
        hashtag_strategy: coerceToArray(data?.hashtag_strategy),
        key_search_phrases_for_discoverability: coerceToArray(data?.key_search_phrases_for_discoverability),
        seo_elements_for_upload: {
          title_insights: "Craft catchy titles based on topic",
          description_hook: "Engage early with a strong hook",
          tags_to_prioritize: [topic.split(' ')[0]].filter(Boolean)
        },
        ranked_clip_opportunities: finalRanked
      };

      explainability_recorder.execute("RankingAgent: Ranked clips", { count: finalRanked.length, model, provider, confidence });

      return {
        success: true,
        result: { aiInsights: finalInsights },
        metadata: { agent_id: AGENT_REGISTRY.RankingAgent.id, version: AGENT_REGISTRY.RankingAgent.version, confidence_score: confidence, explainability_trace_id: 'trace_ra_1' },
        new_state_data: { ai_insights: finalInsights },
        events_to_publish: [{ type: "RANKING_COMPLETED", payload: { count: finalRanked.length } }]
      };
    }
  },

  // Add other agents (H, I, J, K, L) here for future phases.
  // For Phase 1, only these initial agents are implemented.
};

// -----------------------------------------------------------------------------
// ORCHESTRATOR LAYER
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// VIRAL OPPORTUNITY GENERATOR (powers the 🎲 Dice button) — CONTRACT §2
// FEATURE: previously the Dice button just picked a random string from a static
// hardcoded list (SURPRISE_NICHES) client-side — no AI involved at all. This is a
// real LLM call that produces a structured Viral Opportunity (title + format +
// viewer emotion arc + search strategy + reject list), optionally informed by a
// real Editorial DNA profile if the user has already analyzed reference channels
// in this session.
// -----------------------------------------------------------------------------
async function generateViralOpportunity(env, modelPreference, dnaProfile) {
  const trendProfiles = KNOWLEDGE_BASE_PLUGINS.core.trend_profiles;
  const storyPatterns = KNOWLEDGE_BASE_PLUGINS.core.story_patterns;

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
      title: { type: "string" },
      format: { type: "string" },
      viewer_emotion_arc: { type: "string" },
      search_strategy: { type: "array", items: { type: "string" } },
      reject: { type: "array", items: { type: "string" } }
    },
    required: ["title", "format", "viewer_emotion_arc", "search_strategy", "reject"]
  };

  const { data, confidence, error } = await capabilityRegistry.LLMServiceCapability.execute(prompt, schema, modelPreference, env);
  if (error) throw new Error("Viral Opportunity generation failed: " + error);

  return {
    title: data?.title || "",
    format: data?.format || "",
    viewer_emotion_arc: data?.viewer_emotion_arc || "",
    search_strategy: coerceToArray(data?.search_strategy),
    reject: coerceToArray(data?.reject),
    confidence
  };
}

async function orchestrate(workflowId, inputContract, env) {
  const stateAccess = capabilityRegistry.StateAccessCapability;
  let runtimeState = new RuntimeState(workflowId, inputContract);
  workflowStates[workflowId] = runtimeState; // Initialize global in-memory state for this workflow

  const agentContext = createAgentContext(workflowId, env);
  
  // Set global constraints from input
  runtimeState = stateAccess.execute(workflowId, "update", { global_constraints: inputContract.constraints || {} }); // Ensure constraints are explicitly in state

  const executionLog = [];

  const executeAgent = async (agentId) => {
    const agent = AGENT_REGISTRY[agentId];
    if (!agent) throw new Error(`Agent '${agentId}' not found in registry.`);

    const startTime = Date.now();
    let agentOutput;
    try {
      // Agents read from the current workflow state
      agentOutput = await agent.run(workflowStates[workflowId], agentContext);
      
      // Update runtime state with agent's output
      runtimeState = stateAccess.execute(workflowId, "update", {
        ...agentOutput.new_state_data,
        agent_execution_log: [...runtimeState.agent_execution_log, {
          agent_id: agentId,
          status: "COMPLETED",
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString(),
          metadata: agentOutput.metadata // include agent specific metadata like confidence
        }]
      });

      // Publish events
      (agentOutput.events_to_publish || []).forEach(event => {
        agentContext.event_bus.execute(event.type, { workflowId, ...event.payload });
      });

    } catch (e) {
      console.error("Orchestration: Agent '" + agentId + "' failed:", e.message);
      runtimeState = stateAccess.execute(workflowId, "update", {
        status: "FAILED",
        agent_execution_log: [...runtimeState.agent_execution_log, {
          agent_id: agentId,
          status: "FAILED",
          error: e.message,
          duration_ms: Date.now() - startTime,
          timestamp: new Date().toISOString()
        }]
      });
      throw new Error("Agent '" + agentId + "' failed: " + e.message);
    }
    executionLog.push({ agent: agentId, status: "completed", duration: Date.now() - startTime });
    return agentOutput;
  };

  try {
    // Phase 1 Workflow - Simplified Linear Flow
    await executeAgent("EditorialDNAExtractionAgent");
    await executeAgent("OpportunityGenerator");
    await executeAgent("EditorialIntentAgent");
    await executeAgent("MomentOntologyAgent");
    await executeAgent("DiscoveryStrategyPlannerAgent");
    await executeAgent("SourceHunterAgent");
    await executeAgent("RankingAgent");
    // Other agents (G, H, I, J, K, L) will be integrated in future phases

    runtimeState = stateAccess.execute(workflowId, "update", { status: "COMPLETED" });
    agentContext.event_bus.execute("WORKFLOW_COMPLETED", { workflowId, finalStatus: "COMPLETED" });
    
    // For Phase 1, just return the collected raw clips and placeholder insights
    const finalResult = {
      pipeline: { status: runtimeState.status, steps: runtimeState.agent_execution_log },
      // FIX: Use editorial_intent directly as editorial_objective for consistency and robust field population
      editorial_objective: {
        topic: runtimeState.editorial_intent?.topic || inputContract.topic,
        creative_brief_summary: runtimeState.editorial_intent?.creative_brief_summary || inputContract.creativeBrief,
        // BUGFIX: this previously read `desired_clip_characteristics?.length_range` and
        // `?.pacing`, but EditorialIntentAgent's schema never produces fields with those
        // names (it produces min_duration_sec/max_duration_sec and content_tone instead),
        // so "Clip Length" and "Hook Style" on the report always showed "N/A" even when
        // the LLM generated real duration/tone data. Map to the actual schema fields.
        editorial_dna: (() => {
          const dcc = runtimeState.editorial_intent?.desired_clip_characteristics || {};
          const clipLength = (dcc.min_duration_sec != null && dcc.max_duration_sec != null)
            ? `${dcc.min_duration_sec}-${dcc.max_duration_sec}s`
            : 'N/A';
          return {
            clip_length: clipLength,
            hook_style: dcc.content_tone || 'N/A',
            emotion_focus: (runtimeState.editorial_intent?.target_emotions || []).join(', ') || 'N/A',
            source_preference: 'Original Clips'
          };
        })(),
        // BUGFIX: this previously read `global_constraints?.user_defined_constraints`,
        // but the frontend always sends that field as a hardcoded empty array — so this
        // section always displayed "No research constraints applied" even when real
        // constraints (date window, engagement level, etc.) were in fact applied to the
        // search. Build a human-readable list from the constraints that were actually used.
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
        // BUGFIX: previously ALL platforms' clips (YouTube + TikTok + Reddit) were dumped
        // into `youtube_clips` (a leftover from when only YouTube existed), while
        // tiktok_clips/reddit_posts/etc. were hardcoded to []. The frontend renders each
        // platform from its own dedicated field, so TikTok/Reddit tabs always showed
        // "No evidence found" even when clips were successfully collected. Bucket by the
        // `platform` field each clip already carries instead.
        const allClips = runtimeState.raw_clips_collected || [];
        const byPlatform = (name) => allClips.filter(c => (c.platform || "").trim().toLowerCase() === name);
        const youtube_clips = byPlatform("youtube");
        const tiktok_clips = byPlatform("tiktok");
        const reddit_posts = byPlatform("reddit");
        const instagram_reels = byPlatform("instagram");
        const facebook_posts = byPlatform("facebook");
        const telegram_clips = byPlatform("telegram");
        return {
          youtube_clips, tiktok_clips, reddit_posts, instagram_reels, facebook_posts, telegram_clips,
          total_youtube: youtube_clips.length,
          total_tiktok: tiktok_clips.length,
          total_reddit: reddit_posts.length,
          past_clips_from_memory: 0, // Not implemented in Phase 1
          platform_search_links: {} // Not fully implemented in Phase 1
        };
      })(),
      // FIX: this used to be 100% hardcoded placeholder text ("Phase 1: Basic insights
      // generated...", "Placeholder Hook 1", confidence_score: 75 for every clip) and
      // ranked_clip_opportunities was just the first 6 raw search results in whatever
      // order they came back — no actual AI curation happened. Now this uses the real,
      // LLM-generated ranking + reasoning produced by RankingAgent, with a safe fallback
      // in case that agent didn't run for some reason.
      ai_actionable_insights: runtimeState.ai_insights || {
        overall_opportunity_reasoning: "Ranking could not be generated for this run.",
        trend_status: "Unknown",
        hook_suggestions: [],
        hashtag_strategy: [],
        key_search_phrases_for_discoverability: [],
        seo_elements_for_upload: { title_insights: "", description_hook: "", tags_to_prioritize: [] },
        ranked_clip_opportunities: []
      },
      // FEATURE: previously always null. Now surfaces the structured Editorial DNA
      // profile extracted from REAL reference-channel videos by EditorialDNAExtractionAgent
      // (null if no reference channels were provided, or their real data couldn't be fetched).
      ref_channel_analysis: runtimeState.editorial_dna_profile,
      overall_confidence_score: capabilityRegistry.ConfidenceCalculationCapability.execute().score,
      explainability_trace_id: 'workflow_trace_1'
    };

    // Store final report in D1 if DB is configured
    if (env.DB) {
      capabilityRegistry.PersistenceCapability.execute("save", "final_report", {
        workflowId,
        report: finalResult,
        timestamp: new Date().toISOString()
      });
    }

    return finalResult;

  } catch (e) {
    console.error("Orchestration workflow failed:", e);
    return {
      pipeline: { status: "FAILED", steps: workflowStates[workflowId]?.agent_execution_log || [] },
      // Ensure error output also has expected structure
      editorial_objective: {
        topic: inputContract.topic,
        creative_brief_summary: inputContract.creativeBrief,
        editorial_dna: {}, // Placeholder for new architecture
        research_constraints_applied: inputContract.constraints || []
      },
      raw_evidence_found: null,
      ai_actionable_insights: null,
      ref_channel_analysis: null,
      error: "Workflow orchestration failed: " + e.message,
      overall_confidence_score: 0,
      explainability_trace_id: 'workflow_trace_fail_final'
    };
  } finally {
    // Clean up in-memory state after a while, or immediately if using persistent storage
    // For Phase 1, we keep it for immediate debugging. In real app, would have garbage collection.
  }
}

// -----------------------------------------------------------------------------
// WORKER FETCH HANDLER (API routes only — static index.html/CSS/JS are served
// automatically by Cloudflare Workers Assets via the `assets` binding in
// wrangler.jsonc; this fetch handler only needs to define the /api/* routes.)
// -----------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Status endpoint: tells the frontend which providers/bindings are configured
    // so it can auto-select a working AI provider and show binding health.
    if (url.pathname === "/api/status" && request.method === "GET") {
      return json({
        status: "ok",
        providers_configured: {
          cloudflare: Boolean(env.AI),
          openrouter: Boolean(env.OPENROUTER_API_KEY),
          google: Boolean(env.GEMINI_API_KEY),
          github: Boolean(env.GITHUB_MODELS_TOKEN),
          huggingface: Boolean(env.HF_TOKEN),
          cloudflare_account_id: Boolean(env.CLOUDFLARE_ACCOUNT_ID)
        },
        bindings: {
          ai: Boolean(env.AI),
          youtube: Boolean(env.YOUTUBE_API_KEY),
          apify: Boolean(env.APIFY_API_TOKEN),
          d1: Boolean(env.DB),
          r2: Boolean(env.MY_BUCKET),
          ai_search: Boolean(env.AI_SEARCH),
          media: Boolean(env.MEDIA),
          images: Boolean(env.IMAGES),
          stream: Boolean(env.STREAM),
        }
      });
    }

    // FEATURE: powers the 🎲 Dice button — CONTRACT §2 (Viral Opportunity).
    // Previously the Dice button picked a random string client-side with no AI
    // involved. This runs a real LLM call and returns a structured opportunity
    // (title/format/viewer_emotion_arc/search_strategy/reject), optionally informed
    // by a DNA profile the frontend already has in its session state.
    if (url.pathname === "/api/generate-opportunity" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { body = {}; }
      const { provider, model, dnaProfile } = body || {};
      try {
        const opportunity = await generateViralOpportunity(env, { provider, [provider]: model }, dnaProfile || null);
        return json(opportunity);
      } catch (e) {
        console.warn("generate-opportunity failed:", e.message);
        return json({ error: e.message }, 500);
      }
    }

    // Generic LLM call endpoint for any ad-hoc frontend use.
    if (url.pathname === "/api/complete" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
      const { prompt, provider, model, outputSchema } = body;
      if (!prompt || !provider || !model) {
        return json({ error: "Missing required fields: prompt, provider, or model" }, 400);
      }
      try {
        const llmService = capabilityRegistry.LLMServiceCapability;
        const { data, provider: usedProvider, model: usedModel } = await llmService.execute(
          prompt, outputSchema, { provider, [provider]: model }, env
        );
        return json({ text: JSON.stringify(data), provider_used: usedProvider, model_used: usedModel });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // Main entry point: runs the full agent pipeline end-to-end.
    if (url.pathname === "/api/generate-insights" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
      const { topic, creativeBrief, referenceChannels, provider, model, constraints } = body;
      if (!topic) return json({ error: "Missing required field: topic" }, 400);

      const workflowId = `workflow-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const inputContract = { topic, creativeBrief, referenceChannels, constraints, model_preference: { provider, [provider]: model } };

      try {
        const result = await orchestrate(workflowId, inputContract, env);
        return json(result);
      } catch (e) {
        console.error("Workflow orchestration failed:", e);
        return json({
          pipeline: { status: "FAILED", steps: workflowStates[workflowId]?.agent_execution_log || [] },
          editorial_objective: {
            topic: inputContract.topic,
            creative_brief_summary: inputContract.creativeBrief,
            editorial_dna: {},
            research_constraints_applied: []
          },
          raw_evidence_found: null,
          ai_actionable_insights: null,
          ref_channel_analysis: null,
          error: "Workflow orchestration failed: " + e.message,
          overall_confidence_score: 0,
          explainability_trace_id: 'workflow_trace_fail_final'
        }, 200); // Return 200 so the frontend can parse and display the error nicely
      }
    }

    // Legacy history endpoint.
    if (url.pathname === "/api/history" && request.method === "GET") {
      if (!env.DB) return json({ history: [] });
      try {
        const result = await env.DB.prepare("SELECT topic, created_at FROM research_history ORDER BY created_at DESC LIMIT 10").all();
        return json({ history: result.results || [] });
      } catch (e) {
        console.warn("D1 history fetch failed:", e.message);
        return json({ history: [] });
      }
    }

    // FIX: previously "/" served an HTML page built by concatenating a giant JS
    // template literal (HTML_STYLES + HTML_CONTENT) that *embedded a second,
    // client-side <script> block inside itself*. Because the whole thing was one
    // template literal, every `${...}` inside the embedded client-side script was
    // evaluated immediately, server-side, at HTML-generation time — not deferred to
    // the browser. Any `${...}` referencing client-only variables (state, item, m,
    // clip, etc.) would throw a ReferenceError server-side. The frontend is now a
    // real standalone index.html file (see repo root), served as a static asset by
    // Cloudflare Workers Assets automatically — this Worker no longer needs to (and
    // must not try to) generate HTML at all. Any GET request that isn't one of the
    // /api/* routes above and isn't matched by a static file falls through here.
    return json({ error: "Not found" }, 404);
  },
};
