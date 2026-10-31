package io.github.tadzi00.survivorsbridge;

import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.entity.Enemy;
import org.bukkit.entity.Entity;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.CreatureSpawnEvent;
import org.bukkit.persistence.PersistentDataType;

import java.util.Set;

/**
 * "No hostile mobs on the first day": while a world's grace period runs (until a stored world full-time),
 * natural hostile spawns are cancelled. The orchestrator starts it when it seeds the first bots (and after an
 * extinction re-seed). Spawners, commands, eggs and plugin spawns are not affected.
 */
public final class GracePeriod implements Listener {
    private static final Set<CreatureSpawnEvent.SpawnReason> BLOCKED = Set.of(
            CreatureSpawnEvent.SpawnReason.NATURAL,
            CreatureSpawnEvent.SpawnReason.PATROL,
            CreatureSpawnEvent.SpawnReason.RAID,
            CreatureSpawnEvent.SpawnReason.REINFORCEMENTS,
            CreatureSpawnEvent.SpawnReason.JOCKEY,
            CreatureSpawnEvent.SpawnReason.MOUNT,
            CreatureSpawnEvent.SpawnReason.TRAP,
            CreatureSpawnEvent.SpawnReason.LIGHTNING);

    private final NamespacedKey untilKey;

    public GracePeriod(SurvivorsBridgePlugin plugin) {
        this.untilKey = new NamespacedKey(plugin, "grace_until");
    }

    public long until(World w) {
        Long v = w.getPersistentDataContainer().get(untilKey, PersistentDataType.LONG);
        return v == null ? 0 : v;
    }

    public long remainingTicks(World w) {
        return Math.max(0, until(w) - w.getFullTime());
    }

    public boolean active(World w) {
        return remainingTicks(w) > 0;
    }

    /** Starts (or restarts) the grace period and removes hostile mobs already in loaded chunks. */
    public int start(World w, long ticks) {
        w.getPersistentDataContainer().set(untilKey, PersistentDataType.LONG, w.getFullTime() + Math.max(0, ticks));
        int removed = 0;
        for (Entity e : w.getEntities()) {
            if (e instanceof Enemy && e.isValid() && e.customName() == null) {
                e.remove();
                removed++;
            }
        }
        return removed;
    }

    public void stop(World w) {
        w.getPersistentDataContainer().remove(untilKey);
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onSpawn(CreatureSpawnEvent e) {
        if (e.getEntity() instanceof Enemy && BLOCKED.contains(e.getSpawnReason()) && active(e.getLocation().getWorld())) {
            e.setCancelled(true);
        }
    }
}
