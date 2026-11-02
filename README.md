# mc-ai-survivors

LLM-driven Minecraft bots that try to survive a harsh world with seasons.
The population grows **only when the bots build shelter**: every living bot needs its own bed in a
sealed, warm room, plus one spare bed, before a new teammate is born. Death is permanent.

- Two **smart** bots run on a stronger model; everyone else is **basic** on a cheaper model.
- Bots act through **deterministic skills** (`gather`, `craft`, `build_shelter`, `place_bed`, ...).
  The LLM picks one skill at a time and never micro-manages; reflexes (eat, fight/flee, escape lava,
  get warm, sleep) run without the LLM.
- Bots talk in **proximity chat** (only heard within 32 blocks) and leave lasting knowledge in
  **signs and books**.
- Works with **Ollama** (local container or remote server), any **OpenAI-compatible** API
  (OpenAI, OpenRouter, LM Studio, vLLM), or **Anthropic**.
- Optional companion plugin **RealisticSeasons** adds seasons, temperature and heat-leaking rooms.

## Architecture

```
                 ┌──────────────────────── docker compose ────────────────────────┐
                 │                                                                 │
  ┌──────────────┴───────────┐  RCON (25575)   ┌──────────────────────────────────┐ │
  │ bots (Node 24, this repo)│────────────────▶│ minecraft (itzg, Paper 1.21.4)   │ │
  │                          │ survivors ...   │  plugins/                        │ │
  │  LifecycleManager        │ temp/room raw   │   SurvivorsBridge  (bridge-plugin)│ │
  │   ├ spawn rule poll      │◀──SB|v1 / RS|v1─│   RealisticSeasons (optional)    │ │
  │   ├ births / deaths      │                 └──────────────▲───────────────────┘ │
  │   └ BotAgent × N ────────┼── mineflayer (25565, offline) ─┘                     │
  │       ├ reflexes  (no LLM, 500 ms)                                              │
  │       ├ planner   (LLM: observation → ONE JSON action)                          │
  │       └ skills    (deterministic, timeout, abortable)                           │
  │                          │  HTTP                                                │
  │  LLM provider layer ─────┼──────────▶ ollama (profile "ollama", GPU)  ──or──    │
  │   per-provider queue     │            remote Ollama / OpenAI-compatible / Anthropic
  └──────────────────────────┘                                                      │
                 └─────────────────────────────────────────────────────────────────┘
   state/  orchestrator.json (alive/dead, tiers), bots/<name>.json (notes, places, goal)
   logs/   <bot>.jsonl (decisions, skills, reflexes, deaths), orchestrator.jsonl
```

## Quick start (Docker)

```bash
cp .env.example .env              # set RCON_PASSWORD, MC_WHITELIST (your name), ...
cp config.example.yaml config.yaml

# Build the bridge plugin and drop it into plugins/
(cd bridge-plugin && ./gradlew build)
cp bridge-plugin/build/libs/SurvivorsBridge-*.jar plugins/
# Optional: cp /path/to/RealisticSeasons-*.jar plugins/
```

Then pick an LLM backend:

**A. Local Ollama in Docker (NVIDIA GPU)** — needs the NVIDIA Container Toolkit.

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen2.5:7b
docker compose exec ollama ollama pull qwen2.5:3b
docker compose restart bots
```

On a 6 GB card (e.g. RTX 2060) keep `concurrency: 1`; Ollama swaps the 7B/3B models as needed.
Set `OLLAMA_MAX_LOADED_MODELS=2` only if both fit in VRAM.

**Unraid:** see [deploy/unraid/README.md](deploy/unraid/README.md) (Compose Manager stack, CPU or GPU Ollama).

**B. Remote Ollama server** — set `OLLAMA_BASE_URL=http://<host>:11434` in `.env`, then
`docker compose up -d`.

**C. Paid providers** — put `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY` / `OPENAI_API_KEY`) in `.env`
and point `tiers` in `config.yaml` at that provider, e.g.:

```yaml
tiers:
  smart: { provider: claude, model: claude-sonnet-5-5, maxTokens: 400 }
  basic: { provider: claude, model: claude-haiku-5-5, maxTokens: 300 }
```

Watch the world: join `localhost:25565` with your own (whitelisted) name. Follow the bots with
`docker compose logs -f bots` or `tail -f logs/Surv_01.jsonl`.

### Running the orchestrator outside Docker

```bash
npm install && npm run build
# config.yaml: server.host/rcon.host = localhost (RCON is published on 127.0.0.1:25575)
RCON_PASSWORD=... npm start      # or: npm run dev
```

## Security: offline mode

Bots have no Mojang accounts, so the server runs with `ONLINE_MODE=FALSE`. **Anyone who can reach the
port can join as any name, including yours.** The compose file enables the whitelist; the
orchestrator runs `whitelist add <bot>` via RCON before each bot connects (`population.autoWhitelist`).
Add your own name with `MC_WHITELIST`. Prefer `MC_BIND=127.0.0.1` or a firewall. RCON is published only
on `127.0.0.1` and must never be exposed.

