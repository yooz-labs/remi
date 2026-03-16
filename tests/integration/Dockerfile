FROM oven/bun:latest

# Install Node.js for Claude Code CLI (requires npm)
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Copy package files first for layer caching
COPY package.json bun.lock ./
COPY packages/daemon/package.json packages/daemon/
COPY packages/shared/package.json packages/shared/
COPY packages/signaling/package.json packages/signaling/
COPY packages/web/package.json packages/web/

# Install dependencies (--ignore-scripts to skip lefthook which needs git)
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/daemon/ packages/daemon/

# Create a working directory for sessions
RUN mkdir -p /projects/test-project

# Default: run daemon bound to all interfaces, no auth, no relay
ENTRYPOINT ["bun", "run", "packages/daemon/src/cli.ts"]
CMD ["--daemon", "--bind", "0.0.0.0", "--no-auth", "--no-relay", "--no-mdns"]
