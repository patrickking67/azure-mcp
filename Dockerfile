# Azure MCP: remote image (Streamable HTTP + Entra, src/remote.ts), with the Azure CLI for Az_CLI.
FROM node:25-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:25-bookworm-slim
# Empty installs the newest CLI in Microsoft's repository; a version pins it (e.g. 2.91.0).
ARG AZ_CLI_VERSION=""
ENV NODE_ENV=production PORT=8080
# Microsoft's documented apt repository install, signed by its published key.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -sLS https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ bookworm main" > /etc/apt/sources.list.d/azure-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "azure-cli${AZ_CLI_VERSION:+=${AZ_CLI_VERSION}-1~bookworm}" \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY assets ./assets
USER node
EXPOSE 8080
CMD ["node", "dist/remote.js"]