## The spawn rule

```
new bot can be born  ⇔  every living bot owns a bed in a valid room
                        AND there is ≥ 1 more unowned bed in a valid room
valid room           =  sealed AND comfortable (RealisticSeasons)  |  enclosed, no sky access (built-in)
```

The orchestrator polls `/survivors canspawn raw <living bots>` every `spawnPollSeconds`. When it says
yes, the newborn (`Surv_NN`, never reused) gets the free bed (`/survivors assign`), is whitelisted,
spawns, and is teleported to the bed with its spawnpoint set there. Population is capped at `maxBots`.
If everyone dies and `reseedWhenExtinct` is on, `initialBots` new bots start over.

**Tiers:** at most `smartSlots` living bots are smart. When a smart bot dies its slot is freed and the
**next newborn** becomes smart (existing basic bots are not promoted).

## Config reference (`config.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `server.host/port` | `localhost` / `25565` | Minecraft server |
| `server.version` | `1.21.4` | protocol version for mineflayer, or `auto` |
| `rcon.host/port/password/timeoutMs` | `localhost`/`25575`/–/`5000` | RCON (needs op-level console) |
| `population.maxBots` | `8` | max living bots |
| `population.smartSlots` | `2` | max living smart bots |
| `population.initialBots` | `2` | bots at first start / after extinction |
| `population.reseedWhenExtinct` | `true` | restart the population if all die |
| `population.spawnPollSeconds` | `30` | spawn-rule poll interval |
| `population.namePrefix` | `Surv_` | bot name prefix |
| `population.spawnAtBed` | `true` | teleport newborns to their bed and set spawnpoint |
| `population.autoWhitelist` | `true` | `whitelist add` each bot via RCON |
| `chatRange` | `32` | blocks; bots only hear chat within this range |
| `bot.plannerMinIntervalSeconds` | `6` | min seconds between LLM decisions per bot |
| `bot.reflexIntervalMs` | `500` | reflex tick |
| `bot.skillTimeoutSeconds` | `120` | hard timeout per skill |
| `bot.scanRadius` | `24` | observation radius |
| `bot.coldThresholdC` | `5` | cold reflex threshold (with RealisticSeasons) |
| `bot.temperatureCheckSeconds` | `30` | `/temp raw` poll per bot |
| `bot.notesMax` | `40` | memory notes before compaction |
| `bot.chatHistory` | `8` | heard messages kept |
| `bot.reconnectDelaySeconds` | `10` | reconnect after a non-death disconnect |
| `providers.<name>` | – | `type: ollama \| openai-compatible \| anthropic`, `baseUrl`, `apiKeyEnv`, `concurrency`, `timeoutMs`, `retries` (+ `keepAlive` for ollama, `jsonMode` for openai-compatible, `effort` for anthropic) |
| `tiers.smart/basic` | qwen2.5 7b/3b on ollama | `provider`, `model`, `maxTokens`, `temperature` |
| `paths.state/logs` | `./state` / `./logs` | persistence |

Strings may use `${ENV}` / `${ENV:-default}`. `CONFIG_FILE` selects the file (default `config.yaml`,
falling back to `config.example.yaml`).

## Skills

The model picks skills; the code runs them deterministically and reports what really happened.

| Skill | Tier | What it does |
|---|---|---|
| `gather {block,count}` | all | mine/chop (`log`, `stone`, `iron_ore`, ...). Only real trees (not house walls), never blocks of a home or protected area; also mines valuable ores passed on the way; walks to remembered spots or explores ~48 blocks when nothing is in reach; gets out of caves first for wood |
| `craft {item,count}` | all | server-side crafting after checking ingredients + a crafting table in reach; makes planks/sticks/table itself; `pickaxe`/`bed`/`planks` map to what the bot can make |
| `smelt {item,count,fuel?}` | smart | furnace; counts results by inventory change |
| `goto {x,y,z \| place}` / `explore` / `go_surface` | all | pathfinding, uses doors of known homes, reports when it stopped short; `go_surface` climbs/digs out of caves |
| `follow {player,seconds}` | all | humans only (bots following bots did nothing) |
| `attack {target}` / `eat` / `sleep` | all | `attack cow` walks to remembered herds; `sleep` claims a bed (sets home if none) |
| `build_shelter {size 4-11}` | all | sealed room with door and torches, warmed until comfortable; tries nearby spots if blocked |
| `extend_shelter {direction,length}` | all | adds a connected room to your shelter |
| `heat_room` / `place_torch` / `add_door` / `set_home` | all | torches until warm (judged by where the room is heading); door into a walled-up doorway; home = here |
| `place_bed` | all | finds room for a bed even in a 3x3 room; first bed claimed, later beds left for newborns |
| `plant_sapling {count}` / `farm {action,crop}` | all | new trees; till/plant/harvest |
| `chest_store` / `chest_take {items}` / `give` | all | verified transfers; chests remembered with contents; take goes to the chest that holds the item |
| `say` (free in any reply) / `shout` / `write_sign` / `read_signs` / `write_book` / `read_book` | mixed | communication (see below) |
| `mark_place` / `remember` / `set_goal` / `check_temperature` / `wait` | mixed | memory and status |

