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

| Skill | Tier | What it does |
|---|---|---|
| `gather {block,count}` | all | mine/chop; aliases: `log`/`wood`, `stone`, `ore`, `iron`, `coal`, ... |
| `craft {item,count}` | all | finds/crafts/places a crafting table; auto-makes planks/sticks |
| `smelt {item,count,fuel?}` | smart | finds/places a furnace; accepts input or product name |
| `goto {x,y,z \| place}` | all | pathfind; `place` = remembered name (`home`, `bed`, `chest`, ...) |
| `explore {direction?,distance?}` | all | walk into new terrain |
| `follow {player,seconds}` / `attack {target}` / `eat` / `sleep` | all | |
| `place_block {block,x?,y?,z?}` | smart | |
| `build_shelter {size}` | all | template room: floor fill, 3-high walls, roof, door (or sealed doorway), torch |
| `place_bed` / `place_torch` | all | first bed is claimed, later beds are left free for newborns |
| `farm {action,crop}` | all | till / plant / harvest wheat, carrot, potato, beetroot |
| `chest_store` / `chest_take {items}` / `give {player,item,count}` | all | |
| `check_temperature` | all | `/temp raw` + `/room raw` for the bot's position |
| `say {text}` | all | proximity chat |
| `write_sign {text}` | smart | places a sign and writes ≤ 4×15 chars |
| `read_signs {radius}` | all | reads front/back sign text (1.20+) |
| `write_book {title,pages}` | smart | writes and signs a `writable_book` |
| `read_book {slot?,source}` | all | inventory or lectern |
| `remember {note}` / `set_goal {text}` (smart) / `wait {seconds}` | | |

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
| `/msg Surv_06 !think` | The bot whispers its last thought, current action, plan and goal |
| `/msg Surv_06 !status` | Health, food, position, inventory |
| `/msg Surv_06 !forget <text>` | Wipe everything it remembers mentioning `<text>` |
| `/msg Surv_06 !home` | Where you stand becomes its home (e.g. a house you built) |
| `/msg Surv_06 !teach <fact>` | It remembers the fact as a lesson |
| `/survivors protect <radius>` | Bots can't break blocks within radius of you (op) |
| `/survivors unprotect` / `/survivors areas` | Remove / list protected areas (op) |
| `/survivors inv Surv_06` | Read-only view of its inventory (op) |
| `/survivors grace start\|stop\|status` | First-day "no hostile mobs" period (op) |
