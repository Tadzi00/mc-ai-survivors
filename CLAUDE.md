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
