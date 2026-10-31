package io.github.tadzi00.survivorsbridge;

import org.bukkit.Bukkit;
import org.bukkit.ChunkSnapshot;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;
import org.bukkit.entity.Player;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * {@code /survivors} command. Lines prefixed {@code SB|v1|} are a STABLE machine contract consumed
 * by the orchestrator over RCON — do not change their shape without bumping the version.
 */
public final class SurvivorsCommand implements TabExecutor {
    public static final String PREFIX = "SB|v1|";
    private static final int MAX_SCAN_RADIUS = 128;

    private final SurvivorsBridgePlugin plugin;

    public SurvivorsCommand(SurvivorsBridgePlugin plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length == 0) {
            help(sender);
            return true;
        }
        try {
            switch (args[0].toLowerCase()) {
                case "beds" -> beds(sender, args);
                case "canspawn" -> canSpawn(sender, args);
                case "assign" -> assign(sender, args);
                case "unassign" -> unassign(sender, args);
                case "scan" -> scan(sender, args);
                case "check" -> check(sender, args);
                case "grace" -> grace(sender, args);
                case "inv" -> inv(sender, args);
                default -> help(sender);
            }
        } catch (IllegalArgumentException e) {
            sender.sendMessage("SurvivorsBridge: " + e.getMessage());
        }
        return true;
    }

    private void help(CommandSender s) {
        s.sendMessage("/survivors beds [raw]");
        s.sendMessage("/survivors canspawn raw <bot1,bot2,...>");
        s.sendMessage("/survivors assign <bot> <x> <y> <z> [world]");
        s.sendMessage("/survivors unassign <bot>");
        s.sendMessage("/survivors scan <radius> [x y z [world]]");
        s.sendMessage("/survivors grace <start [ticks] [world]|stop [world]|status [world]>");
        s.sendMessage("/survivors inv <player>  (read-only view of a bot's inventory)");
        s.sendMessage("/survivors check <x> <y> <z> [world]");
    }

    private void beds(CommandSender s, String[] a) {
        List<BedState> states = plugin.evaluateBeds();
        if (a.length > 1 && a[1].equalsIgnoreCase("raw")) {
            List<String> rendered = new ArrayList<>();
            for (BedState b : states) rendered.add(b.toJson());
            s.sendMessage(PREFIX + "beds|" + Json.obj().raw("beds", Json.array(rendered)));
            return;
        }
        s.sendMessage("Beds (" + states.size() + ", checker=" + plugin.roomChecker().name() + "):");
        for (BedState b : states) {
            s.sendMessage(" " + b.pos().key() + " owner=" + b.owner() + " valid=" + b.room().valid()
                    + " (" + b.room().reason() + ")");
        }
    }

    private void canSpawn(CommandSender s, String[] a) {
        // Accept "canspawn raw <names>" and "canspawn <names>"; output is always the raw line.
        int i = 1;
        if (a.length > i && a[i].equalsIgnoreCase("raw")) i++;
        List<String> living = new ArrayList<>();
        if (a.length > i) {
            for (String n : String.join(",", Arrays.copyOfRange(a, i, a.length)).split(",")) {
                String t = n.trim();
                if (!t.isEmpty() && !t.equals("-")) living.add(t);
            }
        }
        SpawnRule.Result r = SpawnRule.evaluate(plugin.evaluateBeds(), living);
        s.sendMessage(PREFIX + "canspawn|" + r.toJson());
    }

    private void assign(CommandSender s, String[] a) {
        if (a.length < 5) throw new IllegalArgumentException("usage: /survivors assign <bot> <x> <y> <z> [world]");
        World w = world(s, a.length > 5 ? a[5] : null);
        Block b = w.getBlockAt(parseInt(a[2]), parseInt(a[3]), parseInt(a[4]));
        BedPos head = BedListener.headOf(b);
        if (head == null) {
            s.sendMessage(PREFIX + "assign|" + Json.obj().put("ok", false).put("reason", "no_bed_at_position"));
            return;
        }
        plugin.index().assign(a[1], head);
        s.sendMessage(PREFIX + "assign|" + Json.obj().put("ok", true).put("bot", a[1]).raw("bed", head.toJson()));
    }

    private void unassign(CommandSender s, String[] a) {
        if (a.length < 2) throw new IllegalArgumentException("usage: /survivors unassign <bot>");
        boolean r = plugin.index().unassign(a[1]);
        s.sendMessage(PREFIX + "unassign|" + Json.obj().put("ok", true).put("bot", a[1]).put("hadBed", r));
    }

    private void check(CommandSender s, String[] a) {
        if (a.length < 4) throw new IllegalArgumentException("usage: /survivors check <x> <y> <z> [world]");
        World w = world(s, a.length > 4 ? a[4] : null);
        Location loc = new Location(w, parseInt(a[1]) + 0.5, parseInt(a[2]), parseInt(a[3]) + 0.5);
        RoomCheck r = plugin.roomChecker().check(loc);
        s.sendMessage(PREFIX + "check|" + Json.obj().put("valid", r.valid()).put("reason", r.reason())
                .put("checker", plugin.roomChecker().name()));
    }

    private void scan(CommandSender s, String[] a) {
        if (a.length < 2) throw new IllegalArgumentException("usage: /survivors scan <radius> [x y z [world]]");
        int radius = Math.min(MAX_SCAN_RADIUS, Math.max(1, parseInt(a[1])));
        Location center;
        if (a.length >= 5) {
            World w = world(s, a.length > 5 ? a[5] : null);
            center = new Location(w, parseInt(a[2]), parseInt(a[3]), parseInt(a[4]));
        } else if (s instanceof Player p) {
            center = p.getLocation();
        } else {
            throw new IllegalArgumentException("console must give x y z");
        }
        World w = center.getWorld();
        int cx = center.getBlockX(), cy = center.getBlockY(), cz = center.getBlockZ();
        int minY = Math.max(w.getMinHeight(), cy - radius), maxY = Math.min(w.getMaxHeight() - 1, cy + radius);
        int found = 0;
        for (int chX = (cx - radius) >> 4; chX <= (cx + radius) >> 4; chX++) {
            for (int chZ = (cz - radius) >> 4; chZ <= (cz + radius) >> 4; chZ++) {
                ChunkSnapshot snap = w.getChunkAt(chX, chZ).getChunkSnapshot(false, false, false);
                for (int lx = 0; lx < 16; lx++) {
                    int x = (chX << 4) + lx;
                    if (Math.abs(x - cx) > radius) continue;
                    for (int lz = 0; lz < 16; lz++) {
                        int z = (chZ << 4) + lz;
                        if (Math.abs(z - cz) > radius) continue;
                        for (int y = minY; y <= maxY; y++) {
                            Material m = snap.getBlockType(lx, y, lz);
                            if (!Tag.BEDS.isTagged(m)) continue;
                            BedPos head = BedListener.headOf(w.getBlockAt(x, y, z));
                            if (head != null && head.x() == x && head.y() == y && head.z() == z
                                    && plugin.index().addBed(head)) {
                                found++;
                            }
                        }
                    }
                }
            }
        }
        s.sendMessage(PREFIX + "scan|" + Json.obj().put("added", found).put("radius", radius)
                .put("total", plugin.index().beds().size()));
    }

    /** No natural hostile mobs for a while (default: one Minecraft day). Raw line: SB|v1|grace|{...}. */
    private void grace(CommandSender s, String[] a) {
        String sub = a.length > 1 ? a[1].toLowerCase() : "status";
        GracePeriod g = plugin.grace();
        switch (sub) {
            case "start" -> {
                long ticks = a.length > 2 ? parseInt(a[2]) : plugin.getConfig().getLong("grace.default-ticks", 24000);
                World w = world(s, a.length > 3 ? a[3] : null);
                int removed = g.start(w, ticks);
                s.sendMessage(PREFIX + "grace|{\"active\":true,\"remainingTicks\":" + g.remainingTicks(w) + ",\"removed\":" + removed + "}");
            }
            case "stop" -> {
                World w = world(s, a.length > 2 ? a[2] : null);
                g.stop(w);
                s.sendMessage(PREFIX + "grace|{\"active\":false,\"remainingTicks\":0,\"removed\":0}");
            }
            case "status" -> {
                World w = world(s, a.length > 2 ? a[2] : null);
                s.sendMessage(PREFIX + "grace|{\"active\":" + g.active(w) + ",\"remainingTicks\":" + g.remainingTicks(w) + ",\"removed\":0}");
            }
            default -> throw new IllegalArgumentException("usage: /survivors grace <start [ticks] [world]|stop [world]|status [world]>");
        }
    }

    private void inv(CommandSender s, String[] a) {
        if (!(s instanceof Player viewer)) throw new IllegalArgumentException("only players can open inventories");
        if (a.length < 2) throw new IllegalArgumentException("usage: /survivors inv <player>");
        Player target = Bukkit.getPlayerExact(a[1]);
        if (target == null) throw new IllegalArgumentException(a[1] + " is not online");
        plugin.viewer().open(viewer, target);
    }

    private static World world(CommandSender s, String name) {
        if (name != null) {
            World w = Bukkit.getWorld(name);
            if (w == null) throw new IllegalArgumentException("unknown world " + name);
            return w;
        }
        if (s instanceof Player p) return p.getWorld();
        return Bukkit.getWorlds().get(0);
    }

    private static int parseInt(String v) {
        try {
            return (int) Math.floor(Double.parseDouble(v));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("not a number: " + v);
        }
    }

    @Override
    public List<String> onTabComplete(CommandSender s, Command c, String label, String[] a) {
        if (a.length == 1) {
            List<String> out = new ArrayList<>();
            for (String o : List.of("beds", "canspawn", "assign", "unassign", "scan", "check", "grace", "inv")) {
                if (o.startsWith(a[0].toLowerCase())) out.add(o);
            }
            return out;
        }
        if (a.length == 2 && (a[0].equalsIgnoreCase("inv") || a[0].equalsIgnoreCase("unassign"))) {
            List<String> out = new ArrayList<>();
            for (Player p : Bukkit.getOnlinePlayers()) {
                if (p.getName().toLowerCase().startsWith(a[1].toLowerCase())) out.add(p.getName());
            }
            return out;
        }
        return List.of();
    }
}
