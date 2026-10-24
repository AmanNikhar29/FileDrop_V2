FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3000
CMD ["npm", "start"]
