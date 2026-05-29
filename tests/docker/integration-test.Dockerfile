# Parameterized integration smoke-test image.
#
# Builds a clean container with the REAL CLI of a target client installed from npm (at its
# LATEST version, so a CLI/schema change is caught), then runs mementos's integration for
# that client against it. Unit tests mock the client CLI; this exercises the genuine binary.
#
#   docker build -f tests/docker/integration-test.Dockerfile \
#     --build-arg TOOL=openclaw --build-arg SMOKE=tests/docker/openclaw-smoke.ts \
#     -t mementos-openclaw-test .
#   docker run --rm mementos-openclaw-test
#
# See the `test:docker:*` scripts in package.json for the wired-up invocations.
FROM node:24-slim

# Build tools, in case a client package has a native dependency without a prebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# TOOL is the client's npm package(s); install globally alongside tsx. Unquoted so a
# space-separated TOOL ("openclaw @openai/codex") installs several packages at once.
ARG TOOL
RUN npm install -g ${TOOL} tsx

WORKDIR /app
# mementos's own dependencies — some integrations import them (e.g. @inquirer/prompts).
# Installed on the package files alone so this layer caches across source changes.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

# SMOKE is the smoke-script path; baked into an env var so `docker run` needs no extra args.
ARG SMOKE
ENV SMOKE_SCRIPT="${SMOKE}"
CMD ["sh", "-c", "tsx $SMOKE_SCRIPT"]
