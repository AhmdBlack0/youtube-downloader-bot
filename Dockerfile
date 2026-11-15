# ----- Stage 1: Install dependencies and generate Prisma Client -----
FROM node:20-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate
RUN npm prune --omit=dev

# ----- Stage 2: Production image -----
FROM node:20-slim

# WHY yt-dlp + ffmpeg + ca-certificates IN THE IMAGE?
# ----------------------------------
# yt-dlp is the downloader (Python-based CLI). ffmpeg is needed by yt-dlp to
# merge separate audio+video streams. openssl & ca-certificates are required
# for Prisma Query Engine to verify SSL/TLS connections to cloud databases (e.g. Neon).
#
# We install yt-dlp via pip pinned to a tested version, but allow overriding
# at build-time with --build-arg YTDLP_VERSION=<version>.
ARG YTDLP_VERSION=2025.02.19

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
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
    mkdir -p /home/botuser/.cache && \
    chown -R botuser:botuser /home/botuser /app
ENV HOME=/home/botuser
USER botuser

CMD ["node", "src/index.js"]
