Editorial DNA Contract v1.0
This contract freezes the data shapes that flow between agents so "editorial
intelligence" — not raw search relevance or view count — drives every decision.
All agents read/write to this contract. No agent invents its own ad-hoc field
names for DNA-related data. Code must conform to this document, not the other
way around.
1. DNA Profile
Produced by: EditorialDNAExtractionAgent
Input: reference channel URL(s)
Output (or null if no channels / no real data fetched):
Json
clip_archetypes — e.g. "public fail with instant crowd reaction", not generic labels.
hook_patterns — e.g. "cold open on the failure moment, no intro/narration".
emotion_patterns — the viewer's emotional ARC (not a single emotion word), e.g.
"confusion → shock → laugh".
reject_patterns — content types this channel's style explicitly excludes.
ranking_logic — one sentence on what separates a #1 from a #6 for this channel
(e.g. "later ranks = higher unpredictability + stronger payoff timing").
based_on_real_video_count — must be > 0 whenever this object is non-null; if the
agent could not fetch real video data, the whole profile is null, never a guess.
Honesty rule: this profile is built from REAL channel video metadata (title,
description, duration, views) via the YouTube Data API. It is NOT frame-level or
audio-level analysis. ranking_logic and hook_patterns are the LLM's inference
from that metadata, not a verified frame-by-frame fact. This limitation must never
be hidden from the user.
2. Viral Opportunity
Produced by: OpportunityGenerator (powers the 🎲 Dice button)
Input: DNA Profile (if available) + trend/content taxonomy
Output:
Json
This is what the Dice button returns and pre-fills into the topic + creative brief
fields — never a bare random keyword string.
3. Ranked Clip — STRICT, no silent fallback
Produced by: RankingAgent
Every entry in ranked_clip_opportunities MUST include ALL of the following.
There is no optional/partial form.
Json
Rule: REJECT over FALLBACK (hard rule, non-negotiable)
If the LLM does not produce all five required reasoning fields (non-empty) for a
clip, that clip is dropped entirely — not shipped with a placeholder reason.
If zero clips pass this bar, ranked_clip_opportunities = [] and the report
says so honestly ("Ranking could not be generated with the required editorial
reasoning this run — try again or broaden the topic"). The pipeline must not
fall back to a views/likes-only ranking. The previous "50% confidence,
engagement-based fallback" behavior is explicitly banned by this contract.
Rule: Weighted Editorial Score (not view count)
Code
Each sub-score is 0-100, provided by the LLM with the reasoning fields above as
justification. Engagement (views/likes) contributes only 10% of the final score —
a 50M-view clip cannot out-rank a better DNA/moment/emotion match just because it's
popular.
Agent responsibilities under this contract
Agent
Contract obligation
EditorialDNAExtractionAgent
Produces DNA Profile (§1) or null. Never fabricates based_on_real_video_count.
EditorialIntentAgent
Reads DNA Profile if present; still must produce acceptable_event_types/reject_content_types even with no DNA Profile.
OpportunityGenerator
Produces Viral Opportunity (§2) for the Dice button.
DiscoveryStrategyPlannerAgent
Builds search queries from acceptable_event_types, never the raw topic string alone.
SourceHunterAgent
Filters using reject_content_types + DNA reject_patterns before any clip reaches RankingAgent.
RankingAgent
Produces Ranked Clips (§3) under the REJECT-over-FALLBACK rule. No engagement-only fallback path.
This document is the source of truth. If code and this document disagree, the
code is wrong.
