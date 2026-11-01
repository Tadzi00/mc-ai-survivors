# CLAUDE.md

LLM-driven Minecraft survivor bots (TypeScript orchestrator) + a small Paper plugin (`bridge-plugin/`).

## Commands

```bash
npm install
npm run typecheck      # tsc --noEmit (strict)
npm test               # vitest (pure logic only; no server needed)
npm run build          # -> dist/
npm start              # run orchestrator (needs config.yaml, a server with RCON + SurvivorsBridge)
cd bridge-plugin && ./gradlew build   # -> bridge-plugin/build/libs/SurvivorsBridge-*.jar
```

## Live tests (need the Docker server running and `.env` loaded: `set -a; . ./.env; set +a`)

```bash
node scripts/harness.mjs [scenario...]        # skills on a temporary platform at x≈3000,y=200 (20 scenarios)
node scripts/agent-harness.mjs [scenario...]  # full BotAgents with a stub model (fight, rescue, orders, ...)
node scripts/shelter-test.mjs                 # build + extend shelter, check sealed/warm
scripts/run-bots.sh                           # run the real bots with auto-restart (pkill node → reload)
```

Run the harnesses after changing skills/reflexes; they check results through RCON (server truth). Notes:
blocks placed with /fill or /setblock fire no events (RealisticSeasons caches, bed index) and /fill is
limited to 32768 blocks.

## Read first

**`DESIGN.md`** explains what is intentional (permanent death, proximity chat, one JSON action per
LLM call, smart-slot inheritance, spawn rule, etc.). Check its "Not bugs" list before "fixing" behaviour.

## Rules

- The `SB|v1|...` and `RS|v1|...` line formats are stable contracts. Don't change shape without bumping
  the version on both sides (`src/contracts.ts`, `bridge-plugin/.../SurvivorsCommand.java`).
- Keep pure logic (policy, parsing, validation, chat range, reflex choice) free of mineflayer imports so
  it stays unit-testable; add tests for any change there.
- Skills are deterministic, time-bounded, abortable (`ctx.signal`) and return a short result string.
  New skill = schema in `src/skills/schemas.ts` + impl in `src/skills/impl/` + entry in `src/skills/index.ts`.
- Never put secrets in config files; providers read keys from env var names.
- TypeScript strict ESM (NodeNext): import local files with `.js` suffix; import CJS packages
  (mineflayer-pathfinder, vec3, rcon-client) via default import.
