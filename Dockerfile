# Mission Control for OpenClaw: one small image, configured only through environment variables.
# Build and run with `docker compose up -d --build` (see docker-compose.yml and .env.example).
FROM node:24.19-slim

# git: the dashboard reads and commits to your Markdown/Git workspace.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY public ./public
COPY LICENSE THIRD_PARTY_NOTICES.md ./

# /state keeps sessions, audit records and the Gateway device identity (a named volume in compose).
# /workspace is where your workspace folder is mounted, when you use one.
RUN mkdir -p /state /workspace && chown node:node /state /workspace

# Inside the container the server listens on every interface; compose publishes the port on the host
# loopback only. The server refuses to start without a sign-in mode (MC_AUTH) when it listens like this.
ENV NODE_ENV=production MC_HOST=0.0.0.0 MC_PORT=4318 MC_STATE_DIR=/state
USER node
EXPOSE 4318
# /healthz answers "ok" and nothing else: no data and no login involved.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MC_PORT||4318)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--experimental-strip-types", "server/main.mjs"]
