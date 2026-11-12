# ponytail: single stage. LibreOffice dwarfs everything, multi-stage saves little.
FROM node:22-slim

# libreoffice-convert shells out to soffice for doc conversion (see src/lib/convert.ts).
# fonts-noto-core carries Noto Sans/Serif Bengali, so Bangla in converted PDFs
# renders instead of as empty boxes; fonts-liberation is metric-compatible
# with Times New Roman and Arial for Latin text.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice fonts-noto-core fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
COPY packages/contracts /packages/contracts
# Workflow packs bundled with Spectre (the Bangladesh pack), merged into the
# catalog by sync:workflows; see SPECTRE_WORKFLOW_PACKS in .env.example.
COPY workflows /workflows
RUN npm run build

# --enable-source-maps: every entrypoint in this image (API, worker,
# sync:workflows) reports stack frames as src/*.ts lines, not dist/*.js.
# The commit this image was built from; Sentry's release tag when
# SENTRY_RELEASE is not set (docs/observability.md).
ARG GIT_SHA=
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps GIT_SHA=$GIT_SHA
EXPOSE 3001
CMD ["npm", "start"]
