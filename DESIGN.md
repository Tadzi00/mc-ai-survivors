# DESIGN — mc-ai-survivors

This document is for future maintainers, human or AI. It records **what is intentional**, so that
deliberate game-design choices are not "fixed" as bugs. If you change one of these decisions, update
this file in the same change.

## 1. Goal and shape

A small tribe of LLM-driven Minecraft bots tries to survive a seasonal world. The interesting dynamic
is **population pressure**: the tribe grows only by building proper shelter (sealed, warm rooms with
beds), and shrinks through permanent death. Two components:

| Component | Where | Role |
|---|---|---|
| Orchestrator | `src/` (TypeScript, Node 24) | lifecycle, LLM calls, bot brains, skills |
| SurvivorsBridge | `bridge-plugin/` (Java, Paper) | server-authoritative bed index, ownership, room validity, spawn rule |
| RealisticSeasons | separate repo, optional | seasons, temperature, room sealing/heat (consumed via contract) |

## 2. Two-layer brain (reflexes + planner)

Each `BotAgent` (`src/bot/agent.ts`) has two layers:

1. **Reflexes** (no LLM, every `reflexIntervalMs`, default 500 ms). Pure arbitration in
   `src/bot/reflexChoice.ts` picks at most one of: escape lava, extinguish, surface (drowning),
   fight/flee hostile, eat, warm up (go home / place torch), sleep at night. A reflex **aborts the
   current skill** via its `AbortSignal`; the planner is told "interrupted by reflex X" next time.
2. **Planner** (LLM). When idle (no skill, no reflex) and at least `plannerMinIntervalSeconds` since
   the last decision, it builds a compact text observation and asks the tier's model for ONE action.

**Why:** LLM latency on cheap/local models is seconds to tens of seconds; survival emergencies need
sub-second reactions. Splitting lets a 3B model on a 6 GB GPU drive a bot without dying to every zombie,
and keeps LLM traffic low (one call per finished skill, not per tick).

### 2.1 Fight / flee policy (`reflexChoice.ts`, `agent.ts`)

- Creeper: flee unless health >= 16 AND armed.
- Armed (sword/axe): fight while health >= 10 (>= 16 if 2+ hostiles within 10 blocks).
- Bare-handed: fight only at health >= 18 against ONE hostile; otherwise flee. Fists lose to zombies.
- A fight runs until the target is dead or > 16 blocks away (max 40 s), retargets the next hostile
  within 8 blocks, and when health drops below 8 it **sprints away** in the same reflex (no gap).
- Flee sprints directly away from the average threat position until nothing is within 14 blocks
  (max 15 s), or runs home if home is within 40 blocks.

### 2.2 Progress ladder (`src/bot/progress.ts`)

Every observation contains a deterministic checklist and ONE "NEXT STEP" with a ready skill call:
wood → crafting table → pickaxe → sword → food (5) → 70 building blocks → shelter →
heat (2 torches or a warm sealed room) → stone pickaxe → own bed → spare bed. Shelter and heat come
**before** better tools on purpose (a night outside kills; a stone pickaxe can wait). Facts come from inventory, nearby crafting
table, remembered places (`home`, `bed`, `spare_bed`) and the RealisticSeasons reading. Prompts tell
both tiers to follow it unless in danger or it just failed. **Why:** small local models (3-7B) loop on
"gather wood" without a concrete next step; computing the tech tree in code is cheap and reliable.

### 2.3 Multi-step plans (smart bots)

Smart bots answer `{"thought","plan":[{skill,args}, ...]}` with 1-5 steps (`parsePlan` in
`src/bot/action.ts`); basic bots still answer one action (a plan from them is cut to its first step).
Steps run one after another **without** another model call. The rest of the plan is dropped (and the
reason shown next turn as "plan stopped/paused ...") when a step fails (`looksFailed` result heuristic),
a reflex interrupts or a skill times out, the bot hears chat, or it gets hurt. One invalid step rejects
the whole plan so the model fixes it. **Why:** fewer model calls, and the bot can sequence things like
gather → build_shelter → place_torch instead of re-deciding after every step. The progress ladder stays
a suggestion; smart bots may put shelter before tools.

### 2.4 Idle watchdog

Every 10 s a bot checks whether it moved >= 1 block in the last 30 s (ignored while sleeping). If not,
it logs `IDLE: ... waiting for the model / skill X not moving / doing nothing` (and a jsonl `idle`
event), at most once a minute. Diagnostic only; it never changes behaviour.

## 3. One action per call, JSON only

The model returns exactly one object: `{"thought": "...", "skill": "...", "args": {...}}`.

- Parsed with `extractJsonObject` (tolerates code fences, prose, trailing commas), then validated with
  the skill's zod schema (`src/skills/schemas.ts`) and the tier's allowed skill list.
- Invalid → **one** retry with the validation error appended; still invalid → deterministic fallback
  (`gather log` if poor in wood, else `explore`). Provider/network error → fallback + 5 s pause.
- No multi-step plans, no tool-calling loops, no chat history between decisions. Continuity comes from
  the observation: goal, notes, known places, last 5 skill results, heard chat.

**Why:** small models are far more reliable at "pick one of these verbs" than at long plans or native
tool calling, and every provider (Ollama, OpenAI-compatible, Anthropic) supports plain JSON text.

## 4. Deterministic skills

