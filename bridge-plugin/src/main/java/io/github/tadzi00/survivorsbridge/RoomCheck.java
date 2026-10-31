package io.github.tadzi00.survivorsbridge;

/** Result of checking whether the room around a bed is a valid shelter. */
public record RoomCheck(boolean valid, String reason) {
    public static RoomCheck ok() {
        return new RoomCheck(true, "ok");
    }

    public static RoomCheck fail(String reason) {
        return new RoomCheck(false, reason);
    }
}
