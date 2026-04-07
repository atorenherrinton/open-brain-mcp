FROM node:20-alpine

# git/openssh for repo work; bash because claude code expects a real shell
RUN apk add --no-cache git openssh-client bash

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm install -g @anthropic-ai/claude-code

COPY lib ./lib
COPY server.js ./

# Custom git credential helper. The default `store` helper always tries to
# write back to its file even on read, which fails noisily ("Resource busy")
# when the file is bind-mounted read-only. This helper just reads the first
# line of /home/node/.git-credentials and emits username/password — never
# writes. Git looks up `git-credential-<name>` on PATH.
RUN printf '#!/bin/sh\n[ "$1" = get ] || exit 0\nsed -nE "1{s|^https?://([^:]+):([^@]+)@.*|username=\\1\\npassword=\\2|p;}" /home/node/.git-credentials\n' > /usr/local/bin/git-credential-static-pat \
  && chmod +x /usr/local/bin/git-credential-static-pat

# Run as the unprivileged 'node' user (UID 1000) so Claude Code allows
# --dangerously-skip-permissions, which it refuses to honor as root.
# Pre-create an empty ~/.claude.json — Claude Code refuses to start without
# the file existing. We rely on CLAUDE_CODE_OAUTH_TOKEN env var for auth, so
# the file just needs to exist; bind-mounting the host one is unstable
# (atomic rewrites on the host break the inode of a single-file bind mount).
RUN chown -R node:node /app \
  && echo '{}' > /home/node/.claude.json \
  && chown node:node /home/node/.claude.json
USER node
ENV HOME=/home/node

EXPOSE 3333

CMD ["node", "server.js"]
