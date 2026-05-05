FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* && \
    curl -fsSL https://bun.sh/install | bash && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile || bun install --production

COPY server.ts ./

ENV PORT=3000
ENV STORAGE_DIR=/data/renders
ENV NODE_ENV=production
RUN mkdir -p /data/renders

EXPOSE 3000

CMD ["bun", "run", "server.ts"]
