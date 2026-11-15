# ----- Stage 1: Install dependencies and generate Prisma Client -----
FROM node:20-slim AS deps

WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
RUN npm prune --omit=dev

# ----- Stage 2: Production image -----
FROM node:20-slim

# WHY yt-dlp + ffmpeg IN THE IMAGE?
# ----------------------------------
# yt-dlp is the downloader (Python-based CLI). ffmpeg is needed by yt-dlp to
# merge separate audio+video streams (YouTube often serves them separately for
# higher qualities like 1080p). Both must be available on the PATH.
#
# We install yt-dlp via pip pinned to a tested version, but allow overriding
# at build-time with --build-arg YTDLP_VERSION=<version>.
ARG YTDLP_VERSION=2025.02.19

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages "yt-dlp==${YTDLP_VERSION}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules (including generated Prisma Client) from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create downloads directory
RUN mkdir -p /app/downloads

# Run as non-root user for security
RUN adduser --disabled-password --gecos '' botuser && \
    chown -R botuser:botuser /app
USER botuser

CMD ["node", "src/index.js"]
