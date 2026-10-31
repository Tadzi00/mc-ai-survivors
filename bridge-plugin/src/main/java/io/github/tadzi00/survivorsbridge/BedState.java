package io.github.tadzi00.survivorsbridge;

/** A bed together with its owner (nullable) and current room validity. */
public record BedState(BedPos pos, String owner, RoomCheck room) {
    public String toJson() {
        return Json.obj()
                .put("x", pos.x()).put("y", pos.y()).put("z", pos.z())
                .put("world", pos.world())
                .put("owner", owner)
                .put("valid", room.valid())
                .put("reason", room.reason())
                .toString();
    }
}
