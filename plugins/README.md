# plugins/

Mounted read-only into the Minecraft container at `/plugins` (itzg copies it into `/data/plugins`).

Put here:

- `SurvivorsBridge-<version>.jar` — **required**; build it with `cd bridge-plugin && ./gradlew build`
  and copy `bridge-plugin/build/libs/SurvivorsBridge-*.jar` here.
- `RealisticSeasons-*.jar` — **optional**; enables seasons, temperature and the
  "sealed + comfortable room" bed validity. Without it, SurvivorsBridge falls back to a simple
  enclosure check and bots ignore temperature.

Jars in this folder are git-ignored.
