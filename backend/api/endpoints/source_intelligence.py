# backend/api/endpoints/source_intelligence.py

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone

from backend.models.db import get_db, Creator # Assuming Creator is available for DB writes
from backend.core.logger import log

# Import your services for deterministic analysis
from backend.services.discovery_engine import discovery_engine_service
from backend.services.ranking_engine import ranking_engine_service
from backend.services.trend_analysis_service import trend_analysis_service
# Assuming you have an SEO service or will derive SEO from ranking_engine output
# from backend.services.seo_service import seo_service
# from backend.services.multimodal_engine import multimodal_engine_service # for semantic tags, if used

router = APIRouter(prefix="/source-intelligence", tags=["Source Intelligence"])


# --- Pydantic Models for "Evidence Contract" ---
class RawClipEvidence(BaseModel):
    url: str
    platform: str
    title: str
    description_snippet: Optional[str] = None
    upload_date_approx: Optional[str] = None
    views_approx: Optional[int] = None
    likes_approx: Optional[int] = None
    upvotes_approx: Optional[int] = None
    comments_approx: Optional[int] = None
    shares_approx: Optional[int] = None
    channel: Optional[str] = None
    tags: Optional[List[str]] = []
    source_type: str = Field(..., description="e.g., YouTube_API, Web_Search_RuFlo, TikTok_Scraper")
    
    # Optional fields for backend processing, not necessarily from frontend
    id: Optional[str] = None # For internal deduplication/tracking
    external_id: Optional[str] = None # Original platform ID

class EditorialObjective(BaseModel):
    topic: str
    creative_brief: str
    reference_channels: List[str]
    date_filter: str

class DeterministicAnalysisRequest(BaseModel):
    editorial_objective: EditorialObjective
    niche_profile: List[str]
    research_plan: List[str]
    editorial_dna: Dict[str, Any]
    raw_evidence: Dict[str, List[RawClipEvidence]]


class DeterministicAnalysisResponse(BaseModel):
    # This will contain all deterministic facts derived by your Python Backend
    processed_clips: List[Dict[str, Any]] # Enriched clips with backend scores/flags
    trend_briefing: List[Dict[str, Any]]
    overall_trend_status: str
    # Other backend-derived deterministic facts
    # E.g., duplicate clusters, likely original candidates (from deterministic logic)


# --- Internal Helper for Duplicate/Original Heuristics (Deterministic) ---
def _identify_likely_original_and_reposts(clips: List[RawClipEvidence]) -> List[Dict[str, Any]]:
    # This is a simplified deterministic heuristic.
    # A more robust system would involve semantic similarity via embeddings (Multimodal Engine).
    log.info("[Python Backend] Identifying likely originals and reposts deterministically...")
    
    clips_with_meta = []
    for clip in clips:
        clip_data = clip.model_dump()
        # Convert upload_date_approx to datetime object for comparison
        if clip_data.get('upload_date_approx'):
            try:
                clip_data['upload_dt'] = datetime.fromisoformat(clip_data['upload_date_approx'].replace('Z', '+00:00'))
            except ValueError:
                clip_data['upload_dt'] = None
        else:
            clip_data['upload_dt'] = None
        
        # Assign a 'determinism_score' - higher if API, earlier date, higher engagement
        score = 0
        if clip_data['source_type'] == "YouTube_API": score += 100
        elif clip_data['source_type'] == "TikTok_Scraper": score += 80 # Assuming scraper is somewhat reliable
        elif clip_data['source_type'] == "Web_Search_RuFlo": score += 50
        
        score += (clip_data.get('views_approx', 0) / 1000000) * 10 # Scale views
        score += (clip_data.get('likes_approx', 0) / 10000) * 5   # Scale likes
        
        clip_data['determinism_score'] = score
        clips_with_meta.append(clip_data)

    # Sort to find the earliest/highest scoring
    clips_with_meta.sort(key=lambda x: (x['upload_dt'] or datetime.min, x['determinism_score']), reverse=False)

    processed_clips_for_ai = []
    seen_titles = set()
    
    for i, current_clip in enumerate(clips_with_meta):
        is_original_candidate = False
        repost_analysis = []
        
        # Simple duplicate check and original candidate identification
        if current_clip['title'] not in seen_titles:
            is_original_candidate = True
            seen_titles.add(current_clip['title']) # Mark title as seen for originals
            
            # Check for potential reposts of this candidate
            for other_clip in clips_with_meta:
                if other_clip['url'] != current_clip['url'] and other_clip['title'] == current_clip['title']:
                    if current_clip['upload_dt'] and other_clip['upload_dt'] and other_clip['upload_dt'] > current_clip['upload_dt']:
                        time_diff = other_clip['upload_dt'] - current_clip['upload_dt']
                        repost_analysis.append(f"Reposted on {other_clip['platform']} ({other_clip['channel'] or 'unknown channel'}) ~{time_diff.days} days later.")
                    else:
                        repost_analysis.append(f"Similar clip found on {other_clip['platform']} ({other_clip['channel'] or 'unknown channel'}).")
        else:
            repost_analysis.append(f"This clip appears to be a repost of an earlier version.")

        processed_clips_for_ai.append({
            "clip": current_clip,
            "is_likely_original_candidate": is_original_candidate,
            "repost_analysis_text": ". ".join(repost_analysis) if repost_analysis else "No explicit reposts or earlier versions identified based on current evidence.",
            "originality_confidence_score_backend": min(100, current_clip['determinism_score'] / 10), # Scale for LLM
        })
    
    # Sort again, to prioritize original candidates for LLM analysis
    processed_clips_for_ai.sort(key=lambda x: x["is_likely_original_candidate"] and x["clip"]["determinism_score"], reverse=True)

    return processed_clips_for_ai


