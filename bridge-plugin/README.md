# SurvivorsBridge (Paper plugin)

Server-side helper for **mc-ai-survivors**. It is the single source of truth for beds:
it indexes every placed bed, tracks which bot owns which bed, decides whether each bed's room is
a valid shelter, and answers the population-growth question over RCON.

- Package: `io.github.tadzi00.survivorsbridge`, plugin name `SurvivorsBridge`
- Target: Paper `1.21.4` API (`api-version: 1.21`), Java 21
- `softdepend: [RealisticSeasons]`

## Build

```bash
cd bridge-plugin
./gradlew build          # -> build/libs/SurvivorsBridge-<version>.jar
```

Gradle 8.10 runs on Java 11+; the foojay toolchain resolver downloads a JDK 21 for compilation
automatically if none is installed. Copy the jar into the repo's `plugins/` folder.

## Commands

All under `/survivors`, permission `survivorsbridge.admin` (default: op). Work from the console and
over RCON. Lines starting with `SB|v1|` are a **stable machine contract** (see `../DESIGN.md`).

| Command | Output |
|---|---|
| `/survivors beds [raw]` | human list, or `SB\|v1\|beds\|{"beds":[{x,y,z,world,owner\|null,valid,reason}]}` |
| `/survivors canspawn raw <bot1,bot2,...>` | `SB\|v1\|canspawn\|{"canSpawn":bool,"freeValidBed":{x,y,z,world}\|null,"missing":[names],"reason":str}` |
| `/survivors assign <bot> <x> <y> <z> [world]` | `SB\|v1\|assign\|{"ok":bool,...}` — any block of the bed works; head position is stored |
| `/survivors unassign <bot>` | `SB\|v1\|unassign\|{"ok":true,"bot":..,"hadBed":bool}` |
| `/survivors scan <radius> [x y z [world]]` | indexes existing beds in a cube (radius ≤ 128) — use once on an old world |
| `/survivors check <x> <y> <z> [world]` | `SB\|v1\|check\|{"valid":bool,"reason":str,"checker":str}` — debug a room |

Use `-` (or nothing) as the bot list for "no living bots".

### Spawn rule (exact)

```
canSpawn = every listed living bot owns a bed whose room is valid
           AND at least one valid bed has no owner
```

`missing` lists the bots without a valid owned bed. `freeValidBed` is the first unowned valid bed
ordered by (world, x, y, z). Owner names compare case-insensitively.

`reason` values: `ok`, `bots_without_valid_bed`, `no_free_valid_bed`.

## Bed index

- Bed **head** positions are stored in `plugins/SurvivorsBridge/beds.yml` (beds + owners).
- Updated on `BlockPlaceEvent` (checked one tick later, when both halves exist), `BlockBreakEvent`,
  `BlockBurnEvent`, `EntityExplodeEvent`, `BlockExplodeEvent`.
- Self-healing: every evaluation drops index entries whose block is no longer a bed
  (covers pistons, WorldEdit, etc.). Evaluating loads the bed's chunk if needed.
- One bed per bot, one owner per bed. `assign` moves the bot's ownership and replaces any other owner.

### Auto-assign

On `PlayerBedEnterEvent` with result `OK` (sleeping) or `NOT_POSSIBLE_NOW` (daytime click — this
still sets the respawn point), the bed is assigned to that player, if the name matches
`auto-assign.name-pattern` and the bed is not owned by someone else (unless
`auto-assign.steal-owned-beds: true`).

## Room validity

The room is checked at the centre of the block **above the bed head**.

- **RealisticSeasons installed** (and `room-check.mode: auto`): the plugin's API service is looked up
  by reflection from Bukkit's `ServicesManager` — interface
  `io.github.tadzi00.realisticseasons.api.RealisticSeasonsAPI` with
  `boolean isInsideSealedRoom(Location)`, `boolean isComfortable(Location)`,
  `double getTemperature(Location)`, `String getSeason(World)`.
  Valid = sealed **and** comfortable. Reasons: `not_sealed`, `not_comfortable`, `seasons_api_error`.
- **Otherwise** (built-in): bounded flood fill (≤ `room-check.max-volume`, default 512 blocks) through
  passable blocks; fails if any reached block has sky access (`open_to_sky`), the fill is too large
  (`too_large_or_open`) or there is no air above the bed (`no_air_above_bed`). Doors, trapdoors and
  fence gates count as walls (open or closed). Temperature is ignored.

## Config (`plugins/SurvivorsBridge/config.yml`)

```yaml
room-check:
  mode: auto        # auto | builtin
  max-volume: 512
auto-assign:
  enabled: true
  name-pattern: '.*'
  steal-owned-beds: false
```
