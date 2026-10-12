FROM node:24-alpine
WORKDIR /app
COPY index.html server.js package.json ./
COPY assets ./assets
ENV PORT=3000 DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
