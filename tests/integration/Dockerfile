# Stage 1: Build remi binary
FROM oven/bun:latest AS builder

WORKDIR /build

# Copy package files for dependency install
COPY package.json bun.lock ./
COPY packages/daemon/package.json packages/daemon/
COPY packages/shared/package.json packages/shared/
COPY packages/signaling/package.json packages/signaling/
COPY packages/web/package.json packages/web/

# Install dependencies (skip lefthook which needs git)
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/daemon/ packages/daemon/

# Build compiled binary
RUN bun build --compile --outfile=/build/remi packages/daemon/src/cli.ts

# Stage 2: Runtime environment
FROM debian:bookworm-slim

# Install Node.js (required by Claude Code CLI) and git
RUN apt-get update && \
    apt-get install -y curl git procps && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Copy remi binary from builder
COPY --from=builder /build/remi /usr/local/bin/remi
RUN chmod +x /usr/local/bin/remi

# Create sample project directories with git repos
RUN mkdir -p /projects/sample-app && \
    cd /projects/sample-app && \
    git init && \
    git config user.email "test@example.com" && \
    git config user.name "Test" && \
    echo '# Sample App' > README.md && \
    echo 'console.log("hello");' > index.ts && \
    git add -A && git commit -m "init"

RUN mkdir -p /projects/api-server && \
    cd /projects/api-server && \
    git init && \
    git config user.email "test@example.com" && \
    git config user.name "Test" && \
    echo '# API Server' > README.md && \
    echo 'export default { port: 3000 };' > config.ts && \
    git add -A && git commit -m "init"

WORKDIR /projects/sample-app

# Default: run remi daemon bound to all interfaces
ENTRYPOINT ["remi"]
CMD ["--daemon", "--bind", "0.0.0.0", "--no-auth", "--no-relay", "--no-mdns"]