Skills (`src/skills/impl/*`) are ordinary async functions: deterministic, bounded by
`skillTimeoutSeconds`, abortable via `ctx.signal`, and they return a **short result string** that the
model sees next turn ("gathered 4 log (wanted 8)", "not enough blocks: need 71, have 30 ...").
They do the fiddly parts so the LLM "doesn't think too much": `craft` auto-places a crafting table and
auto-makes planks/sticks, `build_shelter` is a fixed template with a resource check first, `smelt`
maps products to inputs, `gather` understands aliases like `log`.

Tier subsets: basic bots cannot use `set_goal`, `write_book`, `write_sign`, `smelt`, `place_block`
(shorter prompt, fewer ways to go wrong). Smart bots get everything and a longer prompt with strategy.

## 5. Population lifecycle

### 5.1 Spawn rule (exact semantics — implemented in the bridge plugin, `SpawnRule.java`)

```
canSpawn = for every living bot B: B owns a bed AND that bed's room is valid
           AND there exists ≥ 1 valid bed with no owner
```

- "Living bots" is the list the orchestrator passes (`state/orchestrator.json` bots with status alive).
- Valid room: RealisticSeasons present → `isInsideSealedRoom && isComfortable` at the block above the
  bed head; absent → built-in enclosure flood fill (≤ 512 air blocks, no sky access).
- Bot name matching is case-insensitive. One bed per bot, one owner per bed.
- The free bed is the first unowned valid bed by (world, x, y, z).

The orchestrator (`src/lifecycle/policy.ts#decideSpawn`, unit-tested) adds:
`aliveCount == 0` → seed `initialBots` (first run, or after extinction if `reseedWhenExtinct`);
`aliveCount >= maxBots` → no; bridge unavailable → no; else follow the bridge.

On a spawn: name `Surv_NN` (never reused), `/survivors assign <name> <bed>`, `whitelist add`, connect,
then `spawnpoint` + `tp` to the bed via RCON.

### 5.2 Permanent death

On mineflayer `death`: the bot is disconnected (`quit`), marked dead with the server's death message
as cause, its bed unassigned (the bed becomes a free bed again), and the name is never used again.
There is **no respawn**. Non-death disconnects (kick, network) reconnect after `reconnectDelaySeconds`.

### 5.3 Smart-slot inheritance

At most `smartSlots` living bots are smart. `assignTier` gives a newborn the smart tier iff fewer than
`smartSlots` living bots are smart. So when a smart bot dies, its slot is freed and the **next
newborn** is smart. Existing basic bots are **not** promoted mid-life (their prompts/memories were
built for the basic tier, and promotion would make deaths of smart bots "free").

### 5.4 Server-authoritative bed counting

Bed state lives in the server plugin, not in the orchestrator, because only the server sees every
bed placed/broken/exploded/burned by anyone (bots, humans, creepers) and can run the room check with
real world data. The orchestrator never counts beds itself.

## 6. Communication

### 6.1 Proximity chat (intentional)

Minecraft chat is global, but bots only **hear** part of it (`src/bot/chat.ts`):

- **say** (`say` skill, plain chat): heard within `chatRange` (default **15**) blocks, and only when the
  speaker's position is known (visible entity or another bot of this orchestrator). Otherwise not heard.
- **shout** (`shout` skill, chat line prefixed `[SHOUT] `): heard within `shout.range` (default **1000**)
  blocks, max `shout.maxWords` (15) words, one shout per `shout.cooldownSeconds` (60) per bot; longer
  shouts are refused, not truncated. Listeners see `<Name SHOUTS @x,y,z (230m NE)> text`.
  A human shouting from beyond entity range (position unknown) is assumed to be in range.
- Bot positions for far-away bots come from the in-process `Roster` (updated every second), since
  entities beyond view distance are invisible to mineflayer.

Humans still see all chat in their client; the limits model the bots' perception.
**Why:** proximity matters, shouting is a scarce long-range channel (meet-ups, warnings), and durable
knowledge still needs signs and books.

### 6.1.1 Coordinates and the village

Bots see their own `Pos x,y,z`, `goto {x,y,z}` accepts exact coordinates, `mark_place {name}` saves the
current position (`bed` and `spare_bed` are reserved), and shouts carry the shouter's coordinates. The
smart prompt asks the tribe to pick ONE village spot, `mark_place "village"`, shout it, and build all
shelters and beds there; basic bots are told to go to a shouted village.

### 6.1.2 Talking is cheap on purpose

Every reply (both tiers) may carry an optional `"say"` field that is spoken immediately and costs **no
action**. The observation lists teammates within say range and nudges ("you haven't talked for N min";
"tell them what you found or learned"). The prompt tells bots they start knowing almost nothing and survive by
sharing. **Why:** the user wants knowledge to spread through conversation, not through code.

### 6.1.3 Help shouts, rescue and check-ins (scripted)

- A bot that loses health with a hostile within 6 blocks shouts `HELP! <mob> attacking me at x y z`
  (normal shout cooldown).
- Hearing it, a bot with health >= 12 within 150 blocks runs there via the **`assist` reflex** (no model call;
  a model round trip used to take 1-2 min). Own danger (fight/flee) still comes first. On arrival it says
  "I'm here to help!" and the fight reflex takes over.
- 30 s after the call the helper shouts `<caller>, are you alive? Where are you?`. The caller answers
  automatically as soon as its own shout cooldown allows: `<helper>: alive at x y z, health N, still need
  help | safe now`. Alive + need help → the helper updates the target position; "safe" → rescue ends; no
  answer within 35 s → rescue ends and a lesson "X did not answer (maybe dead)" is recorded.
