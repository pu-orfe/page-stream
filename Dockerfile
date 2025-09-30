# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.55.1-jammy AS base
# NOTE: If this base image cannot be pulled due to network restrictions, a manual
# fallback build (Ubuntu + Node 18 + playwright install) can be created separately.
# Keeping Dockerfile minimal for reliability; see README (TODO add offline notes).
USER root

# Avoid interactive tzdata prompt (x11vnc/novnc dependency chain may pull it in)
ENV DEBIAN_FRONTEND=noninteractive \
        TZ=Etc/UTC

# Extra packages (only minimal set if manual fallback already installed them)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg xvfb x11vnc novnc websockify xdotool wmctrl tzdata \
    && ln -fs /usr/share/zoneinfo/$TZ /etc/localtime \
    && dpkg-reconfigure --frontend noninteractive tzdata \
    && rm -rf /var/lib/apt/lists/* || true

WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./

# Install deps (prefer npm if no lock) - ignoring optional playwright deps because base has them
RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f yarn.lock ]; then yarn --frozen-lockfile; \
    elif [ -f pnpm-lock.yaml ]; then corepack enable && pnpm i --frozen-lockfile; \
    else npm install; fi

COPY . .
RUN npm run build

ENV DISPLAY=:99 \
    NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

# Expose optional noVNC/websockify port (disabled by default). User must -p to map.
EXPOSE 6080

# Entry script handles xvfb-run, node process & signal forwarding
ENTRYPOINT ["bash", "./scripts/entrypoint.sh"]
