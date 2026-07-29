// Viral Radar — Combined Cloudflare Worker (plain, dependency-free) for API serving.
//
// PATCHED — see "// FIX:" comments throughout. Summary of what was wrong:
//
// 1) [ROOT CAUSE — nothing ever produced results] EditorialIntentAgent.execute()
//    started with `if (!state.viral_opportunity) { ...error...; return; }` — but
//    viral_opportunity is exactly what THIS agent is supposed to create. It was
//    copy-pasted from DiscoveryStrategyPlannerAgent (where that check makes
//    sense, since that agent depends on EditorialIntentAgent's output). Because
//    viral_opportunity starts as null and nothing sets it earlier, this agent
//    always bailed out immediately — which then cascaded: DiscoveryStrategy-
//    PlannerAgent also bailed (same check, still null), so discovery_missions
//    was never set, so SourceHunterAgent bailed ("No discovery missions"), so
//    raw_clips_collected stayed empty, so RankingAgent had nothing to rank.
//    Every single run silently produced an almost-empty result, with no
//    exception thrown anywhere to signal it. This is very likely why the app
//    "worked" (returned 200 OK) but never actually returned anything useful.
// 2) [DEPLOY-BLOCKING] Whatever actually got deployed as src/index.js was not
//    valid JavaScript — the build log shows it starting with a stray,
//    unterminated fragment (`...memory_store(key='...', value='''`) that isn't
//    present anywhere in the source pasted here. That's not a logic bug to fix
//    in this file — it means the wrong thing got saved into the repo. Replace
//    the ENTIRE contents of src/index.js with this file, starting at `import`.
// 3) [CRITICAL] No CORS handling at all. index.html is hosted on a different
//    origin (GitHub Pages / raw GitHub), so without CORS headers the browser
//    blocks every response before your JS ever sees it — including the status
//    check. Added CORS headers to every response + an OPTIONS preflight
//    handler (see the CORS constant and json() helper, and the OPTIONS check
//    in the fetch handler at the bottom).
// 4) [CRITICAL] state.addWarn(...) is called in 3 places but was never defined
//    on RuntimeState. In RankingAgent's main ranking loop this call sits
//    outside any try/catch, so the resulting TypeError propagated all the way
//    up and the orchestrator re-threw it — aborting the ENTIRE workflow any
//    time the LLM returned even one imperfectly-shaped ranked clip (missing a
//    rubric field, etc.), which is common. Added the missing method.
// 5) fetchRecentVideosForChannel()'s stats loop wrote to an undefined `clip`
//    variable (copy-pasted from search(), where the loop variable actually is
//    named `clip`) instead of `video` — guaranteed ReferenceError, breaking
//    reference-channel DNA extraction whenever a channel had videos.
// 6) cleanJson() only took its "already a clean array" fast path when the
//    ENTIRE trimmed string started with '[' — a ```json fence or any preamble
//    text defeated that check, falling through to the object-first branch,
//    which then stripped from the array's first element's '{' to the last
//    '}', discarding the enclosing [ ] and leaving invalid, comma-separated
//    JSON. Now fences are stripped first, and whichever root (object or
//    array) actually starts first is used.
// 7) The frontend sends { referenceChannels, provider, model }, but this
//    handler read { reference_channels, llm_provider } — so reference
//    channels and the provider dropdown were both silently ignored. On top of
//    that, none of the agents ever passed provider/model into their LLM
//    calls at all, so every request used the hardcoded default regardless.
//    Both are fixed: field names now match the frontend, and provider/model
//    are threaded through to every LLM call.
// 8) The response shape didn't match what index.html renders (no
//    editorial_objective wrapper, ranked_clip_opportunities at the top level
//    instead of inside ai_actionable_insights, discoverability_phrases vs.
//    key_search_phrases_for_discoverability, no seo_elements_for_upload,
//    evidence items missing thumbnail_url/views_approx/etc). Added a small
//    adapter at the end of the /api/generate-insights handler so the JSON
//    matches index.html's existing contract exactly, without touching the
//    frontend.
// 9) No timeouts anywhere on external calls (LLM providers, YouTube, Apify) —
//    one slow/hung call could stall the whole request until Cloudflare killed
//    it, truncating the response ("Unexpected end of JSON input" client-side).
//    Added bounded timeouts to every external call.
// 10) Removed the Hono framework entirely (see note further down) — it was
//    the direct cause of the last deploy failure ("Could not resolve 'hono'":
//    the package was never added to package.json) and wasn't needed for an
//    app with only 3 routes. This version has zero npm dependencies.

// FIX (per user request): reverted from Hono back to a plain, dependency-free
// Cloudflare Worker. Hono itself wasn't the cause of any logic bug, but it was
// an unnecessary external dependency for an app with only 3 routes — and it's
// exactly what caused the last deploy failure ("Could not resolve 'hono'"),
// because whatever generated this file never added hono to package.json.
// A plain Worker has zero npm dependencies, so that whole class of failure
// (missing/misconfigured packages) simply cannot happen here again. Static
// index.html serving (Hono's serveStatic) is dropped too, matching how this
// app has worked the whole time: index.html stays hosted separately (GitHub),
// this Worker is API-only.

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

function json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

// --- Constants and Utilities ---
const DEFAULT_PROVIDER = 'cloudflare';
const MAX_SEARCH_RESULTS_PER_PLATFORM = 10;
const MAX_RANKED_CLIPS = 6;
const LLM_CALL_TIMEOUT_MS = 20000;   // FIX #9: LLM completions should be fast; fail over quickly if not.
const SEARCH_CALL_TIMEOUT_MS = 45000; // FIX #9: scraper/search calls legitimately take longer.

