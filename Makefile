.PHONY: install demo demo-live call replay test test-media test-control typecheck dev deploy-media deploy-control migrate clean

# Everything below runs with no API keys. The provider adapters are faked in
# tests, so the call loop, triage and turn-taking are all exercised offline.

install:
	cd media && npm install
	cd control && npm install

# Drive a real Session through scripted calls, with the triage decisions and
# latency budget printed alongside the conversation. No keys, no phone number.
demo:
	cd media && npm run harness

# The same scenarios against a real model. Needs OPENROUTER_API_KEY.
# Add MODEL=vendor/name to try a different one.
demo-live:
	cd media && npm run harness -- --live $(if $(MODEL),--model=$(MODEL))

# Take the call yourself: you type what the caller says, and the agent's
# working is printed next to it. Needs OPENROUTER_API_KEY. Add SCRIPTED=1 to
# run it with no key and no spend, or SAVE=some-id to keep the call as a
# replayable test in media/recordings/.
call:
	cd media && npm run call -- $(if $(MODEL),--model=$(MODEL)) $(if $(SCRIPTED),--scripted) $(if $(SAVE),--save=$(SAVE))

# Replay only the calls recorded from real sessions.
replay:
	cd media && npm run harness -- --recorded $(if $(LIVE),--live) $(if $(MODEL),--model=$(MODEL))

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
