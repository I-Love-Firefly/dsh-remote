FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=peer --ignore-scripts && npm cache clean --force
COPY src ./src
COPY relay ./relay
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "relay/server.mjs"]
