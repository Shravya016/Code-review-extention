FROM node:22-slim AS dashboard
WORKDIR /dashboard
COPY apps/dashboard/package*.json ./
RUN npm ci
COPY apps/dashboard/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir uv
COPY . .
RUN uv sync --all-packages --frozen --no-dev
COPY --from=dashboard /dashboard/dist /app/apps/dashboard/dist
ENV PATH="/app/.venv/bin:$PATH"
CMD ["sh", "-c", "exec uvicorn codereview_api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
