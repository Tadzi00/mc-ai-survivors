package io.github.tadzi00.survivorsbridge;

import java.util.ArrayList;
import java.util.List;

/**
 * Minimal JSON writer. We deliberately avoid depending on Gson/Jackson so the wire format
 * ({@code SB|v1|...}) is fully under our control and unit-testable without a server.
 */
public final class Json {
    private Json() {}

    public static ObjBuilder obj() {
        return new ObjBuilder();
    }

    public static String quote(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    /** Join pre-rendered JSON values into an array. */
    public static String array(List<String> renderedValues) {
        return "[" + String.join(",", renderedValues) + "]";
    }

    public static String stringArray(List<String> values) {
        List<String> out = new ArrayList<>(values.size());
        for (String v : values) out.add(quote(v));
        return array(out);
    }

    public static final class ObjBuilder {
        private final StringBuilder b = new StringBuilder("{");
        private boolean first = true;

        private ObjBuilder key(String k) {
            if (!first) b.append(',');
            first = false;
            b.append(quote(k)).append(':');
            return this;
        }

        public ObjBuilder put(String k, String v) {
            key(k).b.append(quote(v));
            return this;
        }

        public ObjBuilder put(String k, long v) {
            key(k).b.append(v);
            return this;
        }

        public ObjBuilder put(String k, boolean v) {
            key(k).b.append(v);
            return this;
        }

        /** Put an already-rendered JSON value (object, array or {@code null}). */
        public ObjBuilder raw(String k, String renderedJson) {
            key(k).b.append(renderedJson == null ? "null" : renderedJson);
            return this;
        }

        @Override
        public String toString() {
            return b + "}";
        }
    }
}
