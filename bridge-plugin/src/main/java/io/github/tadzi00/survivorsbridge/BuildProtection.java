package io.github.tadzi00.survivorsbridge;

import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.block.BlockMultiPlaceEvent;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;
import java.util.regex.Pattern;

/**
 * Stops bots from wrecking buildings:
 *  1. Every placed block remembers who placed it. A bot may break blocks it placed itself (scaffolding,
 *     its own shelter) but never blocks placed by a human or by another bot.
 *  2. Protected areas (spheres) created with /survivors protect <radius>: bots can't break anything inside.
 *     Covers buildings that existed before tracking.
 * Only players matching protection.bot-name-pattern count as bots; humans are never restricted.
 */
public final class BuildProtection implements Listener {
    public record Area(String name, String world, int x, int y, int z, int radius) {
        boolean contains(Location l) {
            if (l.getWorld() == null || !l.getWorld().getName().equals(world)) return false;
            double dx = l.getBlockX() - x, dy = l.getBlockY() - y, dz = l.getBlockZ() - z;
            return dx * dx + dy * dy + dz * dz <= (double) radius * radius;
        }
    }

    private final File placedFile;
    private final File areasFile;
    private final Logger log;
    private final Map<String, String> placedBy = new HashMap<>();
    private final List<Area> areas = new ArrayList<>();
    private Pattern botPattern;
    private boolean enabled;
    private boolean dirty;

    public BuildProtection(File dataFolder, Logger log) {
        this.placedFile = new File(dataFolder, "placed-blocks.yml");
        this.areasFile = new File(dataFolder, "protected-areas.yml");
        this.log = log;
    }

    public void configure(ConfigurationSection c) {
        enabled = c == null || c.getBoolean("enabled", true);
        botPattern = Pattern.compile(c == null ? "^Surv_\\d+$" : c.getString("bot-name-pattern", "^Surv_\\d+$"));
    }

    private static String key(Block b) {
        return b.getWorld().getName() + ";" + b.getX() + ";" + b.getY() + ";" + b.getZ();
    }

    public boolean isBot(Player p) {
        return botPattern.matcher(p.getName()).matches();
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent e) {
        if (e instanceof BlockMultiPlaceEvent m) {
            m.getReplacedBlockStates().forEach(s -> placedBy.put(key(s.getBlock()), e.getPlayer().getName()));
        } else {
            placedBy.put(key(e.getBlockPlaced()), e.getPlayer().getName());
        }
        dirty = true;
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent e) {
        Player p = e.getPlayer();
        Block b = e.getBlock();
        String k = key(b);
        if (enabled && isBot(p)) {
            String owner = placedBy.get(k);
            boolean ownBlock = p.getName().equals(owner);
            if ((owner != null && !ownBlock) || (!ownBlock && inArea(b.getLocation()) != null)) {
                e.setCancelled(true);
                return;
            }
        }
        if (placedBy.remove(k) != null) dirty = true;
    }

    public Area inArea(Location l) {
        for (Area a : areas) if (a.contains(l)) return a;
        return null;
    }

    public Area protect(Location center, int radius) {
        Area a = new Area("area" + (areas.size() + 1) + "_" + center.getBlockX() + "_" + center.getBlockZ(),
                center.getWorld().getName(), center.getBlockX(), center.getBlockY(), center.getBlockZ(), radius);
        areas.add(a);
        saveAreas();
        return a;
    }

    public Area unprotect(Location l) {
        Area a = inArea(l);
        if (a != null) {
            areas.remove(a);
            saveAreas();
        }
        return a;
    }

    public List<Area> areas() {
        return List.copyOf(areas);
    }

    public void load() {
        YamlConfiguration y = YamlConfiguration.loadConfiguration(placedFile);
        for (String k : y.getKeys(false)) placedBy.put(k.replace('|', ';'), y.getString(k));
        YamlConfiguration a = YamlConfiguration.loadConfiguration(areasFile);
        for (Map<?, ?> m : a.getMapList("areas")) {
            try {
                areas.add(new Area(String.valueOf(m.get("name")), String.valueOf(m.get("world")),
                        ((Number) m.get("x")).intValue(), ((Number) m.get("y")).intValue(), ((Number) m.get("z")).intValue(),
                        ((Number) m.get("radius")).intValue()));
            } catch (RuntimeException ex) {
                log.warning("bad protected area entry: " + m);
            }
        }
    }

    /** Called periodically and on disable. */
    public void savePlaced() {
        if (!dirty) return;
        YamlConfiguration y = new YamlConfiguration();
        // ';' and '.' are fine in values but '.' in keys means nesting; positions contain no '.', worlds might.
        placedBy.forEach((k, v) -> y.set(k.replace('.', '_').replace(';', '|'), v));
        try {
            y.save(placedFile);
            dirty = false;
        } catch (IOException ex) {
            log.warning("could not save placed blocks: " + ex.getMessage());
        }
    }

    private void saveAreas() {
        YamlConfiguration y = new YamlConfiguration();
        List<Map<String, Object>> list = new ArrayList<>();
        for (Area a : areas) {
            list.add(Map.of("name", a.name(), "world", a.world(), "x", a.x(), "y", a.y(), "z", a.z(), "radius", a.radius()));
        }
        y.set("areas", list);
        try {
            y.save(areasFile);
        } catch (IOException ex) {
            log.warning("could not save protected areas: " + ex.getMessage());
        }
    }
}