function withTimeout(promise, ms, label) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// FIX #6: strip ```json fences first, then pick whichever root (object or
// array) actually starts first, instead of always preferring '{' unless the
// WHOLE string happened to start with '['.
function cleanJson(jsonString) {
    if (!jsonString) return '';

    let cleanedString = jsonString.trim()
        .replace(/^```json/i, '')
        .replace(/^```/, '')
        .replace(/```$/, '')
        .trim();

    const firstBrace = cleanedString.indexOf('{');
    const firstBracket = cleanedString.indexOf('[');

    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        const lastBracket = cleanedString.lastIndexOf(']');
        if (lastBracket > firstBracket) return cleanedString.substring(firstBracket, lastBracket + 1);
    }
    if (firstBrace !== -1) {
        const lastBrace = cleanedString.lastIndexOf('}');
        if (lastBrace > firstBrace) return cleanedString.substring(firstBrace, lastBrace + 1);
    }

    return '';
}

function coerceToArray(data) {
    if (Array.isArray(data)) {
        return data;
    }
    if (typeof data === 'object' && data !== null) {
        if (data.items && Array.isArray(data.items)) return data.items;
        if (data.list && Array.isArray(data.list)) return data.list;
        if (data.results && Array.isArray(data.results)) return data.results;
        if (data.missions && Array.isArray(data.missions)) return data.missions;
        if (data.opportunities && Array.isArray(data.opportunities)) return data.opportunities;
        if (data.clips && Array.isArray(data.clips)) return data.clips;
        if (Object.keys(data).length > 0) return [data];
    }
    return [];
}

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hostname = u.hostname.replace(/^www\./, '');
        u.searchParams.sort();
        return u.toString();
    } catch (e) {
        return url;
    }
}

function getYouTubeVideoId(url) {
    try {
        const regExp = /(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regExp);
        return (match && match[1]) ? match[1] : null;
    } catch (e) {
        return null;
    }
}


// --- LLM & AI Core ---
class LLMRouter {
    constructor(env) {
        this.env = env;
        this.providers = {
            cloudflare: { name: 'Cloudflare Workers AI', models: ['@cf/meta/llama-3.1-8b-instruct-fast-4k', '@cf/mistral/mistral-7b-instruct-v0.2', '@cf/llama/llama-2-7b-chat-int8'] },
            openrouter: {
                name: 'OpenRouter',
                models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro'],
                apiKey: env.OPENROUTER_API_KEY
            },
            google: {
                name: 'Google Gemini',
                models: ['gemini-pro'],
                apiKey: env.GEMINI_API_KEY
            },
            github: {
                name: 'GitHub Copilot API',
                models: ['copilot-gpt-4'],
                apiKey: env.GITHUB_MODELS_TOKEN
            },
            huggingface: {
                name: 'HuggingFace Inference API',
                models: ['HuggingFaceH4/zephyr-7b-beta', 'mistralai/Mistral-7B-Instruct-v0.2'],
                apiKey: env.HF_TOKEN
            }
        };
    }

    async route(prompt, options = {}) {
        let selectedProvider = options.provider || DEFAULT_PROVIDER;
        let selectedModels = options.models || this.providers[selectedProvider]?.models;
        if (!selectedModels || selectedModels.length === 0) {
            console.warn(`No models specified or found for provider: ${selectedProvider}. Falling back to Cloudflare.`);
            selectedProvider = 'cloudflare';
            selectedModels = this.providers.cloudflare.models;
        }

        // FIX #7: try a specific requested model (e.g. from the UI dropdown)
        // first, before this provider's other default models.
        let modelsToTry = selectedModels.slice();
        if (options.model && !modelsToTry.includes(options.model)) {
            modelsToTry = [options.model, ...modelsToTry];
        }

        while (modelsToTry.length > 0) {
            const model = modelsToTry.shift();
            try {
                const result = await this._callProvider(selectedProvider, model, prompt, options.jsonMode);
                return { provider: selectedProvider, model, result };
            } catch (error) {
                console.warn(`LLM call failed for ${selectedProvider}/${model}: ${error.message}`);
                if (modelsToTry.length === 0) {
                    if (selectedProvider !== 'cloudflare') {
                        console.warn(`All models for ${selectedProvider} failed. Attempting fallback to Cloudflare AI.`);
                        selectedProvider = 'cloudflare';
                        selectedModels = this.providers.cloudflare.models;
                        modelsToTry.push(...selectedModels);
                    } else {
                        throw new Error(`All configured LLM providers and models failed after multiple retries. Last error: ${error.message}`);
                    }
                }
            }
        }
        throw new Error('Could not get a successful response from any LLM.');
    }

    async _callProvider(provider, model, prompt, jsonMode = false) {
        switch (provider) {
            case 'cloudflare':
                return this._callCloudflareAI(model, prompt, jsonMode);
            case 'openrouter':
                return this._callOpenRouter(model, prompt, jsonMode);
            case 'google':
                return this._callGoogleGemini(model, prompt, jsonMode);
            case 'github':
                return this._callGitHubCopilot(model, prompt, jsonMode);
            case 'huggingface':
                return this._callHuggingFace(model, prompt, jsonMode);
            default:
                throw new Error(`Unsupported LLM provider: ${provider}`);
        }
    }

    async _callCloudflareAI(model, prompt, jsonMode) {
        if (!this.env.AI) {
            throw new Error('Cloudflare AI binding not found. Ensure AI is configured in wrangler.toml');
        }
        const response = await withTimeout(this.env.AI.run(model, {
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            json_mode: jsonMode,
        }), LLM_CALL_TIMEOUT_MS, `Cloudflare AI (${model})`);
        if (jsonMode) {
            let output = response.response || response.output;
            if (typeof output === 'string') {
                const cleaned = cleanJson(output);
                if (cleaned) {
                    try {
                        return JSON.parse(cleaned);
                    } catch (e) {
                        console.warn('JSON parsing failed from Cloudflare AI (after cleaning):', e);
                        throw new Error('Failed to parse JSON from Cloudflare AI response');
                    }
                }
            }
            if (typeof output === 'object') return output;
            throw new Error('Failed to get valid JSON from Cloudflare AI response');
        }
        return response.response;
    }

    async _callOpenRouter(model, prompt, jsonMode) {
        if (!this.env.OPENROUTER_API_KEY) {
            throw new Error('OPENROUTER_API_KEY not set.');
        }
        const headers = {
            'Authorization': `Bearer ${this.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://viral-discovery.fasterwgseverkh.workers.dev',
            'X-Title': 'Viral Radar Internal Worker',
        };
        const body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: headers,
            body: body,
            signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`OpenRouter API failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const llmResponse = data.choices[0]?.message?.content;

        if (!llmResponse) {
            throw new Error('OpenRouter response missing content.');
        }

        if (jsonMode) {
            const cleaned = cleanJson(llmResponse);
            if (cleaned) {
                try {
                    return JSON.parse(cleaned);
                } catch (e) {
                    console.warn('JSON parsing failed from OpenRouter (after cleaning):', e);
                    throw new Error('Failed to parse JSON from OpenRouter response');
                }
            }
            throw new Error('Failed to get valid JSON from OpenRouter response');
        }
        return llmResponse;
    }

    async _callGoogleGemini(model, prompt, jsonMode) {
        if (!this.env.GEMINI_API_KEY) {
            throw new Error('GEMINI_API_KEY not set.');
        }
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.env.GEMINI_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: jsonMode ? "application/json" : "text/plain",
                }
            }),
            signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Google Gemini API failed: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const llmResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!llmResponse) {
            throw new Error('Google Gemini response missing content.');
        }

        if (jsonMode) {
            try {
                return JSON.parse(llmResponse);
            } catch (e) {
                console.warn('JSON parsing failed from Google Gemini:', e);
                throw new Error('Failed to parse JSON from Google Gemini response');
            }
        }
        return llmResponse;
    }

    async _callGitHubCopilot(model, prompt, jsonMode) {
        if (!this.env.GITHUB_MODELS_TOKEN) {
            throw new Error('GITHUB_MODELS_TOKEN not set for GitHub Copilot API.');
        }
        throw new Error('GitHub Copilot API not fully implemented yet.');
    }

    async _callHuggingFace(model, prompt, jsonMode) {
        if (!this.env.HF_TOKEN) {
            throw new Error('HF_TOKEN not set for HuggingFace Inference API.');
        }
        throw new Error('HuggingFace Inference API not fully implemented yet.');
    }
}

// --- Search Capabilities ---
class YouTubeSearchCapability {
    constructor(env) {
        this.env = env;
    }

    async search(query, maxResults = MAX_SEARCH_RESULTS_PER_PLATFORM) {
        if (!this.env.YOUTUBE_API_KEY) {
            console.warn('YOUTUBE_API_KEY is not set. Skipping YouTube search.');
            return { platform: 'YouTube', results: [], error: 'YOUTUBE_API_KEY_MISSING' };
        }

        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&key=${this.env.YOUTUBE_API_KEY}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
            console.error('YouTube API error:', error);
            throw new Error(`YouTube API failed: ${response.status} - ${error.error?.message}`);
        }
        const data = await response.json();

        const clips = data.items.map(item => ({
            id: item.id.videoId,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            title: item.snippet.title,
            description: item.snippet.description,
            thumbnail: item.snippet.thumbnails.high.url,
            platform: 'YouTube',
            publishedAt: item.snippet.publishedAt,
            channelTitle: item.snippet.channelTitle,
            channelId: item.snippet.channelId,
        }));

        if (clips.length > 0) {
            const videoIds = clips.map(clip => clip.id).join(',');
            const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${this.env.YOUTUBE_API_KEY}`;
            const statsResponse = await fetch(statsUrl, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
            if (statsResponse.ok) {
                const statsData = await statsResponse.json();
                statsData.items.forEach(statItem => {
                    const clip = clips.find(c => c.id === statItem.id);
                    if (clip) {
                        clip.views = parseInt(statItem.statistics.viewCount || 0);
                        clip.likes = parseInt(statItem.statistics.likeCount || 0);
                        clip.commentCount = parseInt(statItem.statistics.commentCount || 0);
                        clip.favoriteCount = parseInt(statItem.statistics.favoriteCount || 0);
                    }
                });
            } else {
                console.warn('Failed to fetch YouTube video statistics:', statsResponse.status);
            }
        }

        return { platform: 'YouTube', results: clips };
    }

    async fetchRecentVideosForChannel(channelId, maxResults = 12) {
        if (!this.env.YOUTUBE_API_KEY) {
            console.warn('YOUTUBE_API_KEY is not set. Skipping YouTube channel video fetch.');
            return [];
        }

        const channelDetailsUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${this.env.YOUTUBE_API_KEY}`;
        const channelDetailsResponse = await fetch(channelDetailsUrl, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
        if (!channelDetailsResponse.ok) {
            const error = await channelDetailsResponse.json().catch(() => ({}));
            console.error(`YouTube API error fetching channel details for ${channelId}:`, error);
            return [];
        }
        const channelDetailsData = await channelDetailsResponse.json();
        const uploadsPlaylistId = channelDetailsData.items[0]?.contentDetails?.relatedPlaylists?.uploads;

        if (!uploadsPlaylistId) {
            console.warn(`Could not find uploads playlist for channel ID: ${channelId}`);
            return [];
        }

        const playlistItemsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${this.env.YOUTUBE_API_KEY}`;
        const playlistItemsResponse = await fetch(playlistItemsUrl, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
        if (!playlistItemsResponse.ok) {
            const error = await playlistItemsResponse.json().catch(() => ({}));
            console.error(`YouTube API error fetching playlist items for ${uploadsPlaylistId}:`, error);
            return [];
        }
        const playlistItemsData = await playlistItemsResponse.json();

        const videos = playlistItemsData.items.map(item => ({
            id: item.snippet.resourceId.videoId,
            title: item.snippet.title,
            description: item.snippet.description,
            publishedAt: item.snippet.publishedAt,
            thumbnail: item.snippet.thumbnails?.high?.url,
            platform: 'YouTube',
            url: `https://www.youtube.com/watch?v=${item.snippet.resourceId.videoId}`
        }));

        if (videos.length > 0) {
            const videoIds = videos.map(video => video.id).join(',');
            const contentDetailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${this.env.YOUTUBE_API_KEY}`;
            const contentDetailsResponse = await fetch(contentDetailsUrl, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
            if (contentDetailsResponse.ok) {
                const contentDetailsData = await contentDetailsResponse.json();
                contentDetailsData.items.forEach(videoDetail => {
                    const video = videos.find(v => v.id === videoDetail.id);
                    if (video) {
                        const duration = videoDetail.contentDetails.duration;
                        const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
                        if (match) {
                            const hours = parseInt(match[1] || 0);
                            const minutes = parseInt(match[2] || 0);
                            const seconds = parseInt(match[3] || 0);
                            video.duration_sec = hours * 3600 + minutes * 60 + seconds;
                        } else {
                            video.duration_sec = 0;
                        }
                    }
                });
            } else {
                console.warn('Failed to fetch YouTube video content details:', contentDetailsResponse.status);
            }
        }

        if (videos.length > 0) {
            const videoIds = videos.map(video => video.id).join(',');
            const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${this.env.YOUTUBE_API_KEY}`;
            const statsResponse = await fetch(statsUrl, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
            if (statsResponse.ok) {
                const statsData = await statsResponse.json();
                statsData.items.forEach(statItem => {
                    const video = videos.find(v => v.id === statItem.id);
                    // FIX #5: was `clip.views = ...` (undefined variable) — now
                    // correctly writes to `video`, the loop's matched item.
                    if (video) {
                        video.views = parseInt(statItem.statistics.viewCount || 0);
                        video.likes = parseInt(statItem.statistics.likeCount || 0);
                        video.commentCount = parseInt(statItem.statistics.commentCount || 0);
                    }
                });
            } else {
                console.warn('Failed to fetch YouTube video statistics (for channel videos):', statsResponse.status);
            }
        }

        return videos;
    }

    async getChannelIdFromHandle(handle) {
        if (!this.env.YOUTUBE_API_KEY) {
            console.warn('YOUTUBE_API_KEY is not set. Cannot get channel ID from handle.');
            return null;
        }
        if (!handle.startsWith('@')) {
            return handle;
        }
        const username = handle.substring(1);

        const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(username)}&key=${this.env.YOUTUBE_API_KEY}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS) });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            console.error(`YouTube API error fetching channel ID for handle ${handle}:`, error);
            return null;
        }
        const data = await response.json();
        return data.items[0]?.id || null;
    }
}

