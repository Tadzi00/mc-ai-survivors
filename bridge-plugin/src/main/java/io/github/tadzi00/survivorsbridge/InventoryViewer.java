package io.github.tadzi00.survivorsbridge;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;
import org.bukkit.inventory.meta.ItemMeta;

/**
 * /survivors inv <player>: a READ-ONLY snapshot of a player's (bot's) inventory in a 6-row chest window.
 * Rows 1-3: main inventory, row 4: hotbar, row 6: armor + offhand. Clicks and drags are cancelled, so
 * spectators can't take or add items. It is a snapshot: reopen to refresh.
 */
public final class InventoryViewer implements Listener {

    /** Marks our windows so the click guard only applies to them. */
    private static final class Holder implements InventoryHolder {
        private Inventory inventory;

        @Override
        public Inventory getInventory() {
            return inventory;
        }
    }

    public void open(Player viewer, Player target) {
        Holder holder = new Holder();
        Inventory view = Bukkit.createInventory(holder, 54,
                Component.text(target.getName() + " (read-only)", NamedTextColor.DARK_GRAY));
        holder.inventory = view;
        PlayerInventory inv = target.getInventory();
        ItemStack[] storage = inv.getStorageContents(); // 0-8 hotbar, 9-35 main
        for (int i = 9; i < 36 && i < storage.length; i++) view.setItem(i - 9, copy(storage[i]));
        for (int i = 0; i < 9 && i < storage.length; i++) view.setItem(27 + i, copy(storage[i]));
        ItemStack filler = label(Material.GRAY_STAINED_GLASS_PANE, " ");
        for (int i = 36; i < 45; i++) view.setItem(i, filler);
        view.setItem(45, labelled(inv.getHelmet(), "Helmet"));
        view.setItem(46, labelled(inv.getChestplate(), "Chestplate"));
        view.setItem(47, labelled(inv.getLeggings(), "Leggings"));
        view.setItem(48, labelled(inv.getBoots(), "Boots"));
        view.setItem(50, labelled(inv.getItemInOffHand(), "Offhand"));
        view.setItem(52, label(Material.PAPER, "Health " + Math.round(target.getHealth()) + "/20, food "
                + target.getFoodLevel() + "/20"));
        view.setItem(53, label(Material.COMPASS, "Pos " + target.getLocation().getBlockX() + " "
                + target.getLocation().getBlockY() + " " + target.getLocation().getBlockZ()));
        viewer.openInventory(view);
    }

    private static ItemStack copy(ItemStack i) {
        return i == null ? null : i.clone();
    }

    private static ItemStack labelled(ItemStack i, String emptyName) {
        if (i != null && i.getType() != Material.AIR) return i.clone();
        return label(Material.LIGHT_GRAY_STAINED_GLASS_PANE, "No " + emptyName.toLowerCase());
    }

    private static ItemStack label(Material m, String text) {
        ItemStack it = new ItemStack(m);
        ItemMeta meta = it.getItemMeta();
        meta.displayName(Component.text(text, NamedTextColor.GRAY));
        it.setItemMeta(meta);
        return it;
    }

    @EventHandler(ignoreCancelled = true)
    public void onClick(InventoryClickEvent e) {
        if (e.getView().getTopInventory().getHolder() instanceof Holder) e.setCancelled(true);
    }

    @EventHandler(ignoreCancelled = true)
    public void onDrag(InventoryDragEvent e) {
        if (e.getView().getTopInventory().getHolder() instanceof Holder) e.setCancelled(true);
    }
}
