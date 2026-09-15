import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadLocale, saveLocale, type Locale } from "./uiPrefs";

export type { Locale };

const en = {
  "titlebar.agentSettings": "Agent Settings…",
  "titlebar.apiKeys": "API Keys…",
  "titlebar.lightMode": "Switch to light mode",
  "titlebar.darkMode": "Switch to dark mode",
  "titlebar.language": "Language / ภาษา",

  "statusbar.toggleSidebar": "Toggle sidebar",
  "statusbar.toggleChat": "Toggle chat panel",
  "statusbar.sidebarShown": "▪ Sidebar",
  "statusbar.sidebarHidden": "▸ Sidebar",
  "statusbar.chatShown": "Chat ▪",
  "statusbar.chatHidden": "Chat ◂",
  "statusbar.budgetTooltip": "Budget monitor — total spend across every folder and chat",

  "sidebar.explorer": "Explorer",
  "sidebar.explorerNamed": "Explorer — {name}",
  "sidebar.newFile": "New File…",
  "sidebar.refresh": "Refresh",
  "sidebar.openFolder": "Open Folder…",
  "sidebar.emptyHint": "Open a folder to start editing — DevTop Flow can only create/edit files inside a folder you've opened.",
  "sidebar.filenamePlaceholder": "filename.ext",
  "sidebar.unsavedChanges": "Unsaved changes",
  "sidebar.revealInExplorer": "Reveal in File Explorer",

  "chat.historyTitle": "Chat history",
  "chat.historySingle": "History",
  "chat.historyMulti": "{n} chats",
  "chat.sessionCostTooltip": "Total for this chat (USD / THB)",
  "chat.newChat": "＋ New",
  "chat.newChatTitle": "New chat (keeps this one in history)",
  "chat.stop": "⏹ Stop",
  "chat.stopTitle": "Force-stop everything the agent is doing right now — click here, type @stop, press Esc, or ⌘C anywhere in the app",
  "chat.resumeAnyway": "🔁 Resume anyway",
  "chat.removeAttachment": "Remove attachment",
  "chat.overContextLimitTooltip": "Over the context window limit set in Agent Settings",
  "chat.modelTooltip": "Model",
  "chat.noModelConfigured": "No model configured",
  "chat.placeholderSending": "Type @stop, press Esc, or ⌘C to force-stop the agent…",
  "chat.placeholderIdle": "Ask DevTop Flow to explain, refactor, or scaffold something… (⌘V to paste an image, ↑ to recall previous messages)",
  "chat.attach": "📎 Attach",
  "chat.attachTitle": "Attach a file to this message",
  "chat.attachActiveFile": "📄 Active file / selection",
  "chat.attachBrowse": "📂 Browse for files…",
  "chat.see": "👁 @see",
  "chat.seeTitle": "Verify exactly what the agent can currently see",
  "chat.seeEmptyNoFolder": "No folder is open — the agent can't see any files right now.",
  "chat.seeLoading": "Reading…",
  "chat.seeEmptyFolder": "(empty folder)",
  "chat.deleteChatTitle": "Delete this chat",
  "chat.overContextLimit": "⚠ Over context limit ({limit} tokens)",
  "chat.estTokens": "Est. ~{n} input tokens",
  "chat.copy": "Copy",

  "phase.idle": "",
  "phase.parsing": "PARSING CONTEXT",
  "phase.waiting": "SYNCHRONIZING",
  "phase.streaming": "PROCESSING",
  "phase.applying": "APPLYING CHANGES",
  "phase.finalizing": "FINALIZING",
  "phase.stalled": "⚠ NO RESPONSE — STALLED",

  "directive.file": "Writing",
  "directive.read": "Reading",
  "directive.image": "Generating",
  "directive.draw": "Drawing",
  "directive.fallback": "Working on",

  "editor.openHint": "Open a file from the Explorer to start editing.",
  "editor.unsavedChanges": "Unsaved changes",
  "editor.close": "Close",
  "editor.hidePreview": "🖥 Hide preview",
  "editor.showPreview": "🖥 Preview",
  "editor.expandPreview": "⛶ Expand preview",
  "editor.showCode": "⛶ Show code",
  "editor.hideTabs": "▴ Hide tabs",
  "editor.showTabs": "▾ Tabs",
  "editor.togglePreviewTitle": "Toggle preview",
  "editor.expandPreviewTitle": "Expand preview, hiding the code",
  "editor.tabsTitle": "Hide tabs",
  "editor.tabsShowTitle": "Show tabs",

  "settings.title": "API Keys",
  "settings.hint": "Stored in the OS Keychain / Credential Manager — never written to a config file. Cloud models are the primary path; local Ollama models need no key.",
  "settings.pastePlaceholder": "Paste API key…",
  "settings.savedPlaceholder": "•••••••••• (saved — enter a new key to replace)",
  "settings.save": "Save",
  "settings.clear": "Clear",
  "settings.signIn": "Don't have a key? Sign in with Google or email →",
  "settings.ollama": "Ollama (local)",
  "settings.ollamaChecking": "Checking…",
  "settings.ollamaRunning": "Running at {url}",
  "settings.ollamaNotReachable": "Not reachable at {url}",
  "settings.changeHost": "Change host",
  "settings.selectModel": "Select a pulled model…",
  "settings.ollamaNotRunning": "Ollama not running",
  "settings.noModelsPulled": "No models pulled yet",
  "settings.refreshTitle": "Re-scan Ollama for pulled models",
  "settings.modelNamePlaceholder": "Model Name — e.g. llama3.2",
  "settings.manualOn": "← Choose from detected models instead",
  "settings.manualOff": "Model not listed? Type its name manually",

  "privacy.title": "🔒 Privacy — folder access",
  "privacy.noFolder": "No folder is currently open — nothing on disk is accessible right now.",
  "privacy.currentlyOpen": "Currently open:",
  "privacy.point1": "DevTop Flow only reads files inside the folder you explicitly opened — never anywhere else on disk.",
  "privacy.point2": "File contents are sent to an AI model only when: you attach a file, or the assistant asks to read a specific file and you can see that request happen live in the chat (never silent).",
  "privacy.point3": "The assistant always sees the folder's file names (a tree) so it knows what exists — use 👁 @see in the chat panel to verify exactly what that looks like, any time.",
  "privacy.point4": "Sent content goes only to the AI provider you've configured (Anthropic, OpenAI, DeepSeek, or a local Ollama server) — never anywhere else.",
  "privacy.point5": "API keys live in the OS Keychain / Credential Manager, never in plaintext config.",
  "privacy.point6": "Chat history is saved to a .devtopflow/ folder inside the project itself — nothing is uploaded except what's explicitly sent to the model.",
  "privacy.footer": "Open this notice any time with ⌘⇧P, or close/reopen the folder to revoke and re-grant access.",
} as const;