@router.post("/source-intelligence-process", response_model=DeterministicAnalysisResponse)
async def process_source_intelligence(
    req: DeterministicAnalysisRequest,
    db: Session = Depends(get_db),
) -> DeterministicAnalysisResponse:
    """
    Receives raw evidence from Cloudflare Worker, performs deterministic analysis,
    and returns structured facts to the Worker for final AI insights generation.
    """
    log.info(f"[Python Backend] Received Source Intelligence request for topic: {req.editorial_objective.topic}")
    
    all_clips: List[RawClipEvidence] = []
    for platform_clips in req.raw_evidence.values():
        all_clips.extend(platform_clips)

    # --- Step 1: Deterministic Duplicate/Original Identification ---
    # This uses a heuristic based on available data, not LLM guessing
    processed_clips_for_ai = _identify_likely_original_and_reposts(all_clips)
    
    # --- Step 2: Deterministic Ranking and Trend Analysis ---
    # Use existing services with the processed clip data
    
    # Mock / Fallback for clips to fit RankingEngine input if needed
    ranking_candidates = []
    for pc in processed_clips_for_ai:
        clip_data = pc['clip']
        ranking_candidates.append({
            "id": clip_data.get('id') or clip_data.get('url'),
            "title": clip_data.get('title'),
            "platform": clip_data.get('platform'),
            "semantic_score": 0.7, # Placeholder, MultimodalEngine would compute this
            "views": clip_data.get('views_approx', 0),
            "likes": clip_data.get('likes_approx', 0),
            "age_days": (datetime.now(timezone.utc) - datetime.fromisoformat(clip_data['published_at'].replace('Z', '+00:00'))).days if clip_data.get('published_at') else 30,
            "followers": 0, # Placeholder
            "creator": clip_data.get('channel', 'unknown'),
            "tags": clip_data.get('tags', []),
        })
    
    ranked_clips = ranking_engine_service.rank(ranking_candidates, user_id="ai_orchestrator")
    
    # Trend Analysis (can be applied to overall topic or specific creators)
    # For simplicity, we'll give a generic trend status for the topic
    # A more complex integration would use trend_analysis_service for specific creators.
    overall_trend_status = trend_analysis_service._get_trend_lifecycle(
        velocity=len(all_clips) / 5, # Simple heuristic
        mentions_7d=len(all_clips) # Simple heuristic
    )
    
    # --- Step 3: Compile Deterministic Facts for Worker ---
    backend_derived_facts = {
        "processed_clips_for_ai": processed_clips_for_ai, # Includes originality/repost insights
        "ranked_clips_by_backend": ranked_clips, # Deterministic ranking
        "overall_trend_status": overall_trend_status,
        "niche_profile_backend_confirmed": req.niche_profile, # Pass back for LLM context
        "editorial_dna_backend_interpreted": req.editorial_dna, # Pass back for LLM context
    }

    log.info("[Python Backend] ✅ Deterministic analysis complete. Returning facts to Worker.")
    return DeterministicAnalysisResponse(**backend_derived_facts)