class ApifySearchCapability {
    constructor(env) {
        this.env = env;
        this.tiktokActorId = 'clockworks/tiktok-scraper';
        this.redditActorId = 'solidcode/reddit-scraper';
        this.apifyApiBase = 'https://api.apify.com/v2/actors/';
    }

    async _callApifyActor(actorId, input, platformName) {
        if (!this.env.APIFY_API_TOKEN) {
            console.warn(`APIFY_API_TOKEN is not set. Skipping ${platformName} search.`);
            return { platform: platformName, results: [], error: 'APIFY_API_TOKEN_MISSING' };
        }

        const url = `${this.apifyApiBase}${actorId}/run-sync-get-dataset-items?token=${this.env.APIFY_API_TOKEN}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(SEARCH_CALL_TIMEOUT_MS),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.warn(`${platformName} (Apify) search failed: ${response.status} ${errorBody}`);
            return { platform: platformName, results: [], error: `${response.status} ${errorBody}` };
        }

        const data = await response.json();
        return { platform: platformName, results: data };
    }

    async searchTikTok(query, maxResults = MAX_SEARCH_RESULTS_PER_PLATFORM) {
        const input = {
            searchQueries: [query],
            resultsPerPage: maxResults,
            searchSection: "/video",
        };
        const { results, error } = await this._callApifyActor(this.tiktokActorId, input, 'TikTok');
        if (error) return { platform: 'TikTok', results: [], error };

        return {
            platform: 'TikTok',
            results: results.map(item => ({
                id: item.id,
                url: item.webVideoUrl || `https://www.tiktok.com/@${item.authorMeta?.name}/video/${item.id}`,
                title: item.text,
                description: item.text,
                thumbnail: item.videoMeta?.cover,
                platform: 'TikTok',
                author: item.authorMeta?.name,
                views: item.playCount,
                likes: item.diggCount,
                commentCount: item.commentCount,
                shareCount: item.shareCount,
                createTimeISO: item.createTimeISO,
            }))
        };
    }

    async searchReddit(query, maxResults = MAX_SEARCH_RESULTS_PER_PLATFORM) {
        const input = {
            searchQuery: query,
            limit: maxResults,
        };
        const { results, error } = await this._callApifyActor(this.redditActorId, input, 'Reddit');
        if (error) return { platform: 'Reddit', results: [], error };

        return {
            platform: 'Reddit',
            results: results.map(item => ({
                id: item.id,
                url: item.url || (item.permalink ? `https://www.reddit.com${item.permalink}` : null),
                title: item.title,
                description: item.selftext || item.title,
                thumbnail: item.thumbnail,
                platform: 'Reddit',
                author: item.author,
                views: item.score,
                likes: item.ups,
                commentCount: item.num_comments,
                subreddit: item.subreddit,
                createdUtc: item.created_utc,
            }))
        };
    }
}


