print(ruflo__memory_store(key='modified_worker_js_ranking_rubric', value='''
// This is the combined Cloudflare Worker for Viral Radar, handling both API and static asset serving.
// It integrates multiple agents, LLM routing, and search capabilities.

import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-pages'

const app = new Hono()

// --- Constants and Utilities ---
const DEFAULT_PROVIDER = 'cloudflare';
const MAX_SEARCH_RESULTS_PER_PLATFORM = 10; // Max clips per platform to fetch
const MAX_RANKED_CLIPS = 6; // Fixed number of clips for the final ranked list

// Utility function to clean JSON string from common LLM formatting issues
function cleanJson(jsonString) {
    if (!jsonString) return '';

    // If the response is directly an array, ensure it starts and ends with [ ]
    let cleanedString = jsonString.trim();
    if (cleanedString.startsWith('[') && cleanedString.endsWith(']')) {
        return cleanedString;
    }

    // Try to find the first '{' and last '}' or '[' and ']'
    let firstBrace = cleanedString.indexOf('{');
    let lastBrace = cleanedString.lastIndexOf('}');
    let firstBracket = cleanedString.indexOf('[');
    let lastBracket = cleanedString.lastIndexOf(']');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return cleanedString.substring(firstBrace, lastBrace + 1);
    }
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
        return cleanedString.substring(firstBracket, lastBracket + 1);
    }

    return ''; // Fallback if no valid JSON structure is found
}

// Utility to coerce potentially non-array LLM output to an array
function coerceToArray(data) {
    if (Array.isArray(data)) {
        return data;
    }
    if (typeof data === 'object' && data !== null) {
        // Common cases where LLM might wrap an array in an object
        if (data.items && Array.isArray(data.items)) return data.items;
        if (data.list && Array.isArray(data.list)) return data.list;
        if (data.results && Array.isArray(data.results)) return data.results;
        if (data.missions && Array.isArray(data.missions)) return data.missions;
        if (data.opportunities && Array.isArray(data.opportunities)) return data.opportunities;
        if (data.clips && Array.isArray(data.clips)) return data.clips;
        // If it's an object, but not a recognized wrapper, treat it as a single item if suitable
        if (Object.keys(data).length > 0) return [data];
    }
    return [];
}

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hostname = u.hostname.replace(/^www\./, ''); // Remove www.
        u.searchParams.sort(); // Normalize query params order
        return u.toString();
    } catch (e) {
        return url; // Return original if invalid URL
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

        const modelsToTry = selectedModels.slice(); // Copy to avoid modifying original array

        while (modelsToTry.length > 0) {
            const model = modelsToTry.shift();
            try {
                const result = await this._callProvider(selectedProvider, model, prompt, options.jsonMode);
                return { provider: selectedProvider, model, result };
            } catch (error) {
                console.warn(`LLM call failed for ${selectedProvider}/${model}: ${error.message}`);
                if (modelsToTry.length === 0) {
                    // If current provider fails all models, try to fallback to Cloudflare
                    if (selectedProvider !== 'cloudflare') {
                        console.warn(`All models for ${selectedProvider} failed. Attempting fallback to Cloudflare AI.`);
                        selectedProvider = 'cloudflare';
                        selectedModels = this.providers.cloudflare.models;
                        modelsToTry.push(...selectedModels); // Add Cloudflare models to try
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
        const response = await this.env.AI.run(model, {
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            json_mode: jsonMode,
        });
        if (jsonMode) {
            // Cloudflare AI's json_mode sometimes returns markdown JSON, sometimes raw.
            // Attempt to clean it if it's wrapped in markdown.
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
            if (typeof output === 'object') return output; // Already parsed
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
            'HTTP-Referer': 'https://viral-discovery.fasterwgseverkh.workers.dev', // Replace with your domain
            'X-Title': 'Viral Radar Internal Worker',
        };
        const body = JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            // response_format: jsonMode ? { type: "json_object" } : undefined, // OpenRouter models are not all json_object capable
        });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: headers,
            body: body,
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
            })
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

    // Placeholder for GitHub Copilot API
    async _callGitHubCopilot(model, prompt, jsonMode) {
        if (!this.env.GITHUB_MODELS_TOKEN) {
            throw new Error('GITHUB_MODELS_TOKEN not set for GitHub Copilot API.');
        }
        throw new Error('GitHub Copilot API not fully implemented yet.');
    }

    // Placeholder for HuggingFace Inference API
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
        const response = await fetch(url);
        if (!response.ok) {
            const error = await response.json();
            console.error('YouTube API error:', error);
            throw new Error(`YouTube API failed: ${response.status} - ${error.error.message}`);
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

        // Fetch view counts for videos
        if (clips.length > 0) {
            const videoIds = clips.map(clip => clip.id).join(',');
            const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${this.env.YOUTUBE_API_KEY}`;
            const statsResponse = await fetch(statsUrl);
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

        // Get upload playlist ID for the channel
        const channelDetailsUrl = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${this.env.YOUTUBE_API_KEY}`;
        const channelDetailsResponse = await fetch(channelDetailsUrl);
        if (!channelDetailsResponse.ok) {
            const error = await channelDetailsResponse.json();
            console.error(`YouTube API error fetching channel details for ${channelId}:`, error);
            return [];
        }
        const channelDetailsData = await channelDetailsResponse.json();
        const uploadsPlaylistId = channelDetailsData.items[0]?.contentDetails?.relatedPlaylists?.uploads;

        if (!uploadsPlaylistId) {
            console.warn(`Could not find uploads playlist for channel ID: ${channelId}`);
            return [];
        }

        // Fetch videos from the uploads playlist
        const playlistItemsUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${this.env.YOUTUBE_API_KEY}`;
        const playlistItemsResponse = await fetch(playlistItemsUrl);
        if (!playlistItemsResponse.ok) {
            const error = await playlistItemsResponse.json();
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

        // Fetch duration for videos
        if (videos.length > 0) {
            const videoIds = videos.map(video => video.id).join(',');
            const contentDetailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds}&key=${this.env.YOUTUBE_API_KEY}`;
            const contentDetailsResponse = await fetch(contentDetailsUrl);
            if (contentDetailsResponse.ok) {
                const contentDetailsData = await contentDetailsResponse.json();
                contentDetailsData.items.forEach(videoDetail => {
                    const video = videos.find(v => v.id === videoDetail.id);
                    if (video) {
                        const duration = videoDetail.contentDetails.duration; // e.g., "PT1M30S"
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

        // Fetch view counts for videos
        if (videos.length > 0) {
            const videoIds = videos.map(video => video.id).join(',');
            const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds}&key=${this.env.YOUTUBE_API_KEY}`;
            const statsResponse = await fetch(statsUrl);
            if (statsResponse.ok) {
                const statsData = await statsResponse.json();
                statsData.items.forEach(statItem => {
                    const video = videos.find(v => v.id === statItem.id);
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
        if (!handle.startsWith('@')) { // Assume it's a channel ID if not a handle
            return handle;
        }
        const username = handle.substring(1); // Remove '@'

        // Search for channel by username
        const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(username)}&key=${this.env.YOUTUBE_API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) {
            const error = await response.json();
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
        this.tiktokActorId = 'clockworks/tiktok-scraper'; // Example Actor ID
        this.redditActorId = 'solidcode/reddit-scraper';   // Example Actor ID
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
            // Ensure timeout is handled by the orchestrator/frontend if Apify is slow
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
            // Add other parameters as needed, ensuring they don't increase cost unnecessarily
        };
        const { results, error } = await this._callApifyActor(this.tiktokActorId, input, 'TikTok');
        if (error) return { platform: 'TikTok', results: [], error };

        return {
            platform: 'TikTok',
            results: results.map(item => ({
                id: item.id,
                url: item.webVideoUrl || `https://www.tiktok.com/@${item.authorMeta?.name}/video/${item.id}`,
                title: item.text,
                description: item.text, // TikTok doesn't have a separate description field usually
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
            // Add other parameters as needed
        };
        const { results, error } = await this._callApifyActor(this.redditActorId, input, 'Reddit');
        if (error) return { platform: 'Reddit', results: [], error };

        return {
            platform: 'Reddit',
            results: results.map(item => ({
                id: item.id,
                url: item.url || item.permalink ? `https://www.reddit.com${item.permalink}` : null,
                title: item.title,
                description: item.selftext || item.title, // Reddit posts might have selftext
                thumbnail: item.thumbnail, // May be a URL or 'self' or 'default'
                platform: 'Reddit',
                author: item.author,
                views: item.score, // Score as a proxy for views/engagement
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
        this.raw_clips_collected = []; // All clips from all search platforms
        this.editorial_dna = null; // Structured DNA from reference channels
        this.viral_opportunity = null; // Insights like hook suggestions, hashtags, etc.
        this.ranked_clip_opportunities = []; // Final ranked list with editorial analysis
        this.ai_actionable_insights = {};
        this.ref_channel_analysis = []; // Analysis for each provided reference channel
        this.summary_report = '';
        this.status_messages = [];
        this.error_messages = [];
        this.processed_at = new Date().toISOString();
    }

    addStatus(message) {
        this.status_messages.push(`[${new Date().toISOString()}] ${message}`);
        console.log(`Status: ${message}`);
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

                // Prepare video data for LLM
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
                  "content_type": "string", // e.g., "Comedy Sketch", "Educational Explainer", "Vlog", "DIY Tutorial", "Life Hacks", "Gaming Highlights", "Short-form Entertainment", "News Commentary", "Documentary Style"
                  "clip_type": "string", // e.g., "Reaction", "Fail Compilation", "How-to", "Explainer", "Personal Story", "Challenge", "Prank", "Satisfying Loop", "Unexpected Moment", "Tutorial Segment", "Interview Snippet", "Behind-the-scenes"
                  "preferred_emotions": "list[string]", // e.g., "Humor", "Surprise", "Awe", "Fear", "Inspiration", "Relatability", "Curiosity", "Nostalgia", "Excitement"
                  "clip_length_range": { // in seconds
                    "min_sec": "integer",
                    "max_sec": "integer"
                  },
                  "editing_pattern": "string", // e.g., "Fast-paced cuts", "Jump cuts", "Slow-motion emphasis", "Seamless transitions", "Minimal editing", "Text overlays", "Sound effect heavy", "Dialogue driven"
                  "source_platforms": "list[string]", // e.g., "TikTok", "YouTube Shorts", "Instagram Reels", "Snapchat", "Original Production", "User Generated Content (UGC)", "News Footage"
                  "reject_list": "list[string]" // Keywords or categories this channel explicitly avoids, e.g., "politics", "long-form interviews", "boring explainers", "shock content", "controversial topics"
                }
                \`\`\`

                Recent videos from channel "${ref.handle}":
                ${JSON.stringify(videoDataForLLM, null, 2)}

                Ensure your output is valid JSON.
                `;

                const llmResponse = await this.llm.route(prompt, { jsonMode: true });
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
            // For simplicity, combine DNA from multiple channels or pick the first for now.
            // A more advanced approach would merge or prioritize.
            const combinedDna = validDna[0]; // Just take the first valid one for now
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

    async execute(state) {
        state.addStatus(`${this.name}: Generating editorial intent...`);

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
          "overall_opportunity_reasoning": "string", // Explain why this topic is hot or has viral potential.
          "trend_status": "string", // "Rising", "Stable", "Declining", "Unknown"
          "hook_suggestions": "list[string]", // 3-5 high-impact hook lines.
          "hashtag_strategy": "list[string]", // 3-5 relevant and high-reach hashtags.
          "discoverability_phrases": "list[string]", // 3-5 phrases users might search for.
          "acceptable_event_types": "list[string]", // Specific scenarios or types of events that fit the viral brief (e.g., "photobomb", "object collision", "camera timing illusion", "unexpected reaction", "epic fail").
          "reject_content_types": "list[string]" // Specific content categories to avoid (e.g., "DIY", "news", "podcast", "gaming", "music videos", "tutorials", "documentaries").
        }
        \`\`\`

        Ensure your output is valid JSON.
        `;

        try {
            const llmResponse = await this.llm.route(prompt, { jsonMode: true });
            const opportunity = llmResponse.result;

            if (opportunity) {
                state.setViralOpportunity(opportunity);
                state.setAIActionableInsights(opportunity); // Also set for UI display
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

    async execute(state) {
        state.addStatus(`${this.name}: Planning discovery strategy...`);

        if (!state.viral_opportunity) {
            state.addError(`${this.name}: Viral opportunity not set. Cannot plan discovery strategy.`);
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
            const llmResponse = await this.llm.route(prompt, { jsonMode: true });
            const discoveryMissions = coerceToArray(llmResponse.result);

            if (discoveryMissions && discoveryMissions.length > 0) {
                // Ensure unique and sort if needed
                const uniqueMissions = Array.from(new Set(discoveryMissions));
                state.addStatus(`${this.name}: Generated ${uniqueMissions.length} discovery missions.`);
                state.discovery_missions = uniqueMissions; // Store for later use
                state.addAIActionableInsights({
                    ...state.ai_actionable_insights,
                    discovery_missions: uniqueMissions
                });
            } else {
                state.addError(`${this.name}: LLM failed to generate discovery missions.`, llmResponse);
                state.discovery_missions = [`${state.topic} short clips`]; // Fallback
            }
        } catch (error) {
            state.addError(`${this.name}: Failed to plan discovery strategy: ${error.message}`, error);
            state.discovery_missions = [`${state.topic} viral clips`]; // Fallback
        }
    }
}


class SourceHunterAgent {
    constructor(llm, searchCapability) {
        this.llm = llm;
        this.searchCapability = searchCapability;
        this.name = 'SourceHunterAgent';
    }

    // Helper to check if a clip looks like a compilation or ranking video
    looksLikeCompilationOrRanking(clip, editorialDNA, viralOpportunity) {
        const title = clip.title.toLowerCase();
        const description = (clip.description || '').toLowerCase();

        const NO_COMPILATION_KEYWORDS = ["compilation", "best of", "top 10", "epic moments", "funny moments", "fails", "tribute", "highlights", "mashup", "recap"];
        const NO_RANKING_KEYWORDS = ["rank", "#1", "worst", "best", "countdown", "vs", "review"];

        // Check against static keywords
        if (NO_COMPILATION_KEYWORDS.some(keyword => title.includes(keyword) || description.includes(keyword))) {
            return true;
        }
        if (NO_RANKING_KEYWORDS.some(keyword => title.includes(keyword) || description.includes(keyword))) {
            return true;
        }

        // Check against DNA profile's reject list
        if (editorialDNA?.reject_list && editorialDNA.reject_list.length > 0) {
            if (editorialDNA.reject_list.some(keyword => title.includes(keyword.toLowerCase()) || description.includes(keyword.toLowerCase()))) {
                return true;
            }
        }

        // Check against per-topic reject content types
        if (viralOpportunity?.reject_content_types && viralOpportunity.reject_content_types.length > 0) {
             if (viralOpportunity.reject_content_types.some(keyword => title.includes(keyword.toLowerCase()) || description.includes(keyword.toLowerCase()))) {
                return true;
            }
        }

        return false;
    }


    async execute(state) {
        state.addStatus(`${this.name}: Hunting for source clips...`);
        if (!state.discovery_missions || state.discovery_missions.length === 0) {
            state.addError(`${this.name}: No discovery missions available.`);
            return;
        }

        const rawClips = await this.searchCapability.execute(state.discovery_missions);

        // Filter out compilation/ranking videos and unwanted content types early
        const filteredClips = rawClips.filter(clip => {
            if (this.looksLikeCompilationOrRanking(clip, state.editorial_dna, state.viral_opportunity)) {
                return false; // Reject if it looks like a compilation or ranking
            }

            // Optional: Filter by length if DNA profile specifies
            if (state.editorial_dna?.clip_length_range) {
                const { min_sec, max_sec } = state.editorial_dna.clip_length_range;
                if (clip.duration_sec && (clip.duration_sec < min_sec || clip.duration_sec > max_sec)) {
                    return false; // Reject if outside preferred length
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

    async execute(state) {
        state.addStatus(`${this.name}: Ranking clip opportunities...`);
        if (!state.raw_clips_collected || state.raw_clips_collected.length === 0) {
            state.addStatus(`${this.name}: No raw clips to rank.`);
            state.setRankedClipOpportunities([]);
            return;
        }

        const candidateClips = state.raw_clips_collected;

        // Normalize URLs and create a map for easy lookup
        const normalizedClipMap = new Map();
        candidateClips.forEach(clip => {
            const normalizedUrl = normalizeUrl(clip.url);
            const videoId = getYouTubeVideoId(clip.url);
            if (!normalizedClipMap.has(normalizedUrl)) {
                normalizedClipMap.set(normalizedUrl, clip);
            }
            if (videoId && !normalizedClipMap.has(videoId)) { // Store by video ID too for robustness
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
        - An 'editorial_repost_analysis' explaining why it's a good candidate, what its hook angle is, and how it aligns with the brief.
        - `human_editor_search_terms`: 3-5 keywords/phrases an editor might use to find this specific moment.
        - `editorial_rubric_scores`: An object containing the following scores, each from 0.0 to 1.0 (float) and a single `reasoning` string for ALL scores.
            - `viral_fit` (35% weight): How well the clip's content aligns with current viral trends and the core 'unexpected/funny/shock' brief.
            - `format_match` (25% weight): How well the clip fits the "original, short, single-moment" format.
            - `moment_strength` (20% weight): The impact and clarity of the viral moment itself.
            - `originality` (10% weight): Perceived originality of the content (not a repost/recreation of an older viral clip).
            - `engagement` (10% weight): Potential for high user interaction.
        - If a clip is explicitly rejected, provide `reject_reason` and do NOT include `editorial_rubric_scores` or `rank`.

        Output a JSON array of objects. Each object should represent a ranked clip or a rejected clip.
        Example of a ranked clip:
        \`\`\`json
        [
          {
            "url": "https://www.youtube.com/watch?v=example1",
            "rank": 6,
            "editorial_repost_analysis": "This clip features an unexpected pet reaction...",
            "human_editor_search_terms": ["cat jump scare", "funny pet reaction"],
            "editorial_rubric_scores": {
                "viral_fit": 0.8,
                "format_match": 0.9,
                "moment_strength": 0.7,
                "originality": 0.6,
                "engagement": 0.8,
                "reasoning": "This clip showcases a clear, funny, single moment that is highly shareable and aligns with current animal humor trends. The format is ideal for short-form content."
            }
          },
          // ... up to 6 ranked clips
          {
            "url": "https://www.youtube.com/watch?v=rejected_example",
            "reject_reason": "This video is a compilation of multiple short clips, violating the 'single-moment' rule."
          }
        ]
        \`\`\`
        Ensure your output is a valid JSON array.
        `;

        let llmRankedResults = [];
        try {
            const llmResponse = await this.llm.route(prompt, { jsonMode: true });
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

            // Find the actual clip object using URL or video ID for robust matching
            let matchedClip = normalizedClipMap.get(normalizeUrl(item.url));
            if (!matchedClip && item.url) {
                const videoId = getYouTubeVideoId(item.url);
                if (videoId) {
                    matchedClip = normalizedClipMap.get(videoId);
                }
            }

            if (matchedClip && item.rank && item.editorial_repost_analysis && item.editorial_rubric_scores) {
                const rubricScores = item.editorial_rubric_scores;
                // Validate scores are floats between 0 and 1
                const isValidRubric = typeof rubricScores.viral_fit === 'number' && rubricScores.viral_fit >= 0 && rubricScores.viral_fit <= 1 &&
                                     typeof rubricScores.format_match === 'number' && rubricScores.format_match >= 0 && rubricScores.format_match <= 1 &&
                                     typeof rubricScores.moment_strength === 'number' && rubricScores.moment_strength >= 0 && rubricScores.moment_strength <= 1 &&
                                     typeof rubricScores.originality === 'number' && rubricScores.originality >= 0 && rubricScores.originality <= 1 &&
                                     typeof rubricScores.engagement === 'number' && rubricScores.engagement >= 0 && rubricScores.engagement <= 1 &&
                                     typeof rubricScores.reasoning === 'string' && rubricScores.reasoning.length > 0;

                if (isValidRubric) {
                    // Calculate a combined confidence based on the rubric scores (using weights)
                    const weightedConfidence = (
                        rubricScores.viral_fit * 0.35 +
                        rubricScores.format_match * 0.25 +
                        rubricScores.moment_strength * 0.20 +
                        rubricScores.originality * 0.10 +
                        rubricScores.engagement * 0.10
                    ) * 100; // Convert to a percentage-like score

                    finalRankedClips.push({
                        rank: item.rank,
                        clip_url: matchedClip.url,
                        title: matchedClip.title,
                        platform: matchedClip.platform,
                        author: matchedClip.author || matchedClip.channelTitle,
                        views: matchedClip.views,
                        likes: matchedClip.likes,
                        engagement_score: matchedClip.views || 0, // Keep for now, but rubric is primary
                        editorial_repost_analysis: item.editorial_repost_analysis,
                        confidence_score: parseFloat(weightedConfidence.toFixed(1)), // Use weighted confidence
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

        // If LLM ranking failed entirely or didn't provide enough clips, use a robust fallback
        if (finalRankedClips.length === 0) {
            state.addWarn(`${this.name}: LLM ranking failed or provided no valid clips. Falling back to engagement-based selection and generating a generic rubric.`);
            // Sort filtered clips by a combined engagement score
            const sortedFallbackClips = candidateClips
                .filter(clip => !this.looksLikeCompilationOrRanking(clip, state.editorial_dna, state.viral_opportunity)) // Re-filter to be safe
                .sort((a, b) => ((b.views || 0) + (b.likes || 0) * 5) - ((a.views || 0) + (a.likes || 0) * 5));

            const fallbackCount = Math.min(MAX_RANKED_CLIPS, sortedFallbackClips.length);
            for (let i = 0; i < fallbackCount; i++) {
                const clip = sortedFallbackClips[i];
                finalRankedClips.push({
                    rank: MAX_RANKED_CLIPS - i, // Rank descending
                    clip_url: clip.url,
                    title: clip.title,
                    platform: clip.platform,
                    author: clip.author || clip.channelTitle,
                    views: clip.views,
                    likes: clip.likes,
                    engagement_score: (clip.views || 0) + (clip.likes || 0) * 5,
                    editorial_repost_analysis: "Fallback: Selected based on high engagement and basic content filtering. AI ranking failed.",
                    confidence_score: 40.0, // Lower confidence for fallback
                    human_editor_search_terms: [], // Fallback doesn't generate this
                    editorial_rubric_scores: { // Generic rubric for fallback
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

        finalRankedClips.sort((a, b) => a.rank - b.rank); // Ensure final list is sorted by rank
        state.setRankedClipOpportunities(finalRankedClips);
    }
}


// Placeholder for future agent
class StoryBuilderAgent {
    constructor(llm) {
        this.llm = llm;
        this.name = 'StoryBuilderAgent';
    }

    async execute(state) {
        state.addStatus(`${this.name}: (Phase 1 Stub) Building story...`);
        // For Phase 1, this agent primarily aggregates existing insights
        // and structures them into a coherent report format.
        const summary = `
        ## Source Intelligence Report for: ${state.topic}
        ### Creative Brief: Generate a ranked #6-#1 countdown of real, shocking/funny moments pulled from original short clips — not a compilation reel, high-energy editing, one clear 'moment' per rank.

        --- Actionable Insights ---
        ${state.viral_opportunity?.overall_opportunity_reasoning ? `
        🚀 Opportunity Reasoning: ${state.viral_opportunity.overall_opportunity_reasoning}
        ` : ''}
        ${state.viral_opportunity?.trend_status ? `
        📈 Trend Status: ${state.viral_opportunity.trend_status}
        ` : ''}
        ${state.viral_opportunity?.hook_suggestions && state.viral_opportunity.hook_suggestions.length > 0 ? `
        ⚡ Hook Suggestions: ${state.viral_opportunity.hook_suggestions.join(', ')}
        ` : ''}
        ${state.viral_opportunity?.hashtag_strategy && state.viral_opportunity.hashtag_strategy.length > 0 ? `
        # Hashtag Strategy: ${state.viral_opportunity.hashtag_strategy.join(', ')}
        ` : ''}
        ${state.viral_opportunity?.discoverability_phrases && state.viral_opportunity.discoverability_phrases.length > 0 ? `
        🔍 Discoverability Phrases: ${state.viral_opportunity.discoverability_phrases.join(', ')}
        ` : ''}

        --- Ranked Clip Opportunities ---
        ${state.ranked_clip_opportunities && state.ranked_clip_opportunities.length > 0 ?
            state.ranked_clip_opportunities.map(clip => `
            **Rank #${clip.rank}**
            Title: ${clip.title}
            Platform: ${clip.platform}
            URL: ${clip.clip_url}
            Views: ${clip.views ? clip.views.toLocaleString() : 'N/A'}
            Confidence: ${clip.confidence_score}%
            Editorial Analysis: ${clip.editorial_repost_analysis}
            Rubric Scores (Viral: ${clip.editorial_rubric_scores?.viral_fit*100}%, Format: ${clip.editorial_rubric_scores?.format_match*100}%, Moment: ${clip.editorial_rubric_scores?.moment_strength*100}%, Originality: ${clip.editorial_rubric_scores?.originality*100}%, Engagement: ${clip.editorial_rubric_scores?.engagement*100}%): ${clip.editorial_rubric_scores?.reasoning}
            ${clip.human_editor_search_terms && clip.human_editor_search_terms.length > 0 ? `Search Terms: ${clip.human_editor_search_terms.join(', ')}` : ''}
            ${clip.reject_reason ? `**REJECTED**: ${clip.reject_reason}` : ''}
            ---
            `).join('\n')
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
        this.searchCapability = new SearchExecutionCapability(env); // Combines YouTube and Apify
        this.agents = [
            new EditorialDNAExtractionAgent(this.llmRouter, this.youtubeSearch),
            new EditorialIntentAgent(this.llmRouter),
            new DiscoveryStrategyPlannerAgent(this.llmRouter),
            new SourceHunterAgent(this.llmRouter, this.searchCapability),
            new RankingAgent(this.llmRouter),
            new StoryBuilderAgent(this.llmRouter)
        ];
    }

    async execute(topic, referenceChannels = [], selectedProvider = DEFAULT_PROVIDER) {
        const state = new RuntimeState(topic);
        state.addStatus(`Starting orchestration for topic: "${topic}" with LLM provider: ${selectedProvider}`);

        for (const agent of this.agents) {
            try {
                if (agent.name === 'EditorialDNAExtractionAgent') {
                    await agent.execute(state, { referenceChannels });
                } else {
                    await agent.execute(state);
                }
            } catch (error) {
                state.addError(`Orchestration: Agent '${agent.name}' failed: ${error.message}`, error);
                // Depending on the agent, we might want to stop or continue
                // For now, critical agents failing will halt the process by throwing
                // For less critical, we might just log and continue.
                throw error; // Re-throw to indicate a critical failure
            }
        }
        state.addStatus('Orchestration finished.');
        return state;
    }
}


// --- Cloudflare Worker Setup ---

app.get('/', serveStatic({ root: './public', default: 'index.html' }))

// API for general status and LLM provider config
app.get('/api/status', (c) => {
    const llmRouter = new LLMRouter(c.env);
    const availableProviders = Object.keys(llmRouter.providers).map(key => {
        const provider = llmRouter.providers[key];
        return {
            id: key,
            name: provider.name,
            available: !!provider.apiKey || key === 'cloudflare', // Check if API key exists or if it's cloudflare
            models: provider.models,
            configured_models: provider.models.filter(model => {
                if (key === 'cloudflare') return true;
                if (key === 'openrouter' && c.env.OPENROUTER_API_KEY) return true;
                if (key === 'google' && c.env.GEMINI_API_KEY) return true;
                if (key === 'github' && c.env.GITHUB_MODELS_TOKEN) return true;
                if (key === 'huggingface' && c.env.HF_TOKEN) return true;
                return false;
            }),
        };
    });

    return c.json({
        status: 'ok',
        version: '1.0',
        message: 'Viral Radar Worker is operational.',
        llm_providers: availableProviders,
        configured_youtube_api: !!c.env.YOUTUBE_API_KEY,
        configured_apify_api: !!c.env.APIFY_API_TOKEN,
        // Add more status info as needed
    });
});

// API for generating insights
app.post('/api/generate-insights', async (c) => {
    const { topic, reference_channels, llm_provider } = await c.req.json();
    if (!topic) {
        return c.json({ error: 'Topic is required.' }, 400);
    }

    const orchestrator = new Orchestrator(c.env);
    try {
        const state = await orchestrator.execute(topic, reference_channels || [], llm_provider);

        // Map raw_clips_collected to appropriate buckets for frontend
        const youtube_clips = [];
        const tiktok_clips = [];
        const reddit_posts = [];
        const other_clips = [];

        state.raw_clips_collected.forEach(clip => {
            switch (clip.platform) {
                case 'YouTube':
                    youtube_clips.push(clip);
                    break;
                case 'TikTok':
                    tiktok_clips.push(clip);
                    break;
                case 'Reddit':
                    reddit_posts.push(clip);
                    break;
                default:
                    other_clips.push(clip);
            }
        });

        // Ensure editorial_dna is always an object, even if null from agent
        const editorial_dna_output = state.editorial_dna || {
            content_type: "N/A",
            clip_type: "N/A",
            preferred_emotions: [],
            clip_length_range: { min_sec: 0, max_sec: 0 },
            editing_pattern: "N/A",
            source_platforms: [],
            reject_list: []
        };

        const responseData = {
            topic: state.topic,
            ai_actionable_insights: state.ai_actionable_insights,
            raw_evidence_found: {
                youtube_clips: youtube_clips,
                tiktok_clips: tiktok_clips,
                reddit_posts: reddit_posts,
                instagram_reels: [], // Not implemented yet
                facebook_posts: [], // Not implemented yet
                telegram_clips: [], // Not implemented yet
                other_clips: other_clips,
            },
            ranked_clip_opportunities: state.ranked_clip_opportunities,
            summary_report: state.summary_report,
            editorial_dna_profile: editorial_dna_output,
            ref_channel_analysis: state.ref_channel_analysis,
            status_messages: state.status_messages,
            error_messages: state.error_messages,
            processed_at: state.processed_at,
        };
        return c.json(responseData);

    } catch (error) {
        console.error('Orchestration workflow failed:', error);
        return c.json({ error: `Orchestration workflow failed: ${error.message}` }, 500);
    }
});


export default app;
'''))