## What happens without the model (reflexes, automation)

- Fight (with a weapon) or flee (bare hands, weak, creeper); sprint away when hurt; shout HELP with coordinates.
- Run to a teammate's HELP within 150 blocks; "are you alive?" check-in after 30 s, answered automatically.
- Eat when hungry; hunt animals when starving with no food; swim up when drowning; escape lava/fire.
- At night in the open: go home or dig a sealed 3-deep bunker; dig out at dawn. Sleep in own bed at night.
- Warm up when cold (body temperature from RealisticSeasons): go home and add torches.
- Put on better armor; remember ores, water, animals, trees, chests, utilities, deaths; learn from failures.
- A newborn is mentored by the nearest bot (home, chests, finds, lessons copied + whispered welcome).
- Player orders via /msg ("build shelter", "come here", ...) run instantly.

## RealisticSeasons

Optional. Drop its jar into `plugins/`. When present:

- SurvivorsBridge uses its API (`isInsideSealedRoom` + `isComfortable`) for bed validity.
- The orchestrator polls `/temp raw x y z` per bot (`RS|v1|temp|{json}`); the cold reflex sends bots
  home or makes them place torches; `check_temperature` also uses `/room raw`.

When absent, `/temp raw` is an unknown command: seasons are disabled gracefully and bed validity uses the
built-in enclosure check.

## Upgrading Minecraft

1. Set `MC_VERSION` in `.env` (e.g. `1.21.5`) — itzg downloads the matching Paper build.
2. Set `server.version` in `config.yaml` to the same version (or `auto`). Make sure the installed
   `minecraft-data` / `mineflayer` support it (`npm update mineflayer minecraft-data`).
3. Rebuild the bridge plugin against the new API if needed: change
   `paper-api:<version>-R0.1-SNAPSHOT` in `bridge-plugin/build.gradle.kts` (it uses only stable
   Bukkit/Paper APIs, so the 1.21.4 jar usually keeps working on later 1.21.x).
4. Check that your RealisticSeasons build supports the new version.

## Development

See `CLAUDE.md` for commands and `DESIGN.md` for the design rationale and the "Not bugs" list.

## License

MIT © 2026 Tadzi00

## Talking to the bots in game

| Command | What it does |
|---|---|
| `/msg Surv_06 <text>` | Private message: the bot always hears it and reacts right away |
| `/msg Surv_06 build shelter` | Direct commands run instantly: build shelter/house, stop/wait, come here/follow me, go home, sleep, eat |
| `/msg Surv_06 gather 20 stone` | Other instructions become an ORDER at the top of its view for 5 min |
| `/msg Surv_06 !think` | The bot whispers its last thought, current action, plan and goal |
| `/msg Surv_06 !status` | Health, food, position, inventory |
| (automatic) | Bots in earshot swap finds and lessons, shout news (ore, deaths, village) and answer "anyone know where X are?"; newborns are taught and named by the elders |
| `/msg Surv_06 !memory` | Saved places (home, bed, bunker...), current order, known chests, finds by kind, lesson count |
| `/msg Surv_06 !lessons` | All lessons, numbered |
| `/msg Surv_06 !finds [kind]` | Remembered finds nearest first, e.g. `!finds iron` |
| `/msg Surv_06 !forget 3` | Drop lesson [3] (`!forget <text>` still forgets anything mentioning the text) |
| `/msg Surv_06 !forget <text>` | Wipe everything it remembers mentioning `<text>` |
| `/msg Surv_06 !home` | Where you stand becomes its home (e.g. a house you built) |
| `/msg Surv_06 !teach <fact>` | It remembers the fact as a lesson |
| `/survivors protect <radius>` | Bots can't break blocks within radius of you (op) |
| `/survivors unprotect` / `/survivors areas` | Remove / list protected areas (op) |
| `/survivors inv Surv_06` | Read-only view of its inventory (op) |
| `/survivors grace start\|stop\|status` | First-day "no hostile mobs" period (op) |

## Running the bots without Docker (development)

`scripts/run-bots.sh` runs the orchestrator against `localhost` (server + Ollama) and restarts it
automatically if it exits. After `npm run build`, `pkill -f "^node dist/index.js"` makes it pick up the new
code within 5 s. Live tests: `node scripts/harness.mjs` (skills) and `node scripts/agent-harness.mjs`
(reflexes, rescue, orders); both use a temporary platform far from spawn and clean up after themselves.
