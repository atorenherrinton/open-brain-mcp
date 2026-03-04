FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js mcp-server.js ./

EXPOSE 3333

CMD ["node", "server.js"]
