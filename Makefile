.PHONY: sync test lint compose-up compose-down openapi extension-build

sync:
	uv sync --all-packages

test:
	uv run pytest packages/python-common apps/api apps/worker -q

lint:
	uv run ruff check packages/python-common apps/api apps/worker
	uv run ruff format --check packages/python-common apps/api apps/worker

compose-up:
	cd infra/compose && docker compose up --build -d

compose-down:
	cd infra/compose && docker compose down

extension-build:
	cd packages/extension && pnpm install && pnpm run compile && pnpm run package
