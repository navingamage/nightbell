.PHONY: install test test-media test-control typecheck dev deploy-media deploy-control migrate clean

# Everything below runs with no API keys. The provider adapters are faked in
# tests, so the call loop, triage and turn-taking are all exercised offline.

install:
	cd media && npm install
	cd control && npm install

test: test-media test-control

test-media:
	cd media && npm test

test-control:
	cd control && npm test

typecheck:
	cd media && npm run typecheck
	cd control && npm run typecheck

# The media server, against real providers. Needs the keys in media/src/config.ts.
dev:
	cd media && npm run dev

deploy-media:
	cd media && fly deploy

deploy-control:
	cd control && npm run deploy

# Apply D1 migrations. Use migrate-remote for production.
migrate:
	cd control && npm run db:migrate:local

clean:
	rm -rf media/dist media/node_modules control/node_modules
