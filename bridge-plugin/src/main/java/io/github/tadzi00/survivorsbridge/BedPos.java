package io.github.tadzi00.survivorsbridge;

import java.util.Objects;

/** Position of a bed's HEAD block. Pure value type (no Bukkit dependency) so it is unit-testable. */
public record BedPos(String world, int x, int y, int z) {
    public BedPos {
        Objects.requireNonNull(world, "world");
    }

    /** Stable key used for persistence: {@code world;x;y;z}. */
    public String key() {
        return world + ";" + x + ";" + y + ";" + z;
    }

    public static BedPos parseKey(String key) {
        String[] p = key.split(";");
        if (p.length != 4) throw new IllegalArgumentException("bad bed key: " + key);
        return new BedPos(p[0], Integer.parseInt(p[1]), Integer.parseInt(p[2]), Integer.parseInt(p[3]));
    }

    public String toJson() {
        return Json.obj()
                .put("x", x).put("y", y).put("z", z).put("world", world)
                .toString();
    }
}