class SearchExecutionCapability {
    constructor(env) {
        this.youtube = new YouTubeSearchCapability(env);
        this.apify = new ApifySearchCapability(env);
    }

    async execute(searchQueries) {
        const allResults = [];
        const searchPromises = [];

        for (const query of searchQueries) {
            searchPromises.push(this.youtube.search(query));
            searchPromises.push(this.apify.searchTikTok(query));
            searchPromises.push(this.apify.searchReddit(query));
        }

        const rawResults = await Promise.allSettled(searchPromises);

        for (const result of rawResults) {
            if (result.status === 'fulfilled') {
                allResults.push(...result.value.results);
                if (result.value.error) {
                    console.warn(`Search capability for ${result.value.platform} reported an error: ${result.value.error}`);
                }
            } else {
                console.error('A search capability failed:', result.reason);
            }
        }

        return allResults;
    }
}

// --- Agent Orchestration ---
class RuntimeState {
    constructor(topic) {
        this.topic = topic;
        this.raw_clips_collected = [];
        this.editorial_dna = null;
        this.viral_opportunity = null;
        this.discovery_missions = []; // FIX: explicitly initialized (was previously undefined until set)
        this.ranked_clip_opportunities = [];
        this.ai_actionable_insights = {};
        this.ref_channel_analysis = [];
        this.summary_report = '';
        this.status_messages = [];
        this.error_messages = [];
        this.processed_at = new Date().toISOString();
    }

    addStatus(message) {
        this.status_messages.push(`[${new Date().toISOString()}] ${message}`);
        console.log(`Status: ${message}`);
    }

    // FIX #4: this was called in 3 places but never defined — added it.
    addWarn(message) {
        this.status_messages.push(`[${new Date().toISOString()}] WARN: ${message}`);
        console.warn(`Warn: ${message}`);
    }

    addError(message, errorDetails = null) {
        const fullMessage = `[${new Date().toISOString()}] ERROR: ${message}`;
        this.error_messages.push(fullMessage);
        console.error(fullMessage, errorDetails);
    }

    addClips(clips) {
        this.raw_clips_collected.push(...clips);
        this.addStatus(`Collected ${clips.length} clips.`);
    }

    setEditorialDNA(dna) {
        this.editorial_dna = dna;
        this.addStatus('Editorial DNA profile extracted.');
    }

    setViralOpportunity(opportunity) {
        this.viral_opportunity = opportunity;
        this.addStatus('Viral opportunity insights generated.');
    }

    setRankedClipOpportunities(rankedClips) {
        this.ranked_clip_opportunities = rankedClips;
        this.addStatus(`Generated ${rankedClips.length} ranked clip opportunities.`);
    }

    setAIActionableInsights(insights) {
        this.ai_actionable_insights = insights;
        this.addStatus('AI actionable insights generated.');
    }

    addRefChannelAnalysis(analysis) {
        this.ref_channel_analysis.push(analysis);
        this.addStatus(`Analyzed reference channel: ${analysis.channel_name}`);
    }
}

// --- Agents ---

class EditorialDNAExtractionAgent {
    constructor(llm, youtubeSearch) {
        this.llm = llm;
        this.youtubeSearch = youtubeSearch;
        this.name = 'EditorialDNAExtractionAgent';
    }

