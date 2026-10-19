FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim-bookworm AS python-base
COPY --from=ghcr.io/astral-sh/uv:0.9.16 /uv /usr/local/bin/uv
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PATH="/app/.venv/bin:$PATH"
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY diary/ diary/
COPY migrations/ migrations/

FROM python-base AS back
RUN useradd --create-home --uid 10001 diary \
    && mkdir /data && chown diary:diary /data
USER diary
CMD ["uvicorn", "diary.app:from_env", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--no-access-log"]

FROM python-base AS checks
RUN uv sync --frozen --no-install-project
COPY tests/ tests/
COPY scripts/ scripts/
COPY docs/export/ docs/export/
CMD ["pytest", "-q"]

FROM checks AS e2e
COPY --from=frontend-build /usr/local/bin/node /usr/local/bin/node
COPY --from=frontend-build /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=frontend-build /app/frontend /app/frontend
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd frontend && npx playwright install --with-deps chromium --only-shell
CMD ["npm", "--prefix", "frontend", "run", "test:e2e"]

FROM caddy:2-alpine AS front
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /app/frontend/dist /srv
