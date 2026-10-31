package io.github.tadzi00.survivorsbridge;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class SpawnRuleTest {
    private static BedState bed(int x, String owner, boolean valid) {
        return new BedState(new BedPos("world", x, 64, 0), owner,
                valid ? RoomCheck.ok() : RoomCheck.fail("not_sealed"));
    }

    @Test
    void allBotsHaveBedsAndOneSpare() {
        var r = SpawnRule.evaluate(List.of(bed(1, "Surv_01", true), bed(2, null, true)), List.of("surv_01"));
        assertTrue(r.canSpawn());
        assertEquals(2, r.freeValidBed().x());
        assertEquals("ok", r.reason());
        assertEquals("{\"canSpawn\":true,\"freeValidBed\":{\"x\":2,\"y\":64,\"z\":0,\"world\":\"world\"},\"missing\":[],\"reason\":\"ok\"}", r.toJson());
    }

    @Test
    void missingBedBlocks() {
        var r = SpawnRule.evaluate(List.of(bed(1, "A", true), bed(2, null, true)), List.of("A", "B"));
        assertFalse(r.canSpawn());
        assertEquals(List.of("B"), r.missing());
        assertEquals("bots_without_valid_bed", r.reason());
    }

    @Test
    void invalidOwnedBedCountsAsMissing() {
        var r = SpawnRule.evaluate(List.of(bed(1, "A", false), bed(2, null, true)), List.of("A"));
        assertFalse(r.canSpawn());
        assertEquals(List.of("A"), r.missing());
    }

    @Test
    void noSpareBed() {
        var r = SpawnRule.evaluate(List.of(bed(1, "A", true), bed(2, null, false)), List.of("A"));
        assertFalse(r.canSpawn());
        assertNull(r.freeValidBed());
        assertEquals("no_free_valid_bed", r.reason());
    }

    @Test
    void jsonEscaping() {
        assertEquals("\"a\\\"b\\\\c\\n\"", Json.quote("a\"b\\c\n"));
        assertEquals("null", Json.quote(null));
    }
}