    async execute(state, params = {}) {
        state.addStatus(`${this.name}: Extracting editorial DNA from reference channels...`);
        const referenceChannels = params.referenceChannels || [];
        if (referenceChannels.length === 0) {
            state.addStatus(`${this.name}: No reference channels provided. Skipping DNA extraction.`);
            return;
        }

        const dnaProfiles = [];
        const channelPromises = referenceChannels.map(async ref => {
            try {
                const channelId = await this.youtubeSearch.getChannelIdFromHandle(ref.handle);
                if (!channelId) {
                    state.addError(`${this.name}: Could not find channel ID for handle: ${ref.handle}`);
                    return null;
                }

                const recentVideos = await this.youtubeSearch.fetchRecentVideosForChannel(channelId);
                if (recentVideos.length === 0) {
                    state.addWarn(`${this.name}: No recent videos found for channel: ${ref.handle}`);
                    return null;
                }

                const videoDataForLLM = recentVideos.map(v => ({
                    title: v.title,
                    description: v.description,
                    duration_sec: v.duration_sec,
                    views: v.views
                }));

                const prompt = `
                You are an expert content strategist analyzing successful viral video channels.
                Analyze the following recent video data from the YouTube channel "${ref.handle}" and extract its core Editorial DNA Profile.
                Provide a structured JSON output with the following fields, based on the provided contract:

                \`\`\`json
                {
                  "content_type": "string",
                  "clip_type": "string",
                  "preferred_emotions": "list[string]",
                  "clip_length_range": {
                    "min_sec": "integer",
                    "max_sec": "integer"
                  },
                  "editing_pattern": "string",
                  "source_platforms": "list[string]",
                  "reject_list": "list[string]"
                }
                \`\`\`

                Recent videos from channel "${ref.handle}":
                ${JSON.stringify(videoDataForLLM, null, 2)}

                Ensure your output is valid JSON.
                `;

                const llmResponse = await this.llm.route(prompt, { jsonMode: true, ...params.llmOptions });
                const dna = llmResponse.result;

                if (!dna || Object.keys(dna).length === 0) {
                    state.addError(`${this.name}: LLM failed to extract DNA for ${ref.handle}`);
                    return null;
                }
                dnaProfiles.push(dna);
                state.addRefChannelAnalysis({
                    channel_name: ref.handle,
                    channel_id: channelId,
                    videos_analyzed: recentVideos.length,
                    dna_profile: dna
                });
                return dna;
            } catch (error) {
                state.addError(`${this.name}: Error processing channel ${ref.handle}: ${error.message}`, error);
                return null;
            }
        });

        const results = await Promise.all(channelPromises);
        const validDna = results.filter(d => d !== null);

        if (validDna.length > 0) {
            const combinedDna = validDna[0];
            state.setEditorialDNA(combinedDna);
        } else {
            state.addStatus(`${this.name}: No valid Editorial DNA could be extracted.`);
        }
    }
}


class EditorialIntentAgent {
    constructor(llm) {
        this.llm = llm;
        this.name = 'EditorialIntentAgent';
    }

    async execute(state, params = {}) {
        state.addStatus(`${this.name}: Generating editorial intent...`);

        // FIX #1: REMOVED the incorrect `if (!state.viral_opportunity) return;`
        // guard that used to be here. This agent is the one that CREATES
        // viral_opportunity (via state.setViralOpportunity below) — it was
        // copy-pasted from DiscoveryStrategyPlannerAgent, where checking for
        // viral_opportunity makes sense. Here it made this agent (and
        // therefore the entire pipeline after it) bail out on every run.

        const prompt = `
        You are an AI content strategist. Analyze the user's topic and optionally the extracted Editorial DNA, then generate actionable editorial insights.
        Your goal is to define the core "viral opportunity" for a content creator.
        
        Topic: "${state.topic}"
        ${state.editorial_dna ? `
        Reference Channel Editorial DNA:
        ${JSON.stringify(state.editorial_dna, null, 2)}
        ` : ''}

        Provide a structured JSON output with the following fields, based on the provided contract:

        \`\`\`json
        {
          "overall_opportunity_reasoning": "string",
          "trend_status": "string",
          "hook_suggestions": "list[string]",
          "hashtag_strategy": "list[string]",
          "discoverability_phrases": "list[string]",
          "acceptable_event_types": "list[string]",
          "reject_content_types": "list[string]"
        }
        \`\`\`

        Ensure your output is valid JSON.
        `;

        try {
            const llmResponse = await this.llm.route(prompt, { jsonMode: true, ...params.llmOptions });
            const opportunity = llmResponse.result;

            if (opportunity) {
                state.setViralOpportunity(opportunity);
                state.setAIActionableInsights(opportunity);
            } else {
                state.addError(`${this.name}: LLM returned empty opportunity.`, llmResponse);
            }
        } catch (error) {
            state.addError(`${this.name}: Failed to generate editorial intent: ${error.message}`, error);
        }
    }
}


class DiscoveryStrategyPlannerAgent {
    constructor(llm) {
        this.llm = llm;
        this.name = 'DiscoveryStrategyPlannerAgent';
    }

    async execute(state, params = {}) {
        state.addStatus(`${this.name}: Planning discovery strategy...`);

        if (!state.viral_opportunity) {
            state.addError(`${this.name}: Viral opportunity not set. Cannot plan discovery strategy.`);
            state.discovery_missions = [`${state.topic} short clips`]; // FIX: still leave a usable fallback instead of nothing
            return;
        }

        const prompt = `
        You are an AI specialized in crafting search queries for viral content discovery.
        Based on the following topic and editorial insights, generate a list of targeted search queries.
        Focus on finding original, short, single-moment clips that fit the acceptable event types and avoid the rejected content types.
        
        Topic: "${state.topic}"
        Editorial Insights:
        ${JSON.stringify(state.viral_opportunity, null, 2)}

        Generate 3-5 highly effective search queries. Avoid using generic terms that would return compilations or long-form content.
        Focus on actual event descriptions (from acceptable_event_types) combined with keywords like "short", "clip", "moment", "real".

        Provide a JSON array of strings (search queries).
        \`\`\`json
        [
          "query 1",
          "query 2",
          "query 3"
        ]
        \`\`\`

        Ensure your output is a valid JSON array.
        `;

        try {
            const llmResponse = await this.llm.route(prompt, { jsonMode: true, ...params.llmOptions });
            const discoveryMissions = coerceToArray(llmResponse.result);

            if (discoveryMissions && discoveryMissions.length > 0) {
                const uniqueMissions = Array.from(new Set(discoveryMissions));
                state.addStatus(`${this.name}: Generated ${uniqueMissions.length} discovery missions.`);
                state.discovery_missions = uniqueMissions;
                state.setAIActionableInsights({
                    ...state.ai_actionable_insights,
                    discovery_missions: uniqueMissions
                });
            } else {
                state.addError(`${this.name}: LLM failed to generate discovery missions.`, llmResponse);
                state.discovery_missions = [`${state.topic} short clips`];
            }
        } catch (error) {
            state.addError(`${this.name}: Failed to plan discovery strategy: ${error.message}`, error);
            state.discovery_missions = [`${state.topic} viral clips`];
        }
    }
}

// Shared by SourceHunterAgent and RankingAgent's fallback path.
function looksLikeCompilationOrRanking(clip, editorialDNA, viralOpportunity) {
    const title = (clip.title || '').toLowerCase();
    const description = (clip.description || '').toLowerCase();

    const NO_COMPILATION_KEYWORDS = ["compilation", "best of", "top 10", "epic moments", "funny moments", "fails", "tribute", "highlights", "mashup", "recap"];
    const NO_RANKING_KEYWORDS = ["rank", "#1", "worst", "best", "countdown", "vs", "review"];

    if (NO_COMPILATION_KEYWORDS.some(keyword => title.includes(keyword) || description.includes(keyword))) {
        return true;
    }
    if (NO_RANKING_KEYWORDS.some(keyword => title.includes(keyword) || description.includes(keyword))) {
        return true;
    }
    if (editorialDNA?.reject_list && editorialDNA.reject_list.length > 0) {
        if (editorialDNA.reject_list.some(keyword => title.includes(keyword.toLowerCase()) || description.includes(keyword.toLowerCase()))) {
            return true;
        }
    }
    if (viralOpportunity?.reject_content_types && viralOpportunity.reject_content_types.length > 0) {
         if (viralOpportunity.reject_content_types.some(keyword => title.includes(keyword.toLowerCase()) || description.includes(keyword.toLowerCase()))) {
            return true;
        }
    }
    return false;
}

