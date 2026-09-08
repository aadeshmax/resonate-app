import os
import sys
import shutil
import time
import subprocess
import requests
from enum import Enum
from typing import Dict, Optional
from fastapi import FastAPI, BackgroundTasks, Query, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="Resonate Music Middleware", version="1.0.0")

# Allow requests from mobile app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
NAVIDROME_URL = os.getenv("NAVIDROME_URL", "http://localhost:4533")
SUBSONIC_USER = os.getenv("SUBSONIC_USER", "admin")
SUBSONIC_PASS = os.getenv("SUBSONIC_PASS", "admin_password")
DEFAULT_MUSIC_DIR = "/shared-music" if os.name != 'nt' else os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "music_data"))
MUSIC_DIR = os.getenv("MUSIC_DIR", DEFAULT_MUSIC_DIR)


class JobStatus(str, Enum):
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    SCANNING = "scanning"
    READY = "ready"
    FAILED = "failed"

# In-memory registry to track active and recent ingestion tasks
# query -> {"status": JobStatus, "song": dict | None, "error": str | None, "updated_at": float}
active_jobs: Dict[str, dict] = {}

def get_subsonic_params() -> dict:
    """Returns standard Subsonic authentication parameters."""
    return {
        "u": SUBSONIC_USER,
        "p": SUBSONIC_PASS,
        "v": "1.16.1",
        "c": "FastAPIMiddleware",
        "f": "json"
    }

def search_navidrome(query: str) -> list:
    """Searches the existing Navidrome library for matching tracks."""
    search_url = f"{NAVIDROME_URL}/rest/search3.view"
    params = {**get_subsonic_params(), "query": query}
    try:
        res = requests.get(search_url, params=params, timeout=10)
        res.raise_for_status()
        data = res.json()
        search_results = data.get("subsonic-response", {}).get("searchResult3", {})
        return search_results.get("song", [])
    except Exception as e:
        print(f"[Navidrome] Search error for '{query}': {e}")
        return []

def wait_for_navidrome_scan(timeout_seconds: int = 40) -> bool:
    """Triggers Navidrome scan and polls until scanning is complete."""
    start_url = f"{NAVIDROME_URL}/rest/startScan.view"
    status_url = f"{NAVIDROME_URL}/rest/getScanStatus.view"
    params = get_subsonic_params()

    try:
        print("[Navidrome] Triggering rescan...")
        requests.get(start_url, params=params, timeout=5)
    except Exception as e:
        print(f"[Navidrome] Failed to trigger rescan: {e}")
        return False

    start_time = time.time()
    time.sleep(1.5)  # Give Navidrome a moment to start the scan

    while time.time() - start_time < timeout_seconds:
        try:
            res = requests.get(status_url, params=params, timeout=5)
            if res.status_code == 200:
                scan_status = res.json().get("subsonic-response", {}).get("scanStatus", {})
                is_scanning = scan_status.get("scanning", False)
                if not is_scanning:
                    print(f"[Navidrome] Scan completed successfully. Total tracks: {scan_status.get('count', 'N/A')}")
                    return True
        except Exception as e:
            print(f"[Navidrome] Error checking scan status: {e}")
        time.sleep(2)

    print("[Navidrome] Rescan polling timed out.")
    return False

def categorize_spotdl_error(output_text: str, return_code: int) -> str:
    """Categorizes spotDL failures into friendly, actionable error messages."""
    text = output_text.lower()

    # 1. Invalid or non-existent Spotify URLs
    if any(k in text for k in [
        "invalid spotify url", "not a valid spotify", "spotifyexception",
        "cannot find song", "could not find any songs", "404", "not found"
    ]):
        return "Invalid Spotify URL or song not found on Spotify."

    # 2. Region-locked, georestricted, or age-restricted content
    if any(k in text for k in [
        "not available in your country", "unavailable in your country",
        "georestricted", "region locked", "sign in to confirm your age",
        "content warning", "restricted by region"
    ]):
        return "Track is region-locked or restricted by copyright in this region."

    # 3. Missing YouTube audio / matching failure
    if any(k in text for k in [
        "audioprovidererror", "could not match any songs", "no results found on youtube",
        "no audio stream", "video unavailable", "this video is private", "not found on youtube",
        "nomatcherror"
    ]):
        return "No matching audio stream or YouTube metadata found for this track."

    # 4. Rate-limiting / Bot detection
    if any(k in text for k in ["too many requests", "429", "bot detection", "sign in to confirm you're not a bot"]):
        return "Streaming provider rate limit or bot check encountered. Try again in a few moments."

    # 5. FFmpeg failure
    if any(k in text for k in ["ffmpeg", "conversion failed"]):
        return "Audio conversion error with FFmpeg. Verify local FFmpeg installation."

    # Fallback to sanitized tail of stderr/stdout
    clean_snippet = output_text.strip().replace("\r", " ").replace("\n", " ")
    if len(clean_snippet) > 140:
        clean_snippet = clean_snippet[-140:]
    return f"Download failed (exit code {return_code}): {clean_snippet or 'Unknown spotDL error'}"


