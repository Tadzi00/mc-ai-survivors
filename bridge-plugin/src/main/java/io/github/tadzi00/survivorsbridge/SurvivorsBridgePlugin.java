package io.github.tadzi00.survivorsbridge;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.command.PluginCommand;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * SurvivorsBridge: server-side helper for the mc-ai-survivors orchestrator.
 * Indexes beds, tracks bot bed ownership and answers the population-growth question over RCON.
 */
public final class SurvivorsBridgePlugin extends JavaPlugin {
    private BedIndex index;
    private RealisticSeasonsBridge seasons;
    private SimpleEnclosureChecker builtin;
    private GracePeriod grace;
    private final InventoryViewer viewer = new InventoryViewer();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        index = new BedIndex(new File(getDataFolder(), "beds.yml"), getLogger());
        index.load();
        builtin = new SimpleEnclosureChecker(getConfig().getInt("room-check.max-volume", 512));
        getServer().getPluginManager().registerEvents(new BedListener(this), this);
        grace = new GracePeriod(this);
        getServer().getPluginManager().registerEvents(grace, this);
        getServer().getPluginManager().registerEvents(viewer, this);
        PluginCommand cmd = getCommand("survivors");
        if (cmd != null) {
            SurvivorsCommand handler = new SurvivorsCommand(this);
            cmd.setExecutor(handler);
            cmd.setTabCompleter(handler);
        }
        // RealisticSeasons (softdepend) is enabled before us when present; still hook lazily.
        Bukkit.getScheduler().runTask(this, () -> getLogger().info("Room checker: " + roomChecker().name()));
        getLogger().info("SurvivorsBridge enabled with " + index.beds().size() + " indexed beds");
    }

    @Override
    public void onDisable() {
        if (index != null) index.save();
    }

    public InventoryViewer viewer() {
        return viewer;
    }

    public GracePeriod grace() {
        return grace;
    }

    public BedIndex index() {
        return index;
    }

    /** RealisticSeasons checker if available (and allowed by config), otherwise the built-in one. */
    public RoomChecker roomChecker() {
        String mode = getConfig().getString("room-check.mode", "auto");
        if ("builtin".equalsIgnoreCase(mode)) return builtin;
        if (seasons == null) seasons = RealisticSeasonsBridge.tryCreate(getLogger());
        if (seasons != null) return seasons;
        return builtin;
    }

    public RealisticSeasonsBridge seasons() {
        roomChecker();
        return seasons;
    }

    /** The point that represents a bed's room: the centre of the block above the bed head. */
    public static Location roomPoint(World world, BedPos p) {
        return new Location(world, p.x() + 0.5, p.y() + 1.0, p.z() + 0.5);
    }

    /**
     * Evaluates every indexed bed. Beds whose block is gone are dropped from the index
     * (self-healing for removals we did not see, e.g. pistons or WorldEdit).
     */
    public List<BedState> evaluateBeds() {
        List<BedState> out = new ArrayList<>();
        RoomChecker checker = roomChecker();
        for (BedPos p : index.beds()) {
            World w = Bukkit.getWorld(p.world());
            if (w == null) {
                out.add(new BedState(p, index.ownerOf(p), RoomCheck.fail("world_not_loaded")));
                continue;
            }
            Block b = w.getBlockAt(p.x(), p.y(), p.z()); // loads the chunk synchronously if needed
            BedPos head = BedListener.headOf(b);
            if (head == null || !head.equals(p)) {
                index.removeBed(p);
                continue;
            }
            out.add(new BedState(p, index.ownerOf(p), checker.check(roomPoint(w, p))));
        }
        return out;
    }
}
