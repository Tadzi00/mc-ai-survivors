package io.github.tadzi00.survivorsbridge;

import org.bukkit.configuration.ConfigurationSection;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.logging.Logger;

/**
 * Server-authoritative index of placed beds (head positions) and bot→bed ownership.
 * Persisted to {@code plugins/SurvivorsBridge/beds.yml}. One bed per bot, one bot per bed.
 */
public final class BedIndex {
    private final File file;
    private final Logger log;
    private final Set<BedPos> beds = new LinkedHashSet<>();
    /** lower-case bot name → (display name, bed). */
    private final Map<String, Owner> owners = new LinkedHashMap<>();

    public record Owner(String name, BedPos bed) {}

    public BedIndex(File file, Logger log) {
        this.file = file;
        this.log = log;
    }

    public synchronized void load() {
        beds.clear();
        owners.clear();
        if (!file.exists()) return;
        YamlConfiguration y = YamlConfiguration.loadConfiguration(file);
        for (String k : y.getStringList("beds")) {
            try {
                beds.add(BedPos.parseKey(k));
            } catch (RuntimeException e) {
                log.warning("Skipping bad bed entry " + k);
            }
        }
        ConfigurationSection o = y.getConfigurationSection("owners");
        if (o != null) {
            for (String bot : o.getKeys(false)) {
                String k = o.getString(bot);
                if (k == null) continue;
                try {
                    BedPos p = BedPos.parseKey(k);
                    beds.add(p);
                    owners.put(bot.toLowerCase(Locale.ROOT), new Owner(bot, p));
                } catch (RuntimeException e) {
                    log.warning("Skipping bad owner entry " + bot);
                }
            }
        }
    }

    public synchronized void save() {
        YamlConfiguration y = new YamlConfiguration();
        List<String> keys = new ArrayList<>();
        for (BedPos p : beds) keys.add(p.key());
        y.set("beds", keys);
        for (Owner o : owners.values()) y.set("owners." + o.name(), o.bed().key());
        try {
            file.getParentFile().mkdirs();
            y.save(file);
        } catch (IOException e) {
            log.severe("Could not save " + file + ": " + e);
        }
    }

    public synchronized boolean addBed(BedPos p) {
        boolean added = beds.add(p);
        if (added) save();
        return added;
    }

    /** Removes the bed and any ownership pointing at it. */
    public synchronized boolean removeBed(BedPos p) {
        boolean removed = beds.remove(p);
        boolean ownerRemoved = owners.values().removeIf(o -> o.bed().equals(p));
        if (removed || ownerRemoved) save();
        return removed;
    }

    public synchronized List<BedPos> beds() {
        return new ArrayList<>(beds);
    }

    public synchronized String ownerOf(BedPos p) {
        for (Owner o : owners.values()) if (o.bed().equals(p)) return o.name();
        return null;
    }

    public synchronized BedPos bedOf(String bot) {
        Owner o = owners.get(bot.toLowerCase(Locale.ROOT));
        return o == null ? null : o.bed();
    }

    /**
     * Assigns a bed to a bot: indexes the bed if needed, removes the bot's previous bed and any
     * other owner of that bed (last assignment wins).
     */
    public synchronized void assign(String bot, BedPos p) {
        beds.add(p);
        owners.values().removeIf(o -> o.bed().equals(p));
        owners.put(bot.toLowerCase(Locale.ROOT), new Owner(bot, p));
        save();
    }

    public synchronized boolean unassign(String bot) {
        boolean r = owners.remove(bot.toLowerCase(Locale.ROOT)) != null;
        if (r) save();
        return r;
    }
}
