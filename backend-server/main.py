import os
import re
import urllib.parse
import asyncio
import logging
import traceback
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from supabase import create_client, Client

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("music-middleware")

app = FastAPI(title="Resonate Music Middleware", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Environment Variables & Configuration
RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST = os.getenv("RAPIDAPI_HOST", "youtube-mp36.p.rapidapi.com")

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ldrqckeoxfwkgxtcgluv.supabase.co")
SUPABASE_KEY = os.getenv(
    "SUPABASE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxkcnFja2VveGZ3a2d4dGNnbHV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NzI4MzksImV4cCI6MjEwNDQ0ODgzOX0.NK_VerOkxWZCe6qtobNxNFpyPMlMP50HS4UXVoMQ0iM"
)
SUPABASE_BUCKET = os.getenv("SUPABASE_BUCKET", "music")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Sequential lock to prevent RAM exhaustion on Render 512MB limit during memory-buffer operations
ingest_lock = asyncio.Lock()


class IngestRequest(BaseModel):
    query: str


def extract_youtube_video_id(query: str) -> Optional[str]:
    """
    Extracts an 11-character YouTube video ID from various URL formats or returns
    the query itself if it is already an 11-character ID.
    """
    cleaned = query.strip()
    if re.fullmatch(r"[a-zA-Z0-9_-]{11}", cleaned):
        return cleaned

    patterns = [
        r"(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})",
        r"(?:[\?&]v=)([a-zA-Z0-9_-]{11})"
    ]
    for pattern in patterns:
        match = re.search(pattern, cleaned)
        if match:
            return match.group(1)

    return None


async def resolve_video_id(client: httpx.AsyncClient, query: str) -> str:
    """
    Resolves a search query (song title + artist) or YouTube URL to a valid video ID.
    """
    extracted_id = extract_youtube_video_id(query)
    if extracted_id:
        logger.info(f"[Resolver] Direct YouTube ID extracted: {extracted_id}")
        return extracted_id

    # Fallback: Query YouTube public search page to get top video ID
    logger.info(f"[Resolver] Searching YouTube for query: '{query}'")
    search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(query)}"
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
    }

    try:
        res = await client.get(search_url, headers=headers)
        if res.status_code == 200:
            found_ids = re.findall(r"watch\?v=([a-zA-Z0-9_-]{11})", res.text)
            if found_ids:
                logger.info(f"[Resolver] Resolved query '{query}' to video ID: {found_ids[0]}")
                return found_ids[0]
    except Exception as e:
        logger.warning(f"[Resolver] YouTube search scrape failed: {e}")

    # If resolution was unable to match, fall back to cleaned query string
    return query.strip()


def sanitize_filename(title: str, fallback_id: str) -> str:
    """
    Removes invalid characters for storage path while preserving readability.
    """
    clean = re.sub(r'[\\/*?:"<>|]', "", title).strip()
    if not clean:
        clean = f"track_{fallback_id}"
    if clean.lower().endswith(".mp3"):
        clean = clean[:-4].strip()
    return f"{clean}.mp3"


@app.get("/health")
async def health():
    return {"status": "ok"}


