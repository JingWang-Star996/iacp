FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY src/ ./src/
COPY config/ ./config/
COPY docs/ ./docs/

RUN mkdir -p /tmp/iacp

EXPOSE 8765 8081

ENV IACP_HOST=0.0.0.0
ENV IACP_WS_PORT=8765
ENV IACP_HEALTH_PORT=8081

CMD ["node", "src/ws-relay/ws-server.js"]
