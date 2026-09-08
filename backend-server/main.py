import os
import glob
import asyncio
import traceback
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from supabase import create_client

app = FastAPI(title="Resonate Music Middleware", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_DIR = "/tmp/music" if os.name != "nt" else os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "music_data"))
MUSIC_DIR = os.getenv("MUSIC_DIR", DEFAULT_DIR)
os.makedirs(MUSIC_DIR, exist_ok=True)

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://ldrqckeoxfwkgxtcgluv.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxkcnFja2VveGZ3a2d4dGNnbHV2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NzI4MzksImV4cCI6MjEwNDQ0ODgzOX0.NK_VerOkxWZCe6qtobNxNFpyPMlMP50HS4UXVoMQ0iM")
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# Sequential lock to prevent RAM exhaustion on Render 512MB limit
download_lock = asyncio.Lock()


class IngestRequest(BaseModel):
    query: str


@app.get("/health")
async def health():
    return {"status": "ok"}


async def process_ingestion(query: str):
    clean_query = query.strip()
    if not clean_query:
        raise HTTPException(status_code=400, detail="Query cannot be empty.")

    async with download_lock:
        try:
            print(f"[Ingest] Starting async download for: {clean_query}")

            # Non-blocking subprocess execution with fast stream extraction
            proc = await asyncio.create_subprocess_exec(
                "spotdl",
                "download",
                clean_query,
                "--format", "m4a",
                "--bitrate", "disable",
                "--threads", "1",
                cwd=MUSIC_DIR,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )

            stdout, stderr = await proc.communicate()

            if proc.returncode != 0:
                err = stderr.decode(errors="replace") if stderr else "Unknown spotDL error"
                print(f"[spotDL error]: {err}")
                raise HTTPException(status_code=500, detail=f"spotDL failed: {err}")

            # Locate downloaded audio file
            files = glob.glob(os.path.join(MUSIC_DIR, "*.*"))
            audio_files = [f for f in files if f.lower().endswith((".m4a", ".mp3", ".opus", ".flac", ".ogg"))]
            if not audio_files:
                raise HTTPException(status_code=500, detail="Audio file not found after download.")

            latest_file = max(audio_files, key=os.path.getctime)
            filename = os.path.basename(latest_file)
            print(f"[Supabase] Uploading {filename}...")

            # Run Supabase sync I/O in a separate thread so event loop remains free
            def upload_to_supabase():
                content_type = "audio/mp4" if filename.lower().endswith(".m4a") else "audio/mpeg"
                with open(latest_file, "rb") as f:
                    supabase.storage.from_("music").upload(
                        path=filename,
                        file=f,
                        file_options={"content-type": content_type, "upsert": "true"}
                    )
                return supabase.storage.from_("music").get_public_url(filename)

            stream_url = await asyncio.to_thread(upload_to_supabase)
            print(f"[Supabase] Upload complete: {stream_url}")

            # Cleanup local disk
            if os.path.exists(latest_file):
                try:
                    os.remove(latest_file)
                except Exception as e:
                    print(f"Warning removing temp file {latest_file}: {e}")

            clean_title = os.path.splitext(filename)[0]

            return {
                "status": "completed",
                "title": filename,
                "stream_url": stream_url,
                "song": {
                    "id": filename,
                    "title": clean_title,
                    "artist": "Cloud Ingestion",
                    "stream_url": stream_url
                }
            }

        except HTTPException:
            raise
        except Exception as e:
            traceback.print_exc()
            raise HTTPException(status_code=500, detail=str(e))


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