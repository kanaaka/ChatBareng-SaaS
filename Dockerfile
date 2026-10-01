FROM node:20-slim

WORKDIR /app

# Copy package files and install deps
COPY package*.json ./
RUN npm ci --production

# Copy frontend and build
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install && npm run build

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Create data directories
RUN mkdir -p /app/data /app/data/wa-session /app/data/media

EXPOSE 5030

CMD ["node", "src/server.js"]