class SourceHunterAgent {
    constructor(llm, searchCapability) {
        this.llm = llm;
        this.searchCapability = searchCapability;
        this.name = 'SourceHunterAgent';
    }

    async execute(state) {
        state.addStatus(`${this.name}: Hunting for source clips...`);
        if (!state.discovery_missions || state.discovery_missions.length === 0) {
            state.addError(`${this.name}: No discovery missions available.`);
            return;
        }

        const rawClips = await this.searchCapability.execute(state.discovery_missions);

        const filteredClips = rawClips.filter(clip => {
            if (looksLikeCompilationOrRanking(clip, state.editorial_dna, state.viral_opportunity)) {
                return false;
            }
            if (state.editorial_dna?.clip_length_range) {
                const { min_sec, max_sec } = state.editorial_dna.clip_length_range;
                if (clip.duration_sec && (clip.duration_sec < min_sec || clip.duration_sec > max_sec)) {
                    return false;
                }
            }
            return true;
        });

        state.addClips(filteredClips);
        state.addStatus(`${this.name}: Found and filtered ${filteredClips.length} potential source clips.`);
    }
}


class RankingAgent {
    constructor(llm) {
        this.llm = llm;
        this.name = 'RankingAgent';
    }

    async execute(state, params = {}) {
        state.addStatus(`${this.name}: Ranking clip opportunities...`);
        if (!state.raw_clips_collected || state.raw_clips_collected.length === 0) {
            state.addStatus(`${this.name}: No raw clips to rank.`);
            state.setRankedClipOpportunities([]);
            return;
        }

        const candidateClips = state.raw_clips_collected;

        const normalizedClipMap = new Map();
        candidateClips.forEach(clip => {
            const normalizedUrl = normalizeUrl(clip.url);
            const videoId = getYouTubeVideoId(clip.url);
            if (!normalizedClipMap.has(normalizedUrl)) {
                normalizedClipMap.set(normalizedUrl, clip);
            }
            if (videoId && !normalizedClipMap.has(videoId)) {
                normalizedClipMap.set(videoId, clip);
            }
        });

        const prompt = `
        You are an expert content editor and strategist. Your task is to select and rank the best ${MAX_RANKED_CLIPS} viral clip opportunities from a list of candidates.
        The goal is to find original, short, single-moment clips that fit the creative brief and editorial DNA.
        
        Creative Brief: Generate a ranked #6-#1 countdown of real, shocking/funny moments pulled from original short clips — not a compilation reel, high-energy editing, one clear 'moment' per rank.

        Topic: "${state.topic}"
        Editorial DNA (if available): ${state.editorial_dna ? JSON.stringify(state.editorial_dna, null, 2) : 'N/A'}
        Viral Opportunity Insights: ${state.viral_opportunity ? JSON.stringify(state.viral_opportunity, null, 2) : 'N/A'}

        Candidate Clips (Titles and URLs are crucial):
        ${JSON.stringify(candidateClips.map(c => ({
            title: c.title,
            url: c.url,
            platform: c.platform,
            views: c.views,
            likes: c.likes,
            duration_sec: c.duration_sec,
            description: c.description
        })), null, 2)}

        From the candidate clips, select ${MAX_RANKED_CLIPS} clips that best fit the brief. For each selected clip, provide:
        - The exact 'url' from the candidates list.
        - A 'rank' from 6 (least best) to 1 (absolute best).
        - A punchy 'moment_idea' describing the specific visual moment (not just the raw title).
        - An 'editorial_repost_analysis' explaining why it's a good candidate, what its hook angle is, and how it aligns with the brief.
        - 'human_editor_search_terms': 3-5 keywords/phrases an editor might use to find this specific moment.
        - 'editorial_rubric_scores': An object containing the following scores, each from 0.0 to 1.0 (float) and a single 'reasoning' string for ALL scores.
            - 'viral_fit' (35% weight): How well the clip's content aligns with current viral trends and the core 'unexpected/funny/shock' brief.
            - 'format_match' (25% weight): How well the clip fits the "original, short, single-moment" format.
            - 'moment_strength' (20% weight): The impact and clarity of the viral moment itself.
            - 'originality' (10% weight): Perceived originality of the content (not a repost/recreation of an older viral clip).
            - 'engagement' (10% weight): Potential for high user interaction.
        - If a clip is explicitly rejected, provide 'reject_reason' and do NOT include 'editorial_rubric_scores' or 'rank'.

        Output a JSON array of objects. Each object should represent a ranked clip or a rejected clip.
        Ensure your output is a valid JSON array.
        `;

        let llmRankedResults = [];
        try {
            const llmResponse = await this.llm.route(prompt, { jsonMode: true, ...params.llmOptions });
            llmRankedResults = coerceToArray(llmResponse.result);
        } catch (error) {
            state.addError(`${this.name}: LLM failed to generate ranked clips: ${error.message}`, error);
        }

        const finalRankedClips = [];
        let successfulRankings = 0;

        for (const item of llmRankedResults) {
            if (successfulRankings >= MAX_RANKED_CLIPS) break;

            if (item.reject_reason) {
                state.addStatus(`Rejected clip: ${item.url || 'Unknown URL'} - Reason: ${item.reject_reason}`);
                continue;
            }

            let matchedClip = normalizedClipMap.get(normalizeUrl(item.url));
            if (!matchedClip && item.url) {
                const videoId = getYouTubeVideoId(item.url);
                if (videoId) {
                    matchedClip = normalizedClipMap.get(videoId);
                }
            }

            if (matchedClip && item.rank && item.editorial_repost_analysis && item.editorial_rubric_scores) {
                const rubricScores = item.editorial_rubric_scores;
                const isValidRubric = typeof rubricScores.viral_fit === 'number' && rubricScores.viral_fit >= 0 && rubricScores.viral_fit <= 1 &&
                                     typeof rubricScores.format_match === 'number' && rubricScores.format_match >= 0 && rubricScores.format_match <= 1 &&
                                     typeof rubricScores.moment_strength === 'number' && rubricScores.moment_strength >= 0 && rubricScores.moment_strength <= 1 &&
                                     typeof rubricScores.originality === 'number' && rubricScores.originality >= 0 && rubricScores.originality <= 1 &&
                                     typeof rubricScores.engagement === 'number' && rubricScores.engagement >= 0 && rubricScores.engagement <= 1 &&
                                     typeof rubricScores.reasoning === 'string' && rubricScores.reasoning.length > 0;

                if (isValidRubric) {
                    const weightedConfidence = (
                        rubricScores.viral_fit * 0.35 +
                        rubricScores.format_match * 0.25 +
                        rubricScores.moment_strength * 0.20 +
                        rubricScores.originality * 0.10 +
                        rubricScores.engagement * 0.10
                    ) * 100;

                    finalRankedClips.push({
                        rank: item.rank,
                        moment_idea: item.moment_idea || matchedClip.title,
                        clip_url: matchedClip.url,
                        title: matchedClip.title,
                        platform: matchedClip.platform,
                        author: matchedClip.author || matchedClip.channelTitle,
                        views: matchedClip.views,
                        likes: matchedClip.likes,
                        engagement_score: matchedClip.views || 0,
                        editorial_repost_analysis: item.editorial_repost_analysis,
                        confidence_score: parseFloat(weightedConfidence.toFixed(1)),
                        human_editor_search_terms: item.human_editor_search_terms || [],
                        editorial_rubric_scores: rubricScores,
                        reject_reason: item.reject_reason || null
                    });
                    successfulRankings++;
                } else {
                    state.addWarn(`${this.name}: LLM provided invalid rubric scores for clip ${item.url || 'unknown'}. Skipping this ranking.`);
                }
            } else {
                state.addWarn(`${this.name}: LLM failed to provide complete ranking data for clip: ${item.url || 'unknown'}. Skipping.`);
            }
        }

        if (finalRankedClips.length === 0) {
            state.addWarn(`${this.name}: LLM ranking failed or provided no valid clips. Falling back to engagement-based selection and generating a generic rubric.`);
            const sortedFallbackClips = candidateClips
                .filter(clip => !looksLikeCompilationOrRanking(clip, state.editorial_dna, state.viral_opportunity))
                .sort((a, b) => ((b.views || 0) + (b.likes || 0) * 5) - ((a.views || 0) + (a.likes || 0) * 5));

            const fallbackCount = Math.min(MAX_RANKED_CLIPS, sortedFallbackClips.length);
            for (let i = 0; i < fallbackCount; i++) {
                const clip = sortedFallbackClips[i];
                finalRankedClips.push({
                    rank: MAX_RANKED_CLIPS - i,
                    moment_idea: clip.title,
                    clip_url: clip.url,
                    title: clip.title,
                    platform: clip.platform,
                    author: clip.author || clip.channelTitle,
                    views: clip.views,
                    likes: clip.likes,
                    engagement_score: (clip.views || 0) + (clip.likes || 0) * 5,
                    editorial_repost_analysis: "Fallback: Selected based on high engagement and basic content filtering. AI ranking failed.",
                    confidence_score: 40.0,
                    human_editor_search_terms: [],
                    editorial_rubric_scores: {
                        viral_fit: 0.5,
                        format_match: 0.5,
                        moment_strength: 0.5,
                        originality: 0.5,
                        engagement: 0.7,
                        reasoning: "Generic scores: AI ranking failed, so selected by engagement. Further human review needed."
                    },
                    reject_reason: null
                });
            }
        }

        finalRankedClips.sort((a, b) => a.rank - b.rank);
        state.setRankedClipOpportunities(finalRankedClips);
    }
}


