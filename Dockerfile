FROM node:24-alpine
WORKDIR /app
COPY index.html server.js package.json ./
COPY assets ./assets
ENV PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /app /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js"]
