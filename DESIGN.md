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
Nothing more on purpose: the user wants bots to learn the rest from experience and from each other. Don't
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
  entered through its door; `canOpenDoors` is on), blocks touching them or inside protected areas get a huge
  dig cost, and the unstuck routine never digs them. An open window hole is still a valid path.
- `/msg <bot> !home` sets the bot's home to the player's position (so a house you built becomes its home);
  a bot without a bed is pointed at the nearest bed it sees ("claim it" via `sleep`).

### 6.5.2 Feeling cold

Bots read `temp raw player <name>` every 30 s, so the observation shows their BODY temperature and stage
("SHIVERING, you are getting dangerously cold..."). The cold reflex fires when the air is below
`bot.coldThresholdC` and uncomfortable OR the body stage is COLD/SHIVERING/HYPOTHERMIA. Damage while
hypothermic wakes the planner with reason "freezing damage".

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
- Bots open doors (`canOpenDoors`) and never dig blocks within 4 blocks of their home (pathfinder
  `exclusionAreasBreak`), so they don't tunnel out of their own shelter.