def process_download(query: str):
    """
    Executes spotDL download followed by Navidrome scan and state update.
    Robustly handles invalid URLs, region locks, missing YouTube metadata,
    and isolates errors to prevent Uvicorn from crashing.
    """
    clean_query = query.strip()
    active_jobs[clean_query] = {
        "status": JobStatus.DOWNLOADING,
        "song": None,
        "error": None,
        "updated_at": time.time()
    }

    try:
        print(f"[spotDL] Starting download for query: '{clean_query}'")
        os.makedirs(MUSIC_DIR, exist_ok=True)

        output_template = os.path.join(MUSIC_DIR, "{artist}", "{album}", "{title}.{ext}")
        spotdl_exe = shutil.which("spotdl") or os.path.join(
            os.path.dirname(sys.executable), "spotdl.exe" if os.name == 'nt' else "spotdl"
        )

        cmd = [
            spotdl_exe,
            "download",
            clean_query,
            "--output",
            output_template
        ]

        try:
            process = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=180,
                encoding="utf-8",
                errors="replace"
            )
            combined_output = f"{process.stdout or ''}\n{process.stderr or ''}".strip()
        except subprocess.TimeoutExpired:
            timeout_msg = "Download timed out after 3 minutes (audio stream source is slow or unreachable)."
            print(f"[spotDL] {timeout_msg} for query '{clean_query}'")
            active_jobs[clean_query] = {
                "status": JobStatus.FAILED,
                "song": None,
                "error": timeout_msg,
                "updated_at": time.time()
            }
            return
        except FileNotFoundError:
            missing_err = f"spotDL executable not found at '{spotdl_exe}'"
            print(f"[spotDL] {missing_err}")
            active_jobs[clean_query] = {
                "status": JobStatus.FAILED,
                "song": None,
                "error": missing_err,
                "updated_at": time.time()
            }
            return

        # Check for failure exit codes or failure keywords in output
        failure_detected = process.returncode != 0 or any(kw in combined_output.lower() for kw in [
            "could not match any songs", "audioprovidererror", "invalid spotify url",
            "not available in your country", "spotifyexception"
        ])

        if failure_detected:
            friendly_error = categorize_spotdl_error(combined_output, process.returncode)
            print(f"[spotDL] Download error for '{clean_query}': {friendly_error}")
            active_jobs[clean_query] = {
                "status": JobStatus.FAILED,
                "song": None,
                "error": friendly_error,
                "updated_at": time.time()
            }
            return

        # Download succeeded - synchronize with Navidrome
        print(f"[spotDL] Download finished successfully for '{clean_query}'. Synchronizing with Navidrome...")
        active_jobs[clean_query]["status"] = JobStatus.SCANNING
        active_jobs[clean_query]["updated_at"] = time.time()

        wait_for_navidrome_scan(timeout_seconds=45)

        # Check library for downloaded song
        songs = search_navidrome(clean_query)
        if songs:
            print(f"[Navidrome] Track indexed successfully: {songs[0].get('title')} - {songs[0].get('artist')}")
            active_jobs[clean_query] = {
                "status": JobStatus.READY,
                "song": songs[0],
                "error": None,
                "updated_at": time.time()
            }
        else:
            print(f"[Navidrome] Scan completed but track '{clean_query}' not yet matched in index.")
            active_jobs[clean_query] = {
                "status": JobStatus.READY,
                "song": None,
                "error": "Track downloaded, but Navidrome index is pending. Retry in a moment.",
                "updated_at": time.time()
            }

    except Exception as e:
        print(f"[Ingestion] Exception during download of '{clean_query}': {e}")
        active_jobs[clean_query] = {
            "status": JobStatus.FAILED,
            "song": None,
            "error": f"Internal download error: {str(e)}",
            "updated_at": time.time()
        }
    except BaseException as be:
        print(f"[Ingestion] Fatal system error prevented during download of '{clean_query}': {be}")
        active_jobs[clean_query] = {
            "status": JobStatus.FAILED,
            "song": None,
            "error": "Download worker encountered an unexpected process fault.",
            "updated_at": time.time()
        }


