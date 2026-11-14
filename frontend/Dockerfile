# Frontend: Node.js static server + proxy to the backend
FROM node:22-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080
ENV BACKEND_URL=http://backend:3000
EXPOSE 8080
CMD ["node", "server.js"]
