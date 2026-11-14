FROM node:24-bookworm-slim AS frontend
WORKDIR /frontend
COPY frontrend/package.json frontrend/pnpm-lock.yaml frontrend/pnpm-workspace.yaml ./
RUN npm install --global pnpm@11.25.0 && pnpm install --frozen-lockfile
COPY frontrend/src ./src
RUN pnpm build

# Playwright's image ships Chromium and its system deps.
FROM mcr.microsoft.com/playwright/python:v1.65.2-noble

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY --from=frontend /frontend/dist ./frontrend/dist

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
# One worker: battles and their WebSocket subscribers live in process memory.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
