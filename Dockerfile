FROM node:24-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json tsconfig.app.json vite.config.ts ./
COPY .openai ./.openai
COPY src ./src
RUN npm run build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////data/dhara.db \
    UPLOAD_DIR=/data/uploads
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils tesseract-ocr \
    tesseract-ocr-asm tesseract-ocr-ben tesseract-ocr-eng tesseract-ocr-guj \
    tesseract-ocr-hin tesseract-ocr-kan tesseract-ocr-mal tesseract-ocr-mar \
    tesseract-ocr-ori tesseract-ocr-pan tesseract-ocr-san tesseract-ocr-tam \
    tesseract-ocr-tel tesseract-ocr-urd \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend ./backend
COPY --from=frontend /build/dist ./dist
RUN useradd --create-home --uid 10001 dhara && mkdir -p /data/uploads && chown -R dhara:dhara /data
USER dhara
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
