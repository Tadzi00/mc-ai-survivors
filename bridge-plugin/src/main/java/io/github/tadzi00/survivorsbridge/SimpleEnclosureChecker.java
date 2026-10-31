package io.github.tadzi00.survivorsbridge;

import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Tag;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

/**
 * Fallback room check used when RealisticSeasons is NOT installed.
 *
 * <p>Bounded flood fill (max {@code maxVolume} blocks, default 512) through passable blocks starting
 * at the given location. The room is enclosed when the fill terminates without exceeding the limit
 * and none of the visited blocks has sky access. Doors, trapdoors and fence gates count as walls
 * whether open or closed (a deliberate simplification). Temperature is ignored.
 */
public final class SimpleEnclosureChecker implements RoomChecker {
    private static final BlockFace[] FACES = {
            BlockFace.UP, BlockFace.DOWN, BlockFace.NORTH, BlockFace.SOUTH, BlockFace.EAST, BlockFace.WEST
    };

    private final int maxVolume;

    public SimpleEnclosureChecker(int maxVolume) {
        this.maxVolume = maxVolume;
    }

    @Override
    public String name() {
        return "builtin";
    }

    @Override
    public RoomCheck check(Location location) {
        World world = location.getWorld();
        if (world == null) return RoomCheck.fail("no_world");
        Block start = location.getBlock();
        if (!isAir(start)) return RoomCheck.fail("no_air_above_bed");

        ArrayDeque<Block> queue = new ArrayDeque<>();
        Set<Long> seen = new HashSet<>();
        queue.add(start);
        seen.add(pack(start));
        int visited = 0;
        while (!queue.isEmpty()) {
            Block b = queue.poll();
            visited++;
            if (visited > maxVolume) return RoomCheck.fail("too_large_or_open");
            if (b.getY() >= world.getMaxHeight() - 1 || b.getY() <= world.getMinHeight()) {
                return RoomCheck.fail("open_to_world_border");
            }
            if (hasSkyAccess(world, b)) return RoomCheck.fail("open_to_sky");
            for (BlockFace f : FACES) {
                Block n = b.getRelative(f);
                long key = pack(n);
                if (seen.contains(key)) continue;
                seen.add(key);
                if (isAir(n)) queue.add(n);
            }
        }
        return RoomCheck.ok();
    }

    /** "Air" for the purpose of the fill: anything a player/heat could pass through. */
    static boolean isAir(Block b) {
        Material m = b.getType();
        if (Tag.DOORS.isTagged(m) || Tag.TRAPDOORS.isTagged(m) || Tag.FENCE_GATES.isTagged(m)) return false;
        if (Tag.BEDS.isTagged(m)) return false;
        return b.isPassable() || m.isAir();
    }

    private static boolean hasSkyAccess(World world, Block b) {
        // getHighestBlockYAt ignores non-motion-blocking blocks like torches in recent versions.
        return b.getY() > world.getHighestBlockYAt(b.getX(), b.getZ());
    }

    private static long pack(Block b) {
        return ((long) (b.getX() & 0x3FFFFFF) << 38) | ((long) (b.getZ() & 0x3FFFFFF) << 12) | (b.getY() & 0xFFF);
    }
}
