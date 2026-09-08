import os
import glob
import shutil
import subprocess
from typing import Optional
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from supabase import create_client

app = FastAPI(title="Resonate Music Middleware", version="1.0.0")

# Allow frontend requests from browser
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration & Directories
DEFAULT_DIR = "/tmp/music" if os.name != "nt" else os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "music_data"))
MUSIC_DIR = os.getenv("MUSIC_DIR", DEFAULT_DIR)
os.makedirs(MUSIC_DIR, exist_ok=True)

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ldrqckeoxfwkgxtcgluv.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxkcnFja2VveGZ3a2d4dGNnbHV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NzI4MzksImV4cCI6MjEwNDQ0ODgzOX0.NK_VerOkxWZCe6qtobNxNFpyPMlMP50HS4UXVoMQ0iM")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


class IngestRequest(BaseModel):
    query: str


def upload_to_supabase(file_path: str, filename: str) -> str:
    bucket = "music"
    with open(file_path, "rb") as f:
        supabase.storage.from_(bucket).upload(
            path=filename,
            file=f,
            file_options={"content-type": "audio/mpeg", "upsert": "true"}
        )
    url_data = supabase.storage.from_(bucket).get_public_url(filename)

    # Remove local temp file after cloud upload
    if os.path.exists(file_path):
        try:
            os.remove(file_path)
        except Exception as e:
            print(f"Warning removing temp file {file_path}: {e}")

    return url_data


def run_ingest(query: str) -> dict:
    clean_query = query.strip()
    if not clean_query:
        raise HTTPException(status_code=400, detail="Query parameter cannot be empty.")

    try:
        # Determine spotdl executable
        spotdl_cmd = shutil.which("spotdl") or "spotdl"

        print(f"[spotDL] Downloading track for query: '{clean_query}' to '{MUSIC_DIR}'")
        subprocess.run(
            [spotdl_cmd, "download", clean_query],
            cwd=MUSIC_DIR,
            check=True
        )

        # Locate the downloaded audio file
        files = glob.glob(os.path.join(MUSIC_DIR, "*.*"))
        audio_files = [f for f in files if f.lower().endswith((".mp3", ".m4a", ".opus", ".flac", ".ogg"))]
        if not audio_files:
            raise HTTPException(status_code=500, detail="Audio file not found after download.")

        latest_file = max(audio_files, key=os.path.getctime)
        filename = os.path.basename(latest_file)

        # Upload directly to Supabase Storage
        print(f"[Supabase] Uploading '{filename}' to Supabase bucket 'music'...")
        stream_url = upload_to_supabase(latest_file, filename)
        print(f"[Supabase] Upload complete. Stream URL: {stream_url}")

        clean_title = os.path.splitext(filename)[0]

        return {
            "status": "success",
            "title": filename,
            "stream_url": stream_url,
            "song": {
                "id": filename,
                "title": clean_title,
                "artist": "Cloud Ingestion",
                "stream_url": stream_url
            }
        }

    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"spotDL failed: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/search-and-ingest")
def search_and_ingest_post(req: IngestRequest):
    return run_ingest(req.query)


@app.get("/api/search-and-ingest")
def search_and_ingest_get(query: str = Query(..., min_length=1)):
    return run_ingest(query)


@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "music-ingestion-middleware", "storage": "supabase"}


# Mount Web UI if present
WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "web"))
if os.path.isdir(WEB_DIR):
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")