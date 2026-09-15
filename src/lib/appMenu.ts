import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";

// Native macOS menu bar (build plan §3/§9 — a "real Mac app" should have
// one, not just in-window buttons).

export interface AppMenuActions {
  onOpenFolder: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onTogglePrivacy: () => void;
}

export async function buildAppMenu(actions: AppMenuActions): Promise<void> {
  const homeMenu = await Submenu.new({
    text: "Home",
    items: [
      await MenuItem.new({ text: "Open Folder…", accelerator: "CmdOrCtrl+O", action: actions.onOpenFolder }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Save", accelerator: "CmdOrCtrl+S", action: actions.onSave }),
      await MenuItem.new({ text: "Save As…", accelerator: "CmdOrCtrl+Shift+S", action: actions.onSaveAs }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Privacy…", accelerator: "CmdOrCtrl+Shift+P", action: actions.onTogglePrivacy }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      // macOS substitutes "Quit DevTop Flow" for the app's real name and
      // wires up Cmd+Q + real app termination automatically.
      await PredefinedMenuItem.new({ item: "Quit", text: "Exit" }),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Maximize" }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await PredefinedMenuItem.new({ item: "CloseWindow" }),
    ],
  });

  const menu = await Menu.new({ items: [homeMenu, editMenu, windowMenu] });
  await menu.setAsAppMenu();
}
