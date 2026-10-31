package io.github.tadzi00.survivorsbridge;

import org.bukkit.Location;

/** Decides whether the space at a location is a valid shelter room. */
public interface RoomChecker {
    RoomCheck check(Location location);

    /** Short name for diagnostics ("realisticseasons" or "builtin"). */
    String name();
}
