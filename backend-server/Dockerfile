FROM python:3.11-slim

# Install ffmpeg (required by spotDL for audio conversion and tagging)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install spotdl, fastapi, uvicorn, requests
RUN pip install --no-cache-dir \
    spotdl \
    fastapi \
    uvicorn \
    requests

COPY main.py /app/main.py

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
