package io.github.tadzi00.survivorsbridge;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.plugin.Plugin;
import org.bukkit.plugin.RegisteredServiceProvider;

import java.lang.reflect.Method;
import java.util.logging.Logger;

/**
 * Talks to the optional RealisticSeasons plugin purely via reflection on its service interface
 * {@code io.github.tadzi00.realisticseasons.api.RealisticSeasonsAPI} registered in Bukkit's
 * ServicesManager. No compile-time dependency, so this plugin works with or without it.
 */
public final class RealisticSeasonsBridge implements RoomChecker {
    public static final String PLUGIN_NAME = "RealisticSeasons";
    public static final String API_CLASS = "io.github.tadzi00.realisticseasons.api.RealisticSeasonsAPI";

    private final Logger log;
    private Object service;
    private Method isInsideSealedRoom;
    private Method isComfortable;
    private Method getTemperature;
    private Method getSeason;

    private RealisticSeasonsBridge(Logger log) {
        this.log = log;
    }

    /** Returns a bridge when RealisticSeasons is enabled and exposes its API service, else null. */
    public static RealisticSeasonsBridge tryCreate(Logger log) {
        Plugin rs = Bukkit.getPluginManager().getPlugin(PLUGIN_NAME);
        if (rs == null || !rs.isEnabled()) return null;
        try {
            Class<?> api = Class.forName(API_CLASS, true, rs.getClass().getClassLoader());
            RegisteredServiceProvider<?> reg = Bukkit.getServicesManager().getRegistration(api);
            if (reg == null) {
                log.warning("RealisticSeasons is installed but did not register " + API_CLASS);
                return null;
            }
            RealisticSeasonsBridge b = new RealisticSeasonsBridge(log);
            b.service = reg.getProvider();
            b.isInsideSealedRoom = api.getMethod("isInsideSealedRoom", Location.class);
            b.isComfortable = api.getMethod("isComfortable", Location.class);
            b.getTemperature = api.getMethod("getTemperature", Location.class);
            b.getSeason = api.getMethod("getSeason", World.class);
            return b;
        } catch (ReflectiveOperationException | LinkageError e) {
            log.warning("Could not hook RealisticSeasons API (" + e + "); using built-in enclosure check");
            return null;
        }
    }

    @Override
    public String name() {
        return "realisticseasons";
    }

    @Override
    public RoomCheck check(Location location) {
        try {
            boolean sealed = (Boolean) isInsideSealedRoom.invoke(service, location);
            if (!sealed) return RoomCheck.fail("not_sealed");
            boolean comfy = (Boolean) isComfortable.invoke(service, location);
            if (!comfy) return RoomCheck.fail("not_comfortable");
            return RoomCheck.ok();
        } catch (ReflectiveOperationException | RuntimeException e) {
            log.warning("RealisticSeasons room check failed: " + e);
            return RoomCheck.fail("seasons_api_error");
        }
    }

    public Double temperature(Location location) {
        try {
            return (Double) getTemperature.invoke(service, location);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    public String season(World world) {
        try {
            return (String) getSeason.invoke(service, world);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }
}
