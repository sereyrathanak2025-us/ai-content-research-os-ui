# Editorial DNA Contract v1.0

This contract freezes the data shapes that flow between agents so "editorial
intelligence" — not raw search relevance or view count — drives every decision.
All agents read/write to this contract. No agent invents its own ad-hoc field
names for DNA-related data. Code must conform to this document, not the other
way around.

---

## 1. DNA Profile
**Produced by:** `EditorialDNAExtractionAgent`
**Input:** reference channel URL(s)
**Output (or `null` if no channels / no real data fetched):**

```json
{
  "clip_archetypes": ["string"],
  "hook_patterns": ["string"],
  "emotion_patterns": ["string"],
  "reject_patterns": ["string"],
  "ranking_logic": "string",
  "clip_length_range": { "min_sec": 5, "max_sec": 20 },
  "source_platforms": ["string"],
  "source_channels": ["string"],
  "based_on_real_video_count": 0
}
```

- `clip_archetypes` — e.g. "public fail with instant crowd reaction", not generic labels.
- `hook_patterns` — e.g. "cold open on the failure moment, no intro/narration".
- `emotion_patterns` — the viewer's emotional ARC (not a single emotion word), e.g.
  "confusion → shock → laugh".
- `reject_patterns` — content types this channel's style explicitly excludes.
- `ranking_logic` — one sentence on what separates a #1 from a #6 for this channel
  (e.g. "later ranks = higher unpredictability + stronger payoff timing").
- `based_on_real_video_count` — must be > 0 whenever this object is non-null; if the
  agent could not fetch real video data, the whole profile is `null`, never a guess.

**Honesty rule:** this profile is built from REAL channel video metadata (title,
description, duration, views) via the YouTube Data API. It is NOT frame-level or
audio-level analysis. `ranking_logic` and `hook_patterns` are the LLM's inference
from that metadata, not a verified frame-by-frame fact. This limitation must never
be hidden from the user.

---

## 2. Viral Opportunity
**Produced by:** `OpportunityGenerator` (powers the 🎲 Dice button)
**Input:** DNA Profile (if available) + trend/content taxonomy
**Output:**

```json
{
  "title": "Ranking Don't Trust Your Eyes Moments",
  "format": "Visual illusion + unexpected reveal",
  "viewer_emotion_arc": "Confusion → surprise → laugh",
  "search_strategy": ["caught on camera illusion", "impossible timing", "perspective trick"],
  "reject": ["tutorial", "explanation", "compilation", "news"]
}
```

This is what the Dice button returns and pre-fills into the topic + creative brief
fields — never a bare random keyword string.

---

## 3. Ranked Clip — STRICT, no silent fallback
**Produced by:** `RankingAgent`

Every entry in `ranked_clip_opportunities` MUST include ALL of the following.
There is no optional/partial form.

```json
{
  "rank": 1,
  "moment_idea": "string",
  "suggested_source_platform": "string",
  "url_to_potential_original_clip": "string",
  "style_dna_match_reason": "string — required, non-empty",
  "countdown_position_reason": "string — required, non-empty, why THIS rank not another",
  "viral_mechanism": "string — required, non-empty",
  "emotion_trigger": "string — required, non-empty",
  "source_confidence": "string — required, non-empty, why this looks like an original source (not just 'high views')",
  "score_breakdown": {
    "style_dna_match": 0,
    "moment_strength": 0,
    "viewer_emotion": 0,
    "original_source": 0,
    "engagement": 0
  },
  "final_score": 0
}
```

### Rule: REJECT over FALLBACK (hard rule, non-negotiable)
If the LLM does not produce all five required reasoning fields (non-empty) for a
clip, that clip is dropped entirely — not shipped with a placeholder reason.

If **zero** clips pass this bar, `ranked_clip_opportunities = []` and the report
says so honestly ("Ranking could not be generated with the required editorial
reasoning this run — try again or broaden the topic"). The pipeline **must not**
fall back to a views/likes-only ranking. The previous "50% confidence,
engagement-based fallback" behavior is explicitly banned by this contract.

### Rule: Weighted Editorial Score (not view count)
```
final_score =
    style_dna_match  * 0.30 +
    moment_strength  * 0.25 +
    viewer_emotion   * 0.20 +
    original_source  * 0.15 +
    engagement       * 0.10
```
Each sub-score is 0-100, provided by the LLM with the reasoning fields above as
justification. Engagement (views/likes) contributes only 10% of the final score —
a 50M-view clip cannot out-rank a better DNA/moment/emotion match just because it's
popular.

---

## Agent responsibilities under this contract

| Agent | Contract obligation |
|---|---|
| `EditorialDNAExtractionAgent` | Produces DNA Profile (§1) or `null`. Never fabricates `based_on_real_video_count`. |
| `EditorialIntentAgent` | Reads DNA Profile if present; still must produce `acceptable_event_types`/`reject_content_types` even with no DNA Profile. |
| `OpportunityGenerator` | Produces Viral Opportunity (§2) for the Dice button. |
| `DiscoveryStrategyPlannerAgent` | Builds search queries from `acceptable_event_types`, never the raw topic string alone. |
| `SourceHunterAgent` | Filters using `reject_content_types` + DNA `reject_patterns` before any clip reaches RankingAgent. |
| `RankingAgent` | Produces Ranked Clips (§3) under the REJECT-over-FALLBACK rule. No engagement-only fallback path. |

---

*This document is the source of truth. If code and this document disagree, the
code is wrong.*
