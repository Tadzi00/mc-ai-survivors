package io.github.tadzi00.survivorsbridge;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * The population-growth rule. STABLE semantics (see DESIGN.md):
 *
 * <pre>
 * canSpawn = every living bot owns a bed that is valid
 *            AND there is at least one additional valid bed with no owner.
 * </pre>
 *
 * Owner name matching is case-insensitive (Minecraft names are). The free bed returned is the
 * first unowned valid bed in a deterministic order (world, x, y, z).
 */
public final class SpawnRule {
    private SpawnRule() {}

    public record Result(boolean canSpawn, BedPos freeValidBed, List<String> missing, String reason) {
        public String toJson() {
            return Json.obj()
                    .put("canSpawn", canSpawn)
                    .raw("freeValidBed", freeValidBed == null ? null : freeValidBed.toJson())
                    .raw("missing", Json.stringArray(missing))
                    .put("reason", reason)
                    .toString();
        }
    }

    public static Result evaluate(List<BedState> beds, List<String> livingBots) {
        List<BedState> sorted = new ArrayList<>(beds);
        sorted.sort(Comparator.comparing((BedState b) -> b.pos().world())
                .thenComparingInt(b -> b.pos().x())
                .thenComparingInt(b -> b.pos().y())
                .thenComparingInt(b -> b.pos().z()));

        List<String> missing = new ArrayList<>();
        for (String bot : livingBots) {
            String lc = bot.toLowerCase(Locale.ROOT);
            boolean has = false;
            for (BedState b : sorted) {
                if (b.owner() != null && b.owner().toLowerCase(Locale.ROOT).equals(lc) && b.room().valid()) {
                    has = true;
                    break;
                }
            }
            if (!has) missing.add(bot);
        }

        BedPos free = null;
        for (BedState b : sorted) {
            if (b.owner() == null && b.room().valid()) {
                free = b.pos();
                break;
            }
        }

        String reason;
        if (!missing.isEmpty()) {
            reason = "bots_without_valid_bed";
        } else if (free == null) {
            reason = "no_free_valid_bed";
        } else {
            reason = "ok";
        }
        return new Result(missing.isEmpty() && free != null, free, missing, reason);
    }
}
