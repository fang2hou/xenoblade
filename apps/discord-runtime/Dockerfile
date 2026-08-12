FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY dist/ ./dist/
EXPOSE 8397
CMD ["node", "--enable-source-maps", "dist/index.js"]
