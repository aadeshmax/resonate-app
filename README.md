# Resonate 🎵

> A next-generation music streaming and on-demand cloud ingestion engine. Built with React Native, FastAPI, Navidrome Subsonic API, and spotDL.

---

## ✨ Features

- **On-Demand Cloud Ingestion**: Search any song, artist, or paste a Spotify link. If not in your local library, the backend automatically fetches it via `spotDL`, indexes it with Navidrome, and begins streaming.
- **Interactive Turntable & Audio Player**: 
  - Dynamic 3D spinning vinyl record animation with live album art.
  - Pulsing reactive glow and real-time audio visualizer equalizer.
  - Full playback controls (Play/Pause, Seek bar, Skip ±10s, Volume).
- **Dual Client Support**:
  - **Web Client**: Zero-setup, responsive Web UI available directly in your browser.
  - **Mobile Client**: React Native mobile app with `react-native-track-player` background playback capabilities.
- **Secure Audio Proxy**: Stream and proxy music directly from Navidrome without exposing admin credentials.

---

## 🚀 Quick Start

### 1. Backend Ingestion Middleware (Python / FastAPI)

```bash
cd backend-server

# Create and activate virtual environment
python -m venv .venv
# On Windows:
.venv\Scripts\activate
# On Linux/macOS:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the server (serves both API & Web UI)
uvicorn main:app --host 0.0.0.0 --port 8000
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser to access the Resonate Web UI.

### 2. Mobile App (React Native)

```bash
# Install node dependencies
npm install

# Start Metro bundler
npm start

# Run on Android (requires Android SDK & emulator)
npm run android
```

---

## 🛠 Tech Stack

- **Frontend**: React Native, React 18, React Native Track Player, Vanilla CSS3 / Modern Web UI
- **Backend Middleware**: FastAPI, Uvicorn, Requests
- **Audio & Cloud Engine**: Navidrome (Subsonic API), spotDL, FFmpeg

---

## 📜 License

MIT License.