- A death message for the caller ends the rescue immediately (auto-forget of that bot's calls/shouted spots).
- The question needs "alive?"/"where are you"/"are you ok" and is ignored inside replies, so two bots
  can't reply to each other in a loop.

### 6.1.4 Player commands via /msg

Humans (not bots) can `/msg <bot> ...`:
- `!think`: last thought, current action, remaining plan, goal, rescue target.
- `!status`: health, food, position, tier, inventory.
- `!memory`, `!lessons`, `!finds [kind]`: read the bot's memory file. Long answers are whispered one line
  per 0.4 s and capped at 16 lines (the server kicks for chat spam). `!forget <n>` drops lesson [n].
- Orders (`src/bot/orders.ts`): "build shelter/house", "stop/wait", "come here/follow me", "go home", "sleep",
  "eat" run immediately as skills, no model call (the reply is a short whispered ack). Any other message
  that reads like an instruction (imperative verb, not a question) becomes a standing ORDER shown first in
  the observation for 5 min (90 s for direct commands; "stop" clears it) and hides the progress hint.
  **Why:** the 7B model said "I'll build a shelter now" and then followed its checklist instead.
- `!home`: your position (if the bot sees you, else its own) becomes its home.
- `!teach <fact>`: stored directly as a lesson "Taught by <player>: <fact>".
- `!forget <text>`: removes every note, lesson, discovery, place, heard message, goal and the current plan
  mentioning `<text>` (e.g. a dead bot's name).
- anything else: a private message the bot always hears (any distance), shown as `<Player -> YOU>`; the
  current action is interrupted and the bot re-plans right away. Its `say` in that reply is whispered back
  to the player (not public chat). "where are you"-type questions are answered instantly from code with
  the real position, health and food.

### 6.2 Signs and books

Signs (`write_sign`, `read_signs`) and written books (`write_book`, `read_book`, chests, lecterns) are
the lasting, location-bound information channels — how a smart bot teaches a basic bot or a bot
not yet born. Sign text is read from block-entity data (`getSignText()`, front + back, 1.20+). Book pages
come from 1.20.5+ item components (`written_book_content`/`writable_book_content`) with legacy NBT fallback.

### 6.3 Cheat sheet (deliberately minimal)

Both prompts contain a ~8-line "Minecraft basics" sheet (`CHEAT_SHEET` in `src/bot/prompts.ts`): logs → planks
→ sticks, tool tiers, raw ores must be smelted, torch = coal + stick, cook meat, night/mob basics, falls.
Plus: plant saplings near known log spots (`plant_sapling`, both tiers; grass/dirt, 2 free blocks above, no
sapling/log within 2). Plus one survival rule: underground at night and not hungry → stay there until sunrise. Nothing more on purpose: the user wants bots to learn the rest from experience and from each other. Don't
grow it into a wiki.

### 6.4 Auto memory (no model involvement)

`state/bots/<name>.json` additionally holds:
- `discoveries`: every 15 s the bot records the nearest coal/iron/copper/gold/diamond ore, water, lava,
  sand, clay, sugar cane and animals (cows, pigs, sheep, chickens, rabbits) within 32 blocks; same kind
  within 24 blocks of a known entry is merged; max 40. Shouted coordinates are stored too, and a shout
  mentioning village/base/meet sets the `village` place if none is known.
- `lessons`: failed skill results that teach something general ("gather iron_ore: need a better tool…"),
  deaths of others from the global death messages (with position from the roster); deduplicated, max 15.
The observation shows the 8 nearest discoveries and the last 8 lessons. `attack` walks to remembered animals
when none are within 48 blocks.

### 6.4.1 Conclusions (model-made lessons)

Every reply may carry `"learned": "<general conclusion>"` (free, like `say`), saved as a lesson prefixed
`Conclusion:`. When the same skill+args failed 2+ times in a row, the observation says so and asks the bot
to think about why and write a conclusion instead of repeating. The observation also states whether the bot
is OUTDOORS / under cover / UNDERGROUND (sky light at head height), which is what most wrong conclusions
were missing (e.g. hunting cows in a cave). Conclusions can be wrong; that is part of the experiment.

### 6.4.2 Mentoring and utilities

- The discovery scan also records crafting tables, furnaces/smokers, chests/barrels and beds.
- Every chest is remembered separately (`storage` in memory: "x,y,z" -> contents, time, source). Opening a
  chest records its exact contents. After `chest_store`/`chest_take` the bot says
  "Stored 15 cobblestone in the chest at x y z" / "Took ..."; bots that hear it adjust their own copy
  (`parseChestReport`, marked `[per <name>]` in the observation, which shows the 4 nearest known chests).
  `chest_take` goes to the nearest chest known to hold the item (within 96 blocks) before falling back to
  the nearest chest; a remembered chest that no longer exists is forgotten. Mentors hand over their storage.
- A bot born this run gets a mentor 4 s after its first spawn: the nearest living bot (roster distance)
  copies its home (as the newborn's `village`), crafting table/chest/furnace places (with contents), last 12
  discoveries and last 8 lessons ("From <mentor>: ...") into the newborn's memory, and whispers a welcome
  summary. Done in code on purpose: reliable, and newborns no longer start by chopping wood for a table.

### 6.5 Memory (manual)

`state/bots/<name>.json`: goal, notes, known places (home, bed, chest, furnace, crafting_table).
Notes are capped (`notesMax`); compaction is **deterministic** (oldest half merged into one
"Older notes:" line), no LLM summarization, so memory can't be corrupted by a bad model call.

### 6.5.1 Buildings are off limits

- Server side (bridge plugin, authoritative): every placed block remembers its placer
  (`placed-blocks.yml`). A bot may break blocks it placed itself, never blocks placed by a human or another
  bot. `/survivors protect <radius>` creates a protected sphere around the player (for buildings made before
  tracking); bots can't break anything inside (`protected-areas.yml`, `/survivors areas [raw]`,
  `/survivors unprotect`). Bots = names matching `protection.bot-name-pattern`.
- Bot side (so they don't waste time): `gather log` only takes logs that look like trees (leaves within a
  few blocks, nothing man-made within 2); other gathers skip blocks touching man-made blocks; nothing inside
  protected areas (refreshed from `SB|v1|areas` every 60 s). Man-made block types are in the pathfinder's `blocksCantBreak` (a closed house is
  entered through its door, see "Doors in pathfinding"), blocks touching them or inside protected areas get a huge
  dig cost, and the unstuck routine never digs them. An open window hole is still a valid path.
- A bot sets its own home with `set_home {}` (where it stands; reports sealed/leaky/warm via `room raw`), and
  automatically when it claims, places or sleeps in a bed while it has no home yet (the bed spot).
- `/msg <bot> !home` sets the bot's home to the player's position (so a house you built becomes its home);
  a bot without a bed is pointed at the nearest bed it sees ("claim it" via `sleep`).

### 6.5.2 Feeling cold

Bots read `temp raw player <name>` every 30 s, so the observation shows their BODY temperature and stage
("SHIVERING, you are getting dangerously cold..."). The cold reflex fires when the air is below
`bot.coldThresholdC` and uncomfortable OR the body stage is COLD/SHIVERING/HYPOTHERMIA. Damage while
hypothermic wakes the planner with reason "freezing damage".

### 6.5.3 Heating rooms (measured)

Sealed 5x5 shelter on a −3 °C night (RealisticSeasons defaults): no heat 1.9 °C, 1 torch 3.3, 2 torches 9.8,
4 torches 23 (comfortable), lantern 6.1, lit furnace 30.9 (too hot), campfire 41 (too hot). Room air lags
behind (thermal inertia, ~2 min), so bots judge by `equilibriumC` from `room raw`. `heat_room` adds torches
one at a time on floor cells inside the room (flood fill from the bot; a plain radius put torches behind
the walls) until the target is 12-28 °C. `build_shelter` runs it at the end; the warm_home reflex uses it;
the progress step "warm shelter" is done only when the room is warm (or 4+ torches without readings).

### 6.5.4 Nights (most deaths)

Death tally after the first evening: 22 zombie, 5 stray, 3 skeleton, 2 spider, 2 creeper, 2 fall, 2 drowned,
1 cold. So at night (time 12800-23000), a bot under open sky that isn't sleeping gets the `night_shelter`
reflex: go home if it is within 48 blocks, else `digBunker`: dig 3 straight down (natural blocks only,
solid floor below, no water/lava beside) and place a block in the cell above the head (at 2 deep that cell
is at surface level with nothing to attach a block to). While bunkered at night the planner doesn't start
new actions; in the morning `leave_bunker` runs go_surface. Fight/flee still come first.

### 6.6 Food

- `eat` reflex when food <= 14 (or hurt and not full) and there is food.
- **`hunt` reflex** when food <= 6, nothing to eat, and prey (cow/pig/sheep/chicken/rabbit) is visible within
  48 blocks or remembered: attack it (walking to a remembered herd if needed), then pick up the drops.
  Cooldown 20 s. The progress ladder's NEXT STEP becomes FOOD whenever food <= 10 and there is nothing to eat.
  **Why:** a bot starved while the model kept choosing "gather wood".

## 7. Server access: RCON

### 7.1 Server-side crafting (`bot.serverCrafting`, default true)

mineflayer's window-click crafting desyncs on 1.21.x: ghost stacks with count 0, leftover planks turning
into buttons/crafting tables, items dropped on the ground, crafted tools that never appear. Crafting now
checks the SAME rules in code (ingredients in the inventory; for 3x3 recipes a placed crafting table within
4.5 blocks, placing/walking to one first) and then swaps ingredients for the result via RCON
(`clear <bot> <item> <n>` per ingredient, rolled back on any shortfall, then `give`). Smelting still uses
the furnace window. `scripts/craft-test.mjs` is a live smoke test. Results are only reported as
"crafted" when the item count really went up.

### 7.2 Spawn protection must be 0

Bots are not ops; with the vanilla default `spawn-protection=16` they cannot place or break ANY block within
16 blocks of world spawn, which is exactly where they start (tables "refused", logs "unreachable", shelters
failing). `docker-compose.yml` sets `SPAWN_PROTECTION: 0`.

Bots are **not** op. Everything privileged goes through one serialized RCON connection
(`src/rcon/rcon.ts`): `survivors ...` (bridge), `temp raw` / `room raw` (RealisticSeasons, queried
**for the bot's position** by the orchestrator), `whitelist add`, `spawnpoint`, `tp`. Names are
validated (`[A-Za-z0-9_]{1,16}`) before being interpolated into commands.

## 8. Offline mode

Bots have no Mojang accounts, so the server runs `ONLINE_MODE=FALSE` and
`ENFORCE_SECURE_PROFILE=FALSE` (offline clients can't sign chat). This is insecure by nature:
whitelist on (auto-whitelisting of bots), firewall the port, RCON only on localhost.

## 9. Contracts (STABLE)

Both are single lines, `|`-separated, ending in a JSON object. Parsers: `src/contracts.ts`.
They may be surrounded by other output and colour codes; parsers scan for the first matching line.

### SB|v1 (SurvivorsBridge, this repo)

```
SB|v1|beds|{"beds":[{"x":int,"y":int,"z":int,"world":str,"owner":str|null,"valid":bool,"reason":str}]}
SB|v1|canspawn|{"canSpawn":bool,"freeValidBed":{"x","y","z","world"}|null,"missing":[str],"reason":str}
SB|v1|assign|{"ok":bool,...}   SB|v1|unassign|{...}   SB|v1|scan|{...}   SB|v1|check|{...}
SB|v1|grace|{"active":bool,"remainingTicks":int,"removed":int}
```

`/survivors grace start [ticks]` (default 24000 = one day) cancels natural hostile spawns and removes
unnamed hostiles in loaded chunks; the orchestrator calls it when it seeds bots (`population.graceOnSeed`).
`/survivors inv <player>` (players only) opens a read-only snapshot of a bot's inventory.

Positions are bed **head** blocks.

### RS|v1 (RealisticSeasons, other repo)

```
/temp raw <x> <y> <z> [world]  ->  RS|v1|temp|{json}
/room raw <x> <y> <z> [world]  ->  RS|v1|room|{json}
json: inside bool, sealed bool, volume int, leaks {small:int,large:int}, tempC number,
      outsideC number, season "WINTER"|..., comfortable bool
```

Unknown command (plugin not installed) ⇒ seasons disabled for the rest of the run.
RealisticSeasons Java API used by the bridge via reflection:
`io.github.tadzi00.realisticseasons.api.RealisticSeasonsAPI` registered in `ServicesManager`.

Changing a contract: add a `v2` line, keep `v1` until both sides migrate.

## 10. LLM provider layer

`LLMProvider.complete({system, messages, maxTokens, temperature, model}) → {text}`.

- `ollama`: `/api/chat`, `format: "json"`, `stream: false`, `keep_alive`.
- `openai-compatible`: `/chat/completions`, optional bearer key from env, `response_format: json_object`
  (disable via `jsonMode: false` for servers that reject it).
- `anthropic`: `/v1/messages` with `x-api-key` + `anthropic-version: 2023-06-01`. **`temperature` is
  deliberately not sent** (current Claude models reject non-default sampling params); optional
  `output_config.effort`. Only `text` blocks are used; `stop_reason: refusal` is an error.
- Each provider instance is shared by all bots and wrapped in a FIFO queue with `concurrency`
  (default 1 — a single local GPU). Timeouts via `AbortSignal.timeout`, retries with exponential
  backoff on network errors / 408 / 429 / 5xx only.

### 10.1 Latency notes (local Ollama on a 6 GB GPU)

qwen2.5:7b with Ollama's default 4096 context is 5.15 GB; on an RTX 2060 shared with a Minecraft client only
~4.2 GB fit in VRAM, the rest runs on the CPU, and a decision took 35-50 s. The smart system prompt is ~2100
tokens; with the observation a call is ~3000 tokens, close to the 4096 default (beyond it Ollama silently
drops the START of the prompt, i.e. the rules). The system prompt therefore contains no bot name, so bots of
the same tier send an identical prefix that Ollama can reuse from its prompt cache. Ollama decisions log
`stats` (prompt/output tokens and ms) and `promptChars` in each `decision` event. Providers accept
`numCtx` to raise the context window (costs VRAM).

## 11. Logging

Console: concise one-liners (`LOG_LEVEL`). JSONL per bot in `logs/<name>.jsonl`: `spawn`, `heard`,
`decision` (observation **hash**, raw model text, validity), `skill` (args, result, ms), `reflex`,
`planner_error`, `death`; plus `logs/orchestrator.jsonl` (`seed`, `birth`, `death`). Full observations
are not logged (size); the hash lets you spot repeated identical situations.

## 12. Known limitations

- **Not tested against a live server in this repo's CI.** Unit tests cover pure logic; mineflayer code is
  type-checked only. Expect tuning work on real terrain.
- `build_shelter` assumes roughly flat ground and an empty footprint; trees/slopes cause failed
  placements (reported in the result). The doorway is sealed with blocks if no door can be made.
- Bed orientation in `place_bed` relies on mineflayer looking toward the placement point.
- Death cause is taken from the server's system death message (heuristic); fallback is a generic text.
- Lectern reading uses `openBlock` and reads slot 0 of the lectern window; not verified on all versions.
- `signBook` is used through an untyped mineflayer API; if missing, the book is written but unsigned.
- The built-in room check treats open doors as walls and ignores temperature.
- Beds placed while the plugin was not installed are unknown until `/survivors scan`.
- Temperature is polled every `temperatureCheckSeconds`, so the cold reflex can lag that long.
- `smelt` waits a fixed ~10 s per item and may return partial results.

## 12.1 Live test harness

`node scripts/harness.mjs [scenario...]` (after `npm run build`, with `.env` loaded) runs skill scenarios
(`scripts/scenarios.mjs`) with a real mineflayer bot on a temporary 3-layer platform at x≈3000, y=200, checks
the result through RCON (server truth) and removes everything afterwards. The bot gets the same plugins and
movement rules as a real agent. Scenarios: signs, books, chest, smelt, craft_tools, bed_claim, door_out,
door_in, door_detour, add_door, torch, hunt, eat, sapling, farm, ore_bonus. Run it after touching skills.
Findings it produced: beds could not be placed in a 3x3 room (now: any free foot/head pair, stand behind,
face forward); door transit used the pathfinder through the open door, which toggled it shut (now: walk
straight); smelt counted window results (now: inventory change, leftovers reported); goto said "arrived"
when it stopped short (now: reports the distance).

### 12.2 Agent harness

`node scripts/agent-harness.mjs [scenario...]` runs full `BotAgent`s (reflexes, shouts, orders) with a stub
model that always answers "wait", on a lit platform (light blocks stop night spawns), and stops a test bot
when it dies (respawned test bots would wander the real world). Scenarios: fight (kills a husk), starving
(hunt reflex), rescue (assist reflex), checkin (are-you-alive round trip), order ("build shelter" via /tell
→ sealed room). Real bots ignore chat and deaths of players named `Test*`.
Findings: alive answers waited for the 3 s tick (now immediate); far shouts with unknown speaker position
were assumed in range (now the coordinates in the shout give the distance).

### 12.3 Pathfinding limits

In dense jungle (2x2 trunks, leaves, vines) mineflayer-pathfinder often can't plan a path within its think
timeout ("Took to long to decide path to goal!" - their typo) no matter the rules. Mitigations: think
timeout 10 s, search radius 40 (impossible targets fail fast), gather prefers logs with a free standing spot
beside them and skips a whole tree (logs within 4 blocks) after a planning failure, then explores away.
The "don't dig next to buildings" rule uses a ManMadeIndex (set of man-made block positions refreshed every
5 s) instead of reading 6 neighbours per candidate block.

## 13. Not bugs

- A bot that dies **never comes back**, and its name is never reused.
- Bots ignore chat from far-away or invisible players.
- A basic bot is not promoted when a smart bot dies; the next newborn is smart instead.
- The population does not grow when every bot has a bed but there is no **extra** free valid bed.
- A bed in a leaky / unheated room does not count (with RealisticSeasons, "comfortable" is required).
- A bot's second and later beds are left **unclaimed** on purpose (they are for newborns).
- The planner sometimes "wastes" a turn after a reflex interrupt — it re-plans from fresh state.
- `/temp raw` "Unknown command" in the logs once at startup when RealisticSeasons is not installed.
- The LLM sees an abbreviated observation (counts + nearest position per block type), not the world.
- With `concurrency: 1`, bots queue for the GPU; decisions can lag behind with many bots.
- No hostile mobs for the first Minecraft day after the bots are (re)seeded: the grace period.
- Bare-handed bots run from zombies instead of fighting them (see 2.1).
- The NEXT STEP hint is sometimes not the smartest move (e.g. asks for a sword before food). It is a fixed
  ladder on purpose; smart bots may deviate.
- `craft crafting_table` is refused when the bot already has one (it used to pile up tables).
- After every craft the 2x2 crafting grid is emptied (`craftClean`): leftover planks there silently became
  crafting tables (4 planks) or buttons (1 plank).
- `build_shelter` digs out leaves/panes/fences/snow/ice in its outline and replaces them with real blocks.
  The door is crafted before building and placed on the floor block's top face. If that fails the doorway
  is walled up (room stays sealed) and remembered as place `doorway`; `add_door` fixes it later.
- While fighting/fleeing (reflex busy, pvp target, attack skill) the unstuck routine is off: standing still
  next to a mob is not "stuck" (it used to stop the pathfinder and end fights).
- Bots put on better armor automatically (protection tier leather < gold < chain < iron/turtle < diamond <
  netherite) every 10 s and right after picking something up. Leather is warmest but lowest tier: tier wins.
- `gather` also mines more valuable ores it passes within 8 blocks (diamond > iron > gold > coal > copper >
  redstone/lapis, only if its tool can harvest them, max 8 per call) and reports "also mined ...".
- `build_shelter` hollows out up to 20 natural blocks inside its outline and refuses when the spot is more
  solid than that ("too enclosed, move to open ground"); it puts the door on the wall side with the most free
  space outside and digs a 2-block exit in front of it. (It used to build "shelters" that were solid stone
  inside a hill, with the door facing rock.)
- `chest_store` / `chest_take` report what really moved, measured on the chest side (the player-inventory
  view lags while a container is open). Every chest the bot opens is remembered as place `chest` with a
  note "contains ..." shown in the observation; `chest_take {items:["list"]}` just looks inside.
  `scripts/chest-test.mjs` is a live smoke test.
- `sleep` walks to a standable spot next to the bed (either half) instead of at the bed block itself.
- Houses: `gather` never mines blocks within 5 blocks of the bot's home/village or in protected areas (its
  floor and walls are plain dirt/cobblestone and were being mined). When the bot is inside its home box and
  the target is outside (or the reverse), `transitHomeDoor` walks to the door, opens it, steps through and
  closes it, before normal pathfinding (`gotoNear`, `gotoXZ`, each gather target). No door found → normal
  pathfinding, which still can't dig within 4 blocks of home.
- All bots' homes are shared (`HomeRegistry`, updated every second): the pathfinder can't dig within 4
  blocks of ANY bot's home, and the door transit applies to any known home (own, village, teammates'),
  so a visitor uses the door too. A bot without a home used to tunnel through a teammate's shelter wall.
- Block placement reach is measured from the eyes to the block centre (≤ 4.5) like Minecraft. Feet-to-corner
  made roof corners look out of reach; the bot pathfound "near" them, i.e. onto its own roof, could then not
  place the door (server rejected it) and left a hole where it stood. Success = the block there changed
  (torches are walk-through, the old "not air-like" check reported them as failed).
- Bigger shelters: `build_shelter` size 4-11. `extend_shelter {direction,length}` builds a room against a
  side of the nearest own shelter (`memory.shelters` outlines), opening a 2-high gap in the shared wall
  FIRST and walking through it; if the old door is on that wall the rooms connect through the door.
  `scripts/shelter-test.mjs` (live) builds 5x5 + east extension and checks both are one sealed room.
- Check-ins: "are you alive?" questions and their answers are urgent shouts (no cooldown, don't reset it);
  the helper waits 60 s for an answer. The same question in normal chat is answered in chat, by /msg
  privately. (Replies used to wait for the shout cooldown and arrive after the helper gave up.)
- `follow` refuses other bots ("split the work instead"); only humans can be followed. A bot used to spend
  most of its time walking behind its teammate.
- Pathfinder scaffolding is off (`scafoldingBlocks = []`, no 1x1 towers): it placed blocks to climb/bridge
  and dug them out again right after. Bots walk around obstacles instead (less mobility, on purpose).
- Bots never dig blocks within 4 blocks of their home (pathfinder `exclusionAreasBreak`), so they don't
  tunnel out of their own shelter.
- **Civilisation: knowledge flow** (`bot/society.ts`, pure + tested; agent `socialTick` every 4 s):
  - *Meetings*: two bots within `chatRange` swap what the other lacks (village, the 2 most valuable finds,
    1 lesson), said aloud and stored with the source. A meeting only counts (10 min cooldown per pair) when
    something was told.
  - *News shouts* (queued, sent when the shout cooldown allows, cut to `shout.maxWords`): valuable ore found
    (once per 64-block area), village founded, a death (told by the nearest living bot, with where/what).
  - *Ask & answer*: a failed search shouts "Anyone know where X are?" (once per 10 min per thing); anyone
    who knows answers (say if in earshot, else shout); heard places with coordinates become finds.
  - *Less chatter*: the model's "say" is dropped when it is narration ("Heading to gather logs") or close to
    something said in the last 5 min; answers to players are always sent.
  - *Village library* (`library_write` / `library_read`, chest in `village.json`): best lessons + finds as
    a written book; newborns read it after being taught; bots with a book and quill add to it (daytime,
    in the village, every 30 min at most).
- **Air first**: in water with oxygen < 10, the reflex tick aborts any running reflex (a 40 s fight in
  water drowned a bot) so `surface` runs; the fight loop honours its abort signal.
- **Emergency hut**: when no night hole can be dug (water next to it, built ground), the bot walls itself
  in with 10 blocks (4 sides at feet and head, roof + one support); memory place `bunker` note `hut`; in the
  morning `leaveHut` opens one side and steps out.
- **Food reserve & sharing**: the ladder wants 8+ food; by day with < 3 food items and an animal within 24
  blocks the `hunt` reflex stocks up. `shareSupplies` (social tick, either side, every 3 min per pair): a
  teammate with < 2 food and hunger <= 14 gets up to 6 of our food if we have >= 4; one without a pickaxe gets
  our worst spare. "can you give me food/pickaxe/torches?" in earshot is honoured (`answerRequest`). `give`
  understands "food"/generic names, hands over at 1.5 blocks, and the receiver walks to the dropped items.
- **Farming, phase 1 (wheat)**: `farm {action:"setup"}` picks the water block near the village with the
  most flat soil it keeps wet (same y, within 4 blocks; `skills/fieldPlan.ts`, pure), crafts a wooden hoe,
  collects seeds from tall grass (`gather seeds`), tills only as many tiles as it can plant (bare farmland
  reverts), plants, and stores `village.json` `field`. `farm {action:"tend"}` harvests ripe wheat (age 7),
  picks up drops, replants, bakes bread (3 wheat). Chore: by day an idle bot within 64 blocks tends the field
  every 20 min (the time is shared, first comes first). Ladder step "wheat field"; cheat sheet: animals do
  not come back, fields need water within 4 blocks (no bucket -> next to a lake/river).
  Next phases: animal pens + breeding, then a heated greenhouse for winter.
- **Wool & wood keep coming back**: `shear` (shears from 2 iron) takes wool from living sheep (sheep flag
  0x10 in metadata 17 = sheared; they regrow by eating grass); the bed hint prefers shearing. After chopping
  logs the bot plants the saplings it picked up (forced `plant_sapling`), and `gather` looks for wood up to
  3 x 64 blocks away (the village area gets cut bare).
- **Births** (`population.*`): at most `maxBirthsPerDay` (2) per MC day; only at a bed with a settled bot
  within `birthNeedsBotWithin` (24) blocks; the newborn's home and bed are its birth bed; it is an
  *apprentice* (`apprenticeSeconds`, 300): no digging, no planning (answers only) until the nearest bot has
  walked over and taught it its 5 most valuable lessons (`topLessons`: player-taught > real failures >
  conclusions), the village, utilities and best finds. Then it reads the library.
- **Names**: the oldest living bot names the newborn with the model from its memories (often honouring a
  dead friend: Kira -> Kiro). `cleanBotName`: letters only, `Surv_` prefix, never any name that ever
  lived (a taken name gets a close variant). Bridge `protection.bot-name-pattern` is `^Surv_[A-Za-z0-9]+$`.
- **Trials** (`scripts/trial.mjs`): fresh full bots with the REAL model get materials and a plain-language
  order on the test platform; results are checked on the server and the bot's decisions printed
  (shelter_beds, chest_smelt, tools, village_second, book, sign). Run after behaviour changes; they found most
  of the bugs listed in the git log of 2026-11-01.
- **Questions are answered from written knowledge**: a private message gets the best matching snippets of
  the bot's books, nearby signs, lessons and notes (`bot/knowledge.ts`) next to it; the observation also
  shows nearby sign text and carried books. Only a plan made after the message may answer it.
- **Bunker**: the bot centres on the cell before digging and must end up in the hole; a "bunkered" bot
  more than 2.5 blocks from its bunker forgets it. While dug in it still answers messages (only
  `BUNKER_SAFE_SKILLS` run). The model sees its last 3 thoughts and what is still planned.
- **One village** (`bot/village.ts`, `state/village.json`, shared by all agents): founded by the first
  shelter (or seeded from a bot's remembered village/home). `build_shelter` walks to the village when
  farther than `VILLAGE_RADIUS` (40) and builds on a plot beside an existing building (2-block path between,
  `plotsNextTo`). A new shelter only becomes "home" if the bot has none in the village; `set_home` refuses
  spots outside the village when the current home is inside. A home room the bot stands in (also a
  player-built one) is added as a building (`villageTick`, from the room scan).
- **Any lit room is a shelter** (`shelterCheck`): walls + roof (room scan), 3+ blocks of headroom on every
  floor cell, a torch/lantern/campfire inside. `adoptShelters` (village tick) scans rooms around lights
  within 24 blocks and the room the bot stands in, adds them to the village (`owner: "found"`), and a bot
  without a real home (none, or just an outdoor spot) moves into the one it stands in or the nearest. The
  observation says whether the current room counts as a shelter and why not.
- **Room plans** (`skills/roomPlan.ts`): a floor-level flood fill from the bot's feet (doors are boundaries,
  furniture is inside, a cell under open sky = outdoors). The observation shows an ASCII top view (# wall,
  D door, + doorway, B/T/C/F/t furniture) and the best free spots (against walls, not the doorway). Every
  placement (free spots, place_block, place_bed) refuses the doorway (`isKeepClear`: a door in the cell or
  one of its 4 neighbours).
- **One Movements for everything**: mineflayer-pvp and mineflayer-collectblock each create their own default
  `Movements` and call `setMovements` on every attack/gather (dig anywhere, scaffold, no doors, no home
  rules); later gotos kept using them. The agent sets `bot.pvp.movements` and `bot.collectBlock.movements` to
  its own. Below everything, `bot.dig` refuses home/protected/built-area blocks outside build skills
  (`HOME_BUILD_SKILLS`) and logs the caller (`dig_refused`).
- **Lava**: `LavaIndex` (refreshed every 5 s) adds a pathfinder step cost: lava under/in the cell = forbidden
  (100), lava next to it = 30. `dontCreateFlow` / `dontMineUnderFallingBlock` are locked on with
  defineProperty: collectblock sets them false on every gather and shares our Movements.
- **Ores**: any `X_ore` query also matches `deepslate_X_ore` (below y=0 nearly all ore is deepslate);
  "iron"/"diamond"/... aliases too. `gather` crafts the pickaxe it needs when it can.
- **Tools**: `craft` refuses a tool when the bot already has the same kind at the same or a better tier.
- **Doors in pathfinding** (`enableDoorPathing`, `bot/doors.ts`): mineflayer-pathfinder's `canOpenDoors`
  only knows fence gates, and its gate path stalls forever (the `placing` flag is never cleared after
  `useOne`). So doors were solid unbreakable blocks, no route went through a door, and bots dug a hole next
  to it. Now `canOpenDoors` is OFF on purpose; wooden doors (both halves, open or closed) are passable in
  `getBlock`, a 150 ms timer toggles a door on the next path nodes ONLY if its panel blocks the walking
  direction (path step into the door, not the bot position: that cut corners and flapped the door), and
  closes doors it opened once 2+ blocks past (heat). Open != passable: a door placed sideways (facing along
  the wall) is walkable closed and blocks when opened. `transitHomeDoor` uses the same check
  (`doorBlocksAxis`). `placeDoor` stands on the cell just inside the doorway (mineflayer turns to the floor
  block, and the door takes the bot's facing) and re-places a door that came out sideways. Iron doors stay solid. Digging within 10 blocks (±4 y) of a known door costs
  +`DOOR_DIG_PENALTY` (12) per block on top of the normal dig cost (wrapped `safeOrBreak`, because the
  pathfinder only uses `exclusionAreasBreak` as an allowed/forbidden switch), so a route through a door
  wins unless the detour is ~12 blocks longer per block that would be dug. Scenario `door_detour`.
