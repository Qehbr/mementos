# Antigravity CLI smoke-test image.
#
# Antigravity CLI (`agy`) is installed via the official shell installer from
# antigravity.google — not npm — so it can't go through `integration-test.Dockerfile`,
# which assumes `npm install -g <pkg>`. The installer drops the binary at
# ~/.local/bin/agy and writes its config layout under ~/.gemini/antigravity-cli/.
#
#   docker build -f tests/docker/antigravity-cli.Dockerfile -t mementos-antigravity-cli-test .
#   docker run --rm mementos-antigravity-cli-test
#
# See the `test:docker:antigravity-cli` npm script.
FROM node:24-slim

# curl for the installer; ca-certificates so HTTPS works; build tools for any native dep
# in the npm install below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Antigravity CLI. The official installer (curl | bash) drops `agy` at
# ~/.local/bin/agy and seeds ~/.gemini/antigravity-cli/.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

RUN npm install -g tsx

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

CMD ["sh", "-c", "tsx tests/docker/antigravity-cli-smoke.ts"]
