// DevTop Flow — native macOS shell entry point.
// Handles window creation and exposes secure commands to the frontend
// (e.g. storing/retrieving API keys from the macOS Keychain instead of plaintext config).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use keyring::Entry;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const SERVICE: &str = "com.devtopflow.app";

#[tauri::command]
fn save_api_key(provider: String, key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_api_key(provider: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn delete_api_key(provider: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE, &provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Integrated terminal (VS Code-style, hideable panel). A real PTY — not just
// a spawned process with captured stdout — so interactive programs, color
// codes, cursor movement, and `cd` all behave normally. ConPTY on Windows via
// `portable-pty` needs no visible console window even though this binary is
// built with the GUI subsystem.
struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct TerminalState {
    sessions: Mutex<HashMap<u32, PtySession>>,
}

static NEXT_TERMINAL_ID: AtomicU32 = AtomicU32::new(1);

#[tauri::command]
fn terminal_start(app: AppHandle, state: State<TerminalState>, cwd: String) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = if cfg!(windows) { "powershell.exe" } else { "/bin/bash" };
    let mut cmd = CommandBuilder::new(shell);
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = NEXT_TERMINAL_ID.fetch_add(1, Ordering::SeqCst);
    let output_event = format!("terminal-output-{id}");
    let closed_event = format!("terminal-closed-{id}");

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if app.emit(&output_event, data).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(&closed_event, ());
    });

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, PtySession { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
fn terminal_write(state: State<TerminalState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("no such terminal session")?;
    session.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_resize(state: State<TerminalState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such terminal session")?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn terminal_kill(state: State<TerminalState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            save_api_key,
            get_api_key,
            delete_api_key,
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevTop Flow");
}
