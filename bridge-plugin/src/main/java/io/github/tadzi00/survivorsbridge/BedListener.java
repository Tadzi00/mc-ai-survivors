package io.github.tadzi00.survivorsbridge;

import org.bukkit.Bukkit;
import org.bukkit.block.Block;
import org.bukkit.block.data.type.Bed;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockBurnEvent;
import org.bukkit.event.block.BlockExplodeEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityExplodeEvent;
import org.bukkit.event.player.PlayerBedEnterEvent;

import java.util.List;
import java.util.regex.Pattern;

/** Keeps the {@link BedIndex} in sync with the world and auto-assigns beds bots sleep in. */
public final class BedListener implements Listener {
    private final SurvivorsBridgePlugin plugin;

    public BedListener(SurvivorsBridgePlugin plugin) {
        this.plugin = plugin;
    }

    /** Returns the HEAD block position of a bed block, or null if the block is not a bed. */
    public static BedPos headOf(Block block) {
        if (!(block.getBlockData() instanceof Bed bed)) return null;
        Block head = bed.getPart() == Bed.Part.HEAD ? block : block.getRelative(bed.getFacing());
        return new BedPos(head.getWorld().getName(), head.getX(), head.getY(), head.getZ());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent e) {
        Block b = e.getBlockPlaced();
        // The second half of the bed is placed by the server after the event; check one tick later.
        Bukkit.getScheduler().runTask(plugin, () -> {
            BedPos p = headOf(b);
            if (p != null) plugin.index().addBed(p);
        });
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBreak(BlockBreakEvent e) {
        removeIfBed(e.getBlock());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBurn(BlockBurnEvent e) {
        removeIfBed(e.getBlock());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onEntityExplode(EntityExplodeEvent e) {
        removeAll(e.blockList());
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBlockExplode(BlockExplodeEvent e) {
        removeAll(e.blockList());
        // Beds exploding in the nether/end: the exploded block itself.
        removeIfBed(e.getBlock());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onBedEnter(PlayerBedEnterEvent e) {
        if (!plugin.getConfig().getBoolean("auto-assign.enabled", true)) return;
        // OK = sleeping; NOT_POSSIBLE_NOW = daytime click, which still sets the respawn point.
        PlayerBedEnterEvent.BedEnterResult r = e.getBedEnterResult();
        if (r != PlayerBedEnterEvent.BedEnterResult.OK && r != PlayerBedEnterEvent.BedEnterResult.NOT_POSSIBLE_NOW) return;
        String name = e.getPlayer().getName();
        Pattern pattern = Pattern.compile(plugin.getConfig().getString("auto-assign.name-pattern", ".*"));
        if (!pattern.matcher(name).matches()) return;
        BedPos p = headOf(e.getBed());
        if (p == null) return;
        String current = plugin.index().ownerOf(p);
        if (current != null && !current.equalsIgnoreCase(name)
                && !plugin.getConfig().getBoolean("auto-assign.steal-owned-beds", false)) {
            return;
        }
        plugin.index().assign(name, p);
        plugin.getLogger().info("Auto-assigned bed " + p.key() + " to " + name);
    }

    private void removeAll(List<Block> blocks) {
        for (Block b : blocks) removeIfBed(b);
    }

    private void removeIfBed(Block b) {
        BedPos p = headOf(b);
        if (p != null) plugin.index().removeBed(p);
    }
}
