FROM node:20-alpine

# git/openssh for repo work; bash because claude code expects a real shell
RUN apk add --no-cache git openssh-client bash

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
  && npm install -g @anthropic-ai/claude-code

COPY lib ./lib
COPY server.js ./

# Run as the unprivileged 'node' user (UID 1000) so Claude Code allows
# --dangerously-skip-permissions, which it refuses to honor as root.
RUN chown -R node:node /app
USER node
ENV HOME=/home/node

EXPOSE 3333

CMD ["node", "server.js"]
