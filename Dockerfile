FROM node:20-slim

# Python for the embeddings server
RUN apt-get update && apt-get install -y python3 python3-pip curl && rm -rf /var/lib/apt/lists/*

WORKDIR /hive

# Install Node dependencies
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/api/package.json packages/api/
COPY packages/embeddings/requirements.txt packages/embeddings/
RUN npm install

# Install Python dependencies
RUN pip3 install --no-cache-dir -r packages/embeddings/requirements.txt --break-system-packages

# Copy source
COPY . .

# Runtime data lives in a volume
VOLUME ["/hive/data"]

EXPOSE 8080 7700

ENV HIVE_PORT=8080
ENV HIVE_EMBEDDER_PORT=7700
ENV HIVE_DATA_DIR=/hive/data/bee

HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:8080/api/status || exit 1

CMD ["bash", "hive.sh"]