class StoryBuilderAgent {
    constructor(llm) {
        this.llm = llm;
        this.name = 'StoryBuilderAgent';
    }

    async execute(state) {
        state.addStatus(`${this.name}: (Phase 1 Stub) Building story...`);
        const summary = `
        ## Source Intelligence Report for: ${state.topic}

        --- Actionable Insights ---
        ${state.viral_opportunity?.overall_opportunity_reasoning ? `🚀 Opportunity Reasoning: ${state.viral_opportunity.overall_opportunity_reasoning}\n` : ''}
        ${state.viral_opportunity?.trend_status ? `📈 Trend Status: ${state.viral_opportunity.trend_status}\n` : ''}
        ${state.viral_opportunity?.hook_suggestions?.length > 0 ? `⚡ Hook Suggestions: ${state.viral_opportunity.hook_suggestions.join(', ')}\n` : ''}
        ${state.viral_opportunity?.hashtag_strategy?.length > 0 ? `# Hashtag Strategy: ${state.viral_opportunity.hashtag_strategy.join(', ')}\n` : ''}

        --- Ranked Clip Opportunities ---
        ${state.ranked_clip_opportunities?.length > 0
            ? state.ranked_clip_opportunities.map(clip => `Rank #${clip.rank}: ${clip.title} (${clip.platform}) — ${clip.clip_url}`).join('\n')
            : 'No ranked clip opportunities found yet.'}
        `;
        state.summary_report = summary;
    }
}


// --- Orchestrator ---
class Orchestrator {
    constructor(env) {
        this.llmRouter = new LLMRouter(env);
        this.youtubeSearch = new YouTubeSearchCapability(env);
        this.searchCapability = new SearchExecutionCapability(env);
        this.agents = [
            new EditorialDNAExtractionAgent(this.llmRouter, this.youtubeSearch),
            new EditorialIntentAgent(this.llmRouter),
            new DiscoveryStrategyPlannerAgent(this.llmRouter),
            new SourceHunterAgent(this.llmRouter, this.searchCapability),
            new RankingAgent(this.llmRouter),
            new StoryBuilderAgent(this.llmRouter)
        ];
    }

    // FIX #7: now accepts and threads provider/model through to every agent,
    // instead of silently ignoring the caller's selection.
    async execute(topic, referenceChannels = [], selectedProvider = DEFAULT_PROVIDER, selectedModel = null) {
        const state = new RuntimeState(topic);
        state.addStatus(`Starting orchestration for topic: "${topic}" with LLM provider: ${selectedProvider}`);
        const llmOptions = { provider: selectedProvider, model: selectedModel || undefined };

        for (const agent of this.agents) {
            try {
                if (agent.name === 'EditorialDNAExtractionAgent') {
                    await agent.execute(state, { referenceChannels, llmOptions });
                } else {
                    await agent.execute(state, { llmOptions });
                }
            } catch (error) {
                state.addError(`Orchestration: Agent '${agent.name}' failed: ${error.message}`, error);
                throw error;
            }
        }
        state.addStatus('Orchestration finished.');
        return state;
    }
}


// --- Cloudflare Worker Setup ---

// FIX #7 & #8: serve status at both "/" and "/api/status" so the existing
// frontend's capabilities check (which calls the bare Worker URL) keeps working.
function handleStatus(env) {
    const llmRouter = new LLMRouter(env);
    const availableProviders = Object.keys(llmRouter.providers).map(key => {
        const provider = llmRouter.providers[key];
        return {
            id: key,
            name: provider.name,
            available: !!provider.apiKey || key === 'cloudflare',
            models: provider.models,
            configured_models: provider.models.filter(model => {
                if (key === 'cloudflare') return true;
                if (key === 'openrouter' && env.OPENROUTER_API_KEY) return true;
                if (key === 'google' && env.GEMINI_API_KEY) return true;
                if (key === 'github' && env.GITHUB_MODELS_TOKEN) return true;
                if (key === 'huggingface' && env.HF_TOKEN) return true;
                return false;
            }),
        };
    });

    return json({
        status: 'ok',
        version: '1.0',
        message: 'Viral Radar Worker is operational.',
        llm_providers: availableProviders,
        providers_configured: {
            cloudflare: Boolean(env.AI),
            openrouter: Boolean(env.OPENROUTER_API_KEY),
            google: Boolean(env.GEMINI_API_KEY),
            github: Boolean(env.GITHUB_MODELS_TOKEN),
            huggingface: Boolean(env.HF_TOKEN),
        },
        configured_youtube_api: !!env.YOUTUBE_API_KEY,
        configured_apify_api: !!env.APIFY_API_TOKEN,
    });
}

// FIX #8: build the exact shape index.html's UI already knows how to render
// (editorial_objective wrapper, ranked_clip_opportunities nested inside
// ai_actionable_insights, key_search_phrases_for_discoverability naming,
// seo_elements_for_upload, evidence items with thumbnail_url/views_approx/etc).
function toEvidenceItem(clip) {
    return {
        url: clip.url,
        title: clip.title,
        platform: clip.platform,
        channel: clip.channelTitle || clip.author || '',
        thumbnail_url: clip.thumbnail || '',
        views_approx: clip.views || 0,
        likes_approx: clip.likes || 0,
        comments: clip.commentCount || 0,
        published_at: clip.publishedAt || clip.createTimeISO || clip.createdUtc || '',
        description_snippet: (clip.description || '').slice(0, 300),
        source_type: `${clip.platform}_API`,
    };
}

function buildFrontendCompatibleResponse(state) {
    const youtube_clips = [], tiktok_clips = [], reddit_posts = [], other_clips = [];
    (state.raw_clips_collected || []).forEach(clip => {
        switch (clip.platform) {
            case 'YouTube': youtube_clips.push(toEvidenceItem(clip)); break;
            case 'TikTok': tiktok_clips.push(toEvidenceItem(clip)); break;
            case 'Reddit': reddit_posts.push(toEvidenceItem(clip)); break;
            default: other_clips.push(toEvidenceItem(clip));
        }
    });

    const vo = state.viral_opportunity || {};
    const dna = state.editorial_dna;

    return {
        editorial_objective: {
            topic: state.topic,
            creative_brief_summary: "Ranked #6-#1 countdown of real, shocking/funny moments from original short clips.",
            editorial_dna: {
                clip_length: dna?.clip_length_range ? `${dna.clip_length_range.min_sec}-${dna.clip_length_range.max_sec}s` : 'N/A',
                hook_style: dna?.editing_pattern || 'N/A',
                emotion_focus: (dna?.preferred_emotions || []).join(', ') || 'N/A',
                source_preference: (dna?.source_platforms || []).join(', ') || 'Original Clips'
            },
            research_constraints_applied: state.ref_channel_analysis.map(r => `Analyzed reference channel: ${r.channel_name}`)
        },
        raw_evidence_found: {
            youtube_clips, tiktok_clips, reddit_posts,
            instagram_reels: [], facebook_posts: [], telegram_clips: [],
            total_youtube: youtube_clips.length,
        },
        ai_actionable_insights: {
            overall_opportunity_reasoning: vo.overall_opportunity_reasoning || '',
            trend_status: vo.trend_status || 'Unknown',
            hook_suggestions: vo.hook_suggestions || [],
            hashtag_strategy: vo.hashtag_strategy || [],
            key_search_phrases_for_discoverability: vo.discoverability_phrases || [],
            seo_elements_for_upload: {
                title_insights: "Craft catchy titles based on topic",
                description_hook: "Engage early with a strong hook",
                tags_to_prioritize: [state.topic.split(' ')[0]].filter(Boolean)
            },
            ranked_clip_opportunities: (state.ranked_clip_opportunities || []).map(c => ({
                rank: c.rank,
                moment_idea: c.moment_idea || c.title,
                suggested_source_platform: c.platform,
                human_editor_search_terms: c.human_editor_search_terms || [],
                url_to_potential_original_clip: c.clip_url,
                editorial_repost_analysis: c.editorial_repost_analysis,
                confidence_score: c.confidence_score,
            })),
        },
        ref_channel_analysis: state.ref_channel_analysis,
        summary_report: state.summary_report,
        status_messages: state.status_messages,
        error_messages: state.error_messages,
        processed_at: state.processed_at,
    };
}

async function handleGenerateInsights(request, env) {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

    // FIX #7: match the frontend's actual field names (referenceChannels,
    // provider, model), while still accepting the old snake_case names too.
    const topic = body.topic;
    const referenceChannelsRaw = body.referenceChannels ?? body.reference_channels ?? [];
    const provider = body.provider ?? body.llm_provider;
    const model = body.model;

    if (!topic) {
        return json({ error: 'Topic is required.' }, 400);
    }

    // index.html sends referenceChannels as an array of plain strings
    // ("youtube.com/@handle" or "@handle"); normalize to { handle } objects
    // and to a bare "@handle" the YouTube API accepts.
    const referenceChannels = (referenceChannelsRaw || [])
        .map(entry => {
            if (typeof entry !== 'string') return entry;
            const trimmed = entry.trim();
            const atMatch = trimmed.match(/@[\w.-]+/);
            if (atMatch) return { handle: atMatch[0] };
            return trimmed ? { handle: trimmed } : null;
        })
        .filter(Boolean);

    const orchestrator = new Orchestrator(env);
    try {
        const state = await orchestrator.execute(topic, referenceChannels, provider, model);
        return json(buildFrontendCompatibleResponse(state));
    } catch (error) {
        console.error('Orchestration workflow failed:', error);
        // Return 200 with an empty-but-valid contract so the existing
        // frontend can display something instead of erroring on a 500 body
        // it doesn't otherwise expect.
        return json({
            editorial_objective: { topic, creative_brief_summary: '', editorial_dna: {}, research_constraints_applied: [] },
            raw_evidence_found: null,
            ai_actionable_insights: null,
            ref_channel_analysis: [],
            error: `Orchestration workflow failed: ${error.message}`,
        }, 200);
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

        if ((url.pathname === "/" || url.pathname === "/api/status") && request.method === "GET") {
            return handleStatus(env);
        }

        if (url.pathname === "/api/generate-insights" && request.method === "POST") {
            return handleGenerateInsights(request, env);
        }

        return json({ error: "Not found" }, 404);
    },
};
