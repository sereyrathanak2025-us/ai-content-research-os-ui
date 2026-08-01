/**
 * Data Enricher for AI Research Command Center
 * Fetches real-world data from YouTube, TikTok, Reddit
 * Used by the main Worker to enrich LLM prompts with grounded intelligence
 */

const DATA_ENRICHER = {
  /**
   * Fetch trending videos from YouTube Data API
   * Requires: YOUTUBE_API_KEY env var
   */
  async fetchYouTubeTrends(topic, platform = "youtube") {
    const apiKey = YOUTUBE_API_KEY; // Set in Worker secrets
    if (!apiKey) {
      console.warn("YOUTUBE_API_KEY not configured");
      return { success: false, error: "YouTube API key missing" };
    }

    try {
      const query = encodeURIComponent(topic);
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${query}&type=video&order=relevance&key=${apiKey}`;

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`YouTube API returned ${response.status}`);
      }

      const data = await response.json();
      
      if (!data.items || data.items.length === 0) {
        return { success: true, data: [], message: "No YouTube videos found for topic" };
      }

      const videos = data.items.map(item => ({
        id: item.id.videoId,
        title: item.snippet.title,
        channel: item.snippet.channelTitle,
        description: item.snippet.description.substring(0, 150),
        thumbnail: item.snippet.thumbnails.medium.url,
        publishedAt: item.snippet.publishedAt,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`
      }));

      return {
        success: true,
        data: videos,
        message: `Found ${videos.length} YouTube videos for "${topic}"`
      };

    } catch (error) {
      console.error("YouTube fetch error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Fetch trending content from TikTok via Apify
   * Requires: APIFY_API_TOKEN env var
   */
  async fetchTikTokTrends(topic) {
    const apiToken = APIFY_API_TOKEN; // Set in Worker secrets
    if (!apiToken) {
      console.warn("APIFY_API_TOKEN not configured");
      return { success: false, error: "Apify token missing" };
    }

    try {
      const actorId = "clockworks/tiktok-video-downloader"; // Or use hashtag trend actor
      const input = {
        hashtag: topic.replace(/\s+/g, ""), // TikTok hashtags don't have spaces
        postsLimit: 10,
        getStats: true
      };

      const response = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs?token=${apiToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input })
        }
      );

      if (!response.ok) {
        throw new Error(`Apify API returned ${response.status}`);
      }

      const runData = await response.json();
      const runId = runData.data.id;

      // Poll for completion (simplified — in prod, use Apify's wait mechanism)
      await new Promise(resolve => setTimeout(resolve, 3000));

      const resultsResponse = await fetch(
        `https://api.apify.com/v2/acts/${actorId}/runs/${runId}/dataset/items?token=${apiToken}`
      );

      if (!resultsResponse.ok) {
        throw new Error("Failed to fetch Apify results");
      }

      const items = await resultsResponse.json();

      const videos = items.slice(0, 10).map(item => ({
        id: item.id || item.videoId,
        title: item.description || item.text || "(No description)",
        author: item.authorName || item.author || "Unknown",
        views: item.playCount || 0,
        likes: item.diggCount || 0,
        shares: item.shareCount || 0,
        comments: item.commentCount || 0,
        url: item.webVideoUrl || item.videoUrl || "",
        createdAt: item.createTime || item.createDate
      }));

      return {
        success: true,
        data: videos,
        message: `Found ${videos.length} TikTok videos for #${topic}`
      };

    } catch (error) {
      console.error("TikTok/Apify fetch error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Fetch trending topics/discussions from Reddit
   * Requires: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET env vars
   */
  async fetchRedditTrends(topic) {
    const clientId = REDDIT_CLIENT_ID; // Set in Worker secrets
    const clientSecret = REDDIT_CLIENT_SECRET; // Set in Worker secrets
    if (!clientId || !clientSecret) {
      console.warn("Reddit credentials not configured");
      return { success: false, error: "Reddit API credentials missing" };
    }

    try {
      // Step 1: Authenticate with Reddit
      const authResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`)
        },
        body: "grant_type=client_credentials"
      });

      if (!authResponse.ok) {
        throw new Error(`Reddit auth failed: ${authResponse.status}`);
      }

      const { access_token } = await authResponse.json();

      // Step 2: Search Reddit
      const searchUrl = `https://oauth.reddit.com/r/all/search?q=${encodeURIComponent(topic)}&type=link&sort=top&t=week&limit=10`;
      const searchResponse = await fetch(searchUrl, {
        headers: { "Authorization": `Bearer ${access_token}`, "User-Agent": "AIResearchOS" }
      });

      if (!searchResponse.ok) {
        throw new Error(`Reddit search failed: ${searchResponse.status}`);
      }

      const searchData = await searchResponse.json();
      const posts = searchData.data?.children || [];

      const threads = posts.map(post => ({
        id: post.data.id,
        title: post.data.title,
        subreddit: post.data.subreddit,
        upvotes: post.data.ups,
        comments: post.data.num_comments,
        author: post.data.author,
        url: `https://reddit.com${post.data.permalink}`,
        created: post.data.created_utc,
        selftext: post.data.selftext.substring(0, 200)
      }));

      return {
        success: true,
        data: threads,
        message: `Found ${threads.length} Reddit discussions about "${topic}"`
      };

    } catch (error) {
      console.error("Reddit fetch error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Enrich a discovery prompt with real data
   * Aggregates all sources
   */
  async enrichDiscoveryPrompt(topic, platform) {
    let enrichedData = {
      topic,
      platform,
      youtubeVideos: [],
      tiktokVideos: [],
      redditThreads: [],
      enrichmentErrors: []
    };

    // Fetch in parallel
    const results = await Promise.allSettled([
      platform === "youtube" || platform === "all"
        ? this.fetchYouTubeTrends(topic)
        : Promise.resolve({ success: false }),
      platform === "tiktok" || platform === "all"
        ? this.fetchTikTokTrends(topic)
        : Promise.resolve({ success: false }),
      platform === "reddit" || platform === "all"
        ? this.fetchRedditTrends(topic)
        : Promise.resolve({ success: false })
    ]);

    // Process results
    if (results[0].status === "fulfilled" && results[0].value.success) {
      enrichedData.youtubeVideos = results[0].value.data;
    } else if (results[0].status === "fulfilled") {
      enrichedData.enrichmentErrors.push(`YouTube: ${results[0].value.error}`);
    }

    if (results[1].status === "fulfilled" && results[1].value.success) {
      enrichedData.tiktokVideos = results[1].value.data;
    } else if (results[1].status === "fulfilled") {
      enrichedData.enrichmentErrors.push(`TikTok: ${results[1].value.error}`);
    }

    if (results[2].status === "fulfilled" && results[2].value.success) {
      enrichedData.redditThreads = results[2].value.data;
    } else if (results[2].status === "fulfilled") {
      enrichedData.enrichmentErrors.push(`Reddit: ${results[2].value.error}`);
    }

    return enrichedData;
  },

  /**
   * Format enriched data into a context string for LLM
   */
  formatDataContext(enrichedData) {
    let context = `\n\n=== REAL-WORLD DATA GROUNDING ===\n`;

    if (enrichedData.youtubeVideos.length > 0) {
      context += `\nYouTube Trending Videos:\n`;
      enrichedData.youtubeVideos.forEach((video, i) => {
        context += `${i + 1}. "${video.title}" by ${video.channel}\n   Views: N/A | Published: ${video.publishedAt}\n`;
      });
    }

    if (enrichedData.tiktokVideos.length > 0) {
      context += `\nTikTok Trending Videos:\n`;
      enrichedData.tiktokVideos.forEach((video, i) => {
        context += `${i + 1}. "${video.title}" by @${video.author}\n   Views: ${video.views} | Likes: ${video.likes} | Comments: ${video.comments}\n`;
      });
    }

    if (enrichedData.redditThreads.length > 0) {
      context += `\nReddit Trending Discussions:\n`;
      enrichedData.redditThreads.forEach((thread, i) => {
        context += `${i + 1}. "${thread.title}" in r/${thread.subreddit}\n   Upvotes: ${thread.upvotes} | Comments: ${thread.comments}\n`;
      });
    }

    if (enrichedData.enrichmentErrors.length > 0) {
      context += `\nData Enrichment Notes: ${enrichedData.enrichmentErrors.join("; ")}\n`;
    }

    return context;
  }
};

export default DATA_ENRICHER;
