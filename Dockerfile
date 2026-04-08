FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY server.js ./

RUN chown -R node:node /app
USER node

EXPOSE 3333

CMD ["node", "server.js"]