async def process_ingestion(query: str):
    clean_query = query.strip()
    if not clean_query:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    if not RAPIDAPI_KEY:
        logger.error("[Ingest] RAPIDAPI_KEY environment variable is not configured.")
        raise HTTPException(
            status_code=500,
            detail="RAPIDAPI_KEY is not set. Please configure RAPIDAPI_KEY in server environment variables."
        )

    async with ingest_lock:
        logger.info(f"[Ingest] Initiating ingestion for: '{clean_query}'")

        async with httpx.AsyncClient(timeout=60.0) as client:
            # 1. Resolve video ID from query
            video_id = await resolve_video_id(client, clean_query)

            # 2. Call RapidAPI YouTube MP3 endpoint (youtube-mp36)
            rapidapi_url = f"https://{RAPIDAPI_HOST}/dl"
            rapidapi_headers = {
                "X-RapidAPI-Key": RAPIDAPI_KEY,
                "X-RapidAPI-Host": RAPIDAPI_HOST,
            }
            params = {"id": video_id}

            logger.info(f"[RapidAPI] Calling {rapidapi_url} with id='{video_id}'...")
            try:
                rapid_resp = await client.get(rapidapi_url, headers=rapidapi_headers, params=params)
            except httpx.TimeoutException:
                logger.error("[RapidAPI] Request timed out after 60 seconds.")
                raise HTTPException(status_code=504, detail="RapidAPI request timed out after 60 seconds.")
            except Exception as e:
                logger.error(f"[RapidAPI] Network request error: {e}")
                raise HTTPException(status_code=502, detail=f"Failed to communicate with RapidAPI: {str(e)}")

            logger.info(f"[RapidAPI] Status: {rapid_resp.status_code}")
            if rapid_resp.status_code != 200:
                logger.error(f"[RapidAPI] Error response ({rapid_resp.status_code}): {rapid_resp.text}")
                raise HTTPException(
                    status_code=502,
                    detail=f"RapidAPI returned error status {rapid_resp.status_code}: {rapid_resp.text}"
                )

            try:
                payload = rapid_resp.json()
            except Exception:
                logger.error(f"[RapidAPI] Non-JSON response received: {rapid_resp.text}")
                raise HTTPException(
                    status_code=502,
                    detail=f"RapidAPI returned non-JSON response: {rapid_resp.text[:300]}"
                )

            logger.info(f"[RapidAPI] Payload: {payload}")

            # Check for API error status inside payload
            status_field = str(payload.get("status", "")).lower()
            if status_field in ("fail", "error") or payload.get("error"):
                err_msg = payload.get("msg") or payload.get("message") or payload.get("error") or "Unknown RapidAPI error"
                logger.error(f"[RapidAPI] Ingestion failed with payload message: {err_msg}")
                raise HTTPException(status_code=502, detail=f"RapidAPI failed to convert track: {err_msg}")

            # Extract MP3 download URL
            download_url = (
                payload.get("link")
                or payload.get("download_url")
                or payload.get("dl_link")
                or payload.get("mp3")
                or payload.get("url")
            )
            if not download_url and isinstance(payload.get("data"), dict):
                download_url = (
                    payload["data"].get("link")
                    or payload["data"].get("download_url")
                    or payload["data"].get("dl_link")
                    or payload["data"].get("mp3")
                    or payload["data"].get("url")
                )
            if not download_url and isinstance(payload.get("result"), dict):
                download_url = (
                    payload["result"].get("link")
                    or payload["result"].get("download_url")
                    or payload["result"].get("dl_link")
                    or payload["result"].get("mp3")
                )

            if not download_url:
                logger.error(f"[RapidAPI] Could not find download URL in payload: {payload}")
                raise HTTPException(
                    status_code=502,
                    detail="RapidAPI response did not contain a valid MP3 download URL."
                )

            # Extract and sanitize title
            raw_title = payload.get("title")
            if not raw_title and isinstance(payload.get("data"), dict):
                raw_title = payload["data"].get("title")
            if not raw_title:
                raw_title = clean_query

            filename = sanitize_filename(raw_title, video_id)
            clean_title = filename[:-4]

            # 3. Stream / fetch audio content directly into memory
            logger.info(f"[Audio Stream] Fetching audio from download link: {download_url[:100]}...")
            try:
                audio_resp = await client.get(download_url, follow_redirects=True)
            except httpx.TimeoutException:
                logger.error("[Audio Stream] Download link request timed out.")
                raise HTTPException(status_code=504, detail="Audio download link timed out.")
            except Exception as e:
                logger.error(f"[Audio Stream] Failed to stream audio bytes: {e}")
                raise HTTPException(status_code=502, detail=f"Failed to fetch audio stream: {str(e)}")

            if audio_resp.status_code != 200:
                logger.error(f"[Audio Stream] Download returned status {audio_resp.status_code}")
                raise HTTPException(
                    status_code=502,
                    detail=f"Audio provider returned status {audio_resp.status_code} when fetching audio bytes."
                )

            audio_bytes = audio_resp.content
            if not audio_bytes:
                logger.error("[Audio Stream] Audio payload was empty.")
                raise HTTPException(status_code=502, detail="Fetched audio stream was empty.")

            logger.info(f"[Audio Stream] Successfully fetched {len(audio_bytes)} bytes into memory.")

            # 4. Upload in-memory bytes directly to Supabase Storage
            def upload_to_supabase() -> str:
                logger.info(f"[Supabase] Uploading '{filename}' ({len(audio_bytes)} bytes) to bucket '{SUPABASE_BUCKET}'...")
                res = supabase.storage.from_(SUPABASE_BUCKET).upload(
                    path=filename,
                    file=audio_bytes,
                    file_options={"content-type": "audio/mpeg", "upsert": "true"}
                )
                logger.info(f"[Supabase] Upload successful: {res}")
                public_url = supabase.storage.from_(SUPABASE_BUCKET).get_public_url(filename)
                return public_url

            try:
                stream_url = await asyncio.to_thread(upload_to_supabase)
                logger.info(f"[Supabase] Stream URL generated: {stream_url}")
            except Exception as e:
                logger.error(f"[Supabase] Upload error: {e}")
                traceback.print_exc()
                raise HTTPException(
                    status_code=500,
                    detail=f"Supabase storage upload failed: {str(e)}"
                )

            # Extract duration if provided by RapidAPI
            duration = payload.get("duration")

            # 5. Return JSON matching frontend expectations
            return {
                "status": "completed",
                "title": filename,
                "stream_url": stream_url,
                "duration": duration,
                "song": {
                    "id": filename,
                    "title": clean_title,
                    "artist": "Cloud Ingestion",
                    "stream_url": stream_url,
                    "duration": duration
                }
            }


@app.get("/api/search-and-ingest")
async def search_and_ingest_get(query: str = Query(...)):
    return await process_ingestion(query)


@app.post("/api/search-and-ingest")
async def search_and_ingest_post(req: IngestRequest):
    return await process_ingestion(req.query)


# Mount Web UI if present
WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")