export type TranslationKey = keyof typeof en;

const th: Record<TranslationKey, string> = {
  "titlebar.agentSettings": "ตั้งค่าเอเจนต์…",
  "titlebar.apiKeys": "API Keys…",
  "titlebar.lightMode": "สลับเป็นโหมดสว่าง",
  "titlebar.darkMode": "สลับเป็นโหมดมืด",
  "titlebar.language": "ภาษา / Language",

  "statusbar.toggleSidebar": "ซ่อน/แสดงแถบด้านข้าง",
  "statusbar.toggleChat": "ซ่อน/แสดงแชท",
  "statusbar.sidebarShown": "▪ แถบข้าง",
  "statusbar.sidebarHidden": "▸ แถบข้าง",
  "statusbar.chatShown": "แชท ▪",
  "statusbar.chatHidden": "แชท ◂",
  "statusbar.budgetTooltip": "ตัวติดตามงบประมาณ — ยอดใช้จ่ายรวมของทุกโฟลเดอร์และทุกแชท",

  "sidebar.explorer": "เอ็กซ์พลอเรอร์",
  "sidebar.explorerNamed": "เอ็กซ์พลอเรอร์ — {name}",
  "sidebar.newFile": "สร้างไฟล์ใหม่…",
  "sidebar.refresh": "รีเฟรช",
  "sidebar.openFolder": "เปิดโฟลเดอร์…",
  "sidebar.emptyHint": "เปิดโฟลเดอร์เพื่อเริ่มแก้ไข — DevTop Flow สร้าง/แก้ไขไฟล์ได้เฉพาะในโฟลเดอร์ที่คุณเปิดไว้เท่านั้น",
  "sidebar.filenamePlaceholder": "ชื่อไฟล์.นามสกุล",
  "sidebar.unsavedChanges": "มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก",
  "sidebar.revealInExplorer": "เปิดตำแหน่งไฟล์ใน File Explorer",

  "chat.historyTitle": "ประวัติแชท",
  "chat.historySingle": "ประวัติ",
  "chat.historyMulti": "{n} แชท",
  "chat.sessionCostTooltip": "ยอดรวมของแชทนี้ (USD / THB)",
  "chat.newChat": "＋ ใหม่",
  "chat.newChatTitle": "แชทใหม่ (แชทเดิมยังอยู่ในประวัติ)",
  "chat.stop": "⏹ หยุด",
  "chat.stopTitle": "หยุดสิ่งที่เอเจนต์กำลังทำอยู่ทันที — คลิกที่นี่, พิมพ์ @stop, กด Esc หรือ ⌘C ที่ไหนก็ได้ในแอป",
  "chat.resumeAnyway": "🔁 ทำต่อเลย",
  "chat.removeAttachment": "ลบไฟล์แนบ",
  "chat.overContextLimitTooltip": "เกินขีดจำกัดบริบทที่ตั้งไว้ใน Agent Settings",
  "chat.modelTooltip": "โมเดล",
  "chat.noModelConfigured": "ยังไม่ได้ตั้งค่าโมเดล",
  "chat.placeholderSending": "พิมพ์ @stop, กด Esc หรือ ⌘C เพื่อบังคับหยุดเอเจนต์…",
  "chat.placeholderIdle": "ให้ DevTop Flow อธิบาย, ปรับปรุงโค้ด หรือสร้างโปรเจกต์… (⌘V เพื่อวางรูปภาพ, ↑ เพื่อเรียกข้อความก่อนหน้า)",
  "chat.attach": "📎 แนบไฟล์",
  "chat.attachTitle": "แนบไฟล์ไปกับข้อความนี้",
  "chat.attachActiveFile": "📄 ไฟล์ที่เปิดอยู่ / ข้อความที่เลือก",
  "chat.attachBrowse": "📂 เรียกดูไฟล์…",
  "chat.see": "👁 @see",
  "chat.seeTitle": "ตรวจสอบว่าตอนนี้เอเจนต์มองเห็นอะไรบ้าง",
  "chat.seeEmptyNoFolder": "ยังไม่ได้เปิดโฟลเดอร์ — ตอนนี้เอเจนต์มองไม่เห็นไฟล์ใดๆ",
  "chat.seeLoading": "กำลังอ่าน…",
  "chat.seeEmptyFolder": "(โฟลเดอร์ว่าง)",
  "chat.deleteChatTitle": "ลบแชทนี้",
  "chat.overContextLimit": "⚠ เกินขีดจำกัดบริบท ({limit} โทเคน)",
  "chat.estTokens": "ประมาณ ~{n} โทเคนอินพุต",
  "chat.copy": "คัดลอก",

  "phase.idle": "",
  "phase.parsing": "กำลังวิเคราะห์บริบท",
  "phase.waiting": "กำลังซิงค์ข้อมูล",
  "phase.streaming": "กำลังประมวลผล",
  "phase.applying": "กำลังนำการเปลี่ยนแปลงไปใช้",
  "phase.finalizing": "กำลังสรุปผล",
  "phase.stalled": "⚠ ไม่มีการตอบสนอง — ค้าง",

  "directive.file": "กำลังเขียน",
  "directive.read": "กำลังอ่าน",
  "directive.image": "กำลังสร้างรูป",
  "directive.draw": "กำลังวาด",
  "directive.fallback": "กำลังดำเนินการ",

  "editor.openHint": "เปิดไฟล์จากเอ็กซ์พลอเรอร์เพื่อเริ่มแก้ไข",
  "editor.unsavedChanges": "มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก",
  "editor.close": "ปิด",
  "editor.hidePreview": "🖥 ซ่อนตัวอย่าง",
  "editor.showPreview": "🖥 แสดงตัวอย่าง",
  "editor.expandPreview": "⛶ ขยายตัวอย่าง",
  "editor.showCode": "⛶ แสดงโค้ด",
  "editor.hideTabs": "▴ ซ่อนแท็บ",
  "editor.showTabs": "▾ แท็บ",
  "editor.togglePreviewTitle": "ซ่อน/แสดงตัวอย่าง",
  "editor.expandPreviewTitle": "ขยายตัวอย่างและซ่อนโค้ด",
  "editor.tabsTitle": "ซ่อนแท็บ",
  "editor.tabsShowTitle": "แสดงแท็บ",

  "settings.title": "API Keys",
  "settings.hint": "เก็บไว้ใน OS Keychain / Credential Manager — ไม่เขียนลงไฟล์ตั้งค่าเด็ดขาด โมเดลบนคลาวด์เป็นทางหลัก ส่วนโมเดล Ollama ในเครื่องไม่ต้องใช้คีย์",
  "settings.pastePlaceholder": "วาง API key…",
  "settings.savedPlaceholder": "•••••••••• (บันทึกแล้ว — ใส่คีย์ใหม่เพื่อแทนที่)",
  "settings.save": "บันทึก",
  "settings.clear": "ล้าง",
  "settings.signIn": "ยังไม่มีคีย์ใช่ไหม? เข้าสู่ระบบด้วย Google หรืออีเมล →",
  "settings.ollama": "Ollama (ในเครื่อง)",
  "settings.ollamaChecking": "กำลังตรวจสอบ…",
  "settings.ollamaRunning": "ทำงานอยู่ที่ {url}",
  "settings.ollamaNotReachable": "เชื่อมต่อไม่ได้ที่ {url}",
  "settings.changeHost": "เปลี่ยนโฮสต์",
  "settings.selectModel": "เลือกโมเดลที่ดึงมาแล้ว…",
  "settings.ollamaNotRunning": "Ollama ไม่ได้ทำงานอยู่",
  "settings.noModelsPulled": "ยังไม่มีโมเดลที่ดึงมา",
  "settings.refreshTitle": "สแกน Ollama ใหม่เพื่อหาโมเดลที่ดึงมาแล้ว",
  "settings.modelNamePlaceholder": "ชื่อโมเดล — เช่น llama3.2",
  "settings.manualOn": "← เลือกจากโมเดลที่ตรวจพบแทน",
  "settings.manualOff": "ไม่เห็นโมเดลที่ต้องการ? พิมพ์ชื่อเอง",

  "privacy.title": "🔒 ความเป็นส่วนตัว — การเข้าถึงโฟลเดอร์",
  "privacy.noFolder": "ยังไม่ได้เปิดโฟลเดอร์ใดๆ — ตอนนี้ไม่มีการเข้าถึงไฟล์บนดิสก์เลย",
  "privacy.currentlyOpen": "กำลังเปิดอยู่:",
  "privacy.point1": "DevTop Flow อ่านไฟล์เฉพาะภายในโฟลเดอร์ที่คุณเปิดไว้เท่านั้น — ไม่แตะที่อื่นบนดิสก์เด็ดขาด",
  "privacy.point2": "เนื้อหาไฟล์จะถูกส่งให้โมเดล AI ก็ต่อเมื่อ: คุณแนบไฟล์เอง หรือผู้ช่วยขอเปิดอ่านไฟล์ที่ระบุ ซึ่งคุณจะเห็นคำขอนั้นแบบสดในแชท (ไม่มีการแอบทำ)",
  "privacy.point3": "ผู้ช่วยจะเห็น \"ชื่อ\" ไฟล์ทั้งหมดในโฟลเดอร์เสมอ (โครงสร้างต้นไม้) เพื่อให้รู้ว่ามีอะไรอยู่บ้าง — กด 👁 @see ในแชทเพื่อตรวจสอบได้ทุกเมื่อ",
  "privacy.point4": "เนื้อหาที่ส่งไปจะไปถึงเฉพาะผู้ให้บริการ AI ที่คุณตั้งค่าไว้ (Anthropic, OpenAI, DeepSeek หรือเซิร์ฟเวอร์ Ollama ในเครื่อง) เท่านั้น — ไม่ไปที่อื่น",
  "privacy.point5": "API key เก็บอยู่ใน OS Keychain / Credential Manager ไม่เก็บเป็นข้อความธรรมดาในไฟล์ตั้งค่า",
  "privacy.point6": "ประวัติแชทถูกบันทึกไว้ในโฟลเดอร์ .devtopflow/ ภายในโปรเจกต์เอง — ไม่มีการอัปโหลดใดๆ นอกจากสิ่งที่ส่งให้โมเดลโดยตรง",
  "privacy.footer": "เปิดข้อความนี้ได้ทุกเมื่อด้วย ⌘⇧P หรือปิด/เปิดโฟลเดอร์ใหม่เพื่อเพิกถอนและให้สิทธิ์อีกครั้ง",
};

const dictionaries: Record<Locale, Record<TranslationKey, string>> = { en, th };

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined);

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => loadLocale());

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    saveLocale(next);
  };

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => interpolate(dictionaries[locale][key] ?? dictionaries.en[key], vars),
    }),
    [locale]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}