# Alias for backward compatibility with existing route handlers
background_ingest_task = process_download

@app.get("/api/search-and-ingest")
def search_and_ingest(
    request: Request,
    background_tasks: BackgroundTasks,
    query: str = Query(..., min_length=1, description="Song title, artist, or Spotify track URL")
):
    clean_query = query.strip()
    base_url = str(request.base_url).rstrip("/")

    # 1. Search Navidrome first
    songs = search_navidrome(clean_query)
    if songs:
        song = songs[0]
        return {
            "status": "ready",
            "song": song,
            "stream_url": f"{base_url}/api/stream/{song['id']}"
        }

    # 2. Check if a download job is already active for this query
    if clean_query in active_jobs:
        job = active_jobs[clean_query]
        status = job["status"]

        if status in [JobStatus.QUEUED, JobStatus.DOWNLOADING, JobStatus.SCANNING]:
            return {
                "status": status.value,
                "message": f"Track is currently {status.value}. Please wait..."
            }

        if status == JobStatus.READY and job.get("song"):
            song = job["song"]
            return {
                "status": "ready",
                "song": song,
                "stream_url": f"{base_url}/api/stream/{song['id']}"
            }

        if status == JobStatus.FAILED:
            # If failed more than 60 seconds ago, allow retry
            if time.time() - job.get("updated_at", 0) > 60:
                del active_jobs[clean_query]
            else:
                return {
                    "status": "failed",
                    "error": job.get("error", "Previous download attempt failed.")
                }

    # 3. Schedule download task if not already in flight
    active_jobs[clean_query] = {
        "status": JobStatus.QUEUED,
        "song": None,
        "error": None,
        "updated_at": time.time()
    }
    background_tasks.add_task(process_download, clean_query)

    return {
        "status": "downloading",
        "message": "Track was not found in cloud library. Download queued in background."
    }

@app.get("/api/stream/{song_id}")
def proxy_stream(song_id: str):
    """
    Securely proxies the audio stream from Navidrome without exposing
    Navidrome admin credentials to the mobile app or end user.
    """
    subsonic_url = f"{NAVIDROME_URL}/rest/stream.view"
    params = {**get_subsonic_params(), "id": song_id}

    try:
        req = requests.get(subsonic_url, params=params, stream=True, timeout=15)
        if req.status_code != 200:
            raise HTTPException(status_code=req.status_code, detail="Unable to stream track from Navidrome")

        media_type = req.headers.get("content-type", "audio/mpeg")

        def stream_generator():
            for chunk in req.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk

        headers = {
            "Accept-Ranges": "bytes",
        }
        if "content-length" in req.headers:
            headers["Content-Length"] = req.headers["content-length"]

        return StreamingResponse(stream_generator(), media_type=media_type, headers=headers)

    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Navidrome stream connection failed: {e}")

@app.get("/api/cover/{cover_id}")
def proxy_cover_art(cover_id: str):
    """Securely proxies album artwork from Navidrome."""
    subsonic_url = f"{NAVIDROME_URL}/rest/getCoverArt.view"
    params = {**get_subsonic_params(), "id": cover_id}

    try:
        req = requests.get(subsonic_url, params=params, stream=True, timeout=10)
        if req.status_code != 200:
            raise HTTPException(status_code=req.status_code, detail="Cover art not found")

        media_type = req.headers.get("content-type", "image/jpeg")
        return StreamingResponse(req.iter_content(chunk_size=16 * 1024), media_type=media_type)
    except requests.RequestException:
        raise HTTPException(status_code=502, detail="Unable to fetch artwork")

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "music-ingestion-middleware"}

WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")