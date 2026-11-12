// SpriteCraft's installer. One file that installs SpriteCraft for the current user (no administrator rights) into
// %LOCALAPPDATA%\Programs\SpriteCraft, adds Start menu and desktop shortcuts, and registers in Apps & features with an
// uninstaller. Running it again updates in place. Sprites and settings (in %LOCALAPPDATA%\CraftApps) are never touched.
//
//   spritecraft-setup.exe                 install or update (asks first)
//   ... --uninstall                       remove (asks first); Apps & features runs this
//   ... --quiet                           no questions or messages (for scripts)
//   ... --test-root <dir>                 put everything under <dir> and use a test registry key (for checking a build)
#![windows_subsystem = "windows"]

use std::{env, fs, path::{Path, PathBuf}, process::Command};
use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_YESNO, MESSAGEBOX_STYLE};

static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.bin"));
const APP: &str = "SpriteCraft";
const UNINSTALLER: &str = "Uninstall SpriteCraft.exe";

struct Opts { quiet: bool, test_root: Option<PathBuf> }

/// Where things go: the real places, or all under a test folder.
struct Places { install: PathBuf, start_menu: PathBuf, desktop: PathBuf, reg_key: String }
impl Places {
    fn new(o: &Opts) -> Places {
        match &o.test_root {
            Some(r) => Places { install: r.join("Programs").join(APP), start_menu: r.join("Start Menu"), desktop: r.join("Desktop"), reg_key: format!("Software\\CraftApps\\SetupTest\\{APP}") },
            None => {
                let local = PathBuf::from(env::var_os("LOCALAPPDATA").unwrap_or_default());
                let roaming = PathBuf::from(env::var_os("APPDATA").unwrap_or_default());
                let profile = PathBuf::from(env::var_os("USERPROFILE").unwrap_or_default());
                Places {
                    install: local.join("Programs").join(APP),
                    start_menu: roaming.join("Microsoft\\Windows\\Start Menu\\Programs"),
                    desktop: profile.join("Desktop"),
                    reg_key: format!("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{APP}"),
                }
            }
        }
    }
}

// ---- payload: "SCPK1", then (u16 name length, name, u32 data length, data) per file; "#version" holds the version.

fn files() -> Result<Vec<(String, &'static [u8])>, String> {
    let p = PAYLOAD;
    if p.len() < 5 || &p[..5] != b"SCPK1" { return Err("This installer was built without SpriteCraft inside it.".into()); }
    let mut i = 5;
    let mut out = Vec::new();
    while i < p.len() {
        let take = |i: &mut usize, n: usize| -> Result<&'static [u8], String> {
            if *i + n > p.len() { return Err("The installer is damaged (its contents end early). Download it again.".into()); }
            let s = &p[*i..*i + n]; *i += n; Ok(s)
        };
        let nl = u16::from_le_bytes(take(&mut i, 2)?.try_into().unwrap()) as usize;
        let name = String::from_utf8(take(&mut i, nl)?.to_vec()).map_err(|_| "The installer is damaged (a file name).".to_string())?;
        let dl = u32::from_le_bytes(take(&mut i, 4)?.try_into().unwrap()) as usize;
        let data = take(&mut i, dl)?;
        // Only plain relative paths inside the install folder.
        if name.starts_with('#') || (!name.contains("..") && !name.contains(':') && !name.starts_with('\\') && !name.starts_with('/')) { out.push((name, data)); }
        else { return Err(format!("The installer is damaged (unsafe file name {name}).")); }
    }
    Ok(out)
}

// ---- small Windows helpers

fn message(o: &Opts, text: &str, style: MESSAGEBOX_STYLE) -> bool {
    if o.quiet { return true; }
    unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(format!("{APP} Setup")), style) == IDYES }
}
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }

fn reg_open(key: &str, write: bool) -> Option<HKEY> {
    let mut h = HKEY::default();
    unsafe {
        let r = if write {
            RegCreateKeyExW(HKEY_CURRENT_USER, &HSTRING::from(key), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut h, None)
        } else {
            RegOpenKeyExW(HKEY_CURRENT_USER, &HSTRING::from(key), None, KEY_READ, &mut h)
        };
        if r.is_ok() { Some(h) } else { None }
    }
}
fn reg_set_str(h: HKEY, name: &str, v: &str) {
    let w = wide(v);
    let bytes = unsafe { std::slice::from_raw_parts(w.as_ptr() as *const u8, w.len() * 2) };
    unsafe { let _ = RegSetValueExW(h, &HSTRING::from(name), None, REG_SZ, Some(bytes)); }
}
fn reg_set_dword(h: HKEY, name: &str, v: u32) {
    unsafe { let _ = RegSetValueExW(h, &HSTRING::from(name), None, REG_DWORD, Some(&v.to_le_bytes())); }
}
fn reg_get_str(key: &str, name: &str) -> Option<String> {
    let h = reg_open(key, false)?;
    let mut buf = vec![0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe { RegQueryValueExW(h, &HSTRING::from(name), None, None, Some(buf.as_mut_ptr() as *mut u8), Some(&mut len)).is_ok() };
    unsafe { let _ = RegCloseKey(h); }
    if !ok { return None; }
    let n = (len as usize / 2).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]).trim_end_matches('\0').to_string())
}

fn shortcut(at: &Path, target: &Path, dir: &Path, description: &str) -> Result<(), String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        link.SetPath(&HSTRING::from(target.as_os_str())).map_err(|e| e.to_string())?;
        link.SetWorkingDirectory(&HSTRING::from(dir.as_os_str())).map_err(|e| e.to_string())?;
        link.SetDescription(&HSTRING::from(description)).map_err(|e| e.to_string())?;
        link.SetIconLocation(&HSTRING::from(target.as_os_str()), 0).map_err(|e| e.to_string())?;
        let file: IPersistFile = link.cast().map_err(|e| e.to_string())?;
        if let Some(p) = at.parent() { let _ = fs::create_dir_all(p); }
        file.Save(&HSTRING::from(at.as_os_str()), true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---- install

fn install(o: &Opts) -> Result<(), String> {
    let list = files()?;
    let version = list.iter().find(|(n, _)| n == "#version").map(|(_, d)| String::from_utf8_lossy(d).to_string()).unwrap_or_default();
    let p = Places::new(o);
    let before = reg_get_str(&p.reg_key, "DisplayVersion");
    let ask = match &before {
        Some(v) if *v == version => format!("Reinstall {APP} {version}?\n\nIt's already installed in:\n{}", p.install.display()),
        Some(v) => format!("Update {APP} from {v} to {version}?\n\nIt stays in:\n{}", p.install.display()),
        None => format!("Install {APP} {version} for you?\n\nIt goes in:\n{}\n\nNo administrator rights needed. It adds a Start menu and a desktop shortcut.", p.install.display()),
    };
    if !message(o, &format!("{ask}\n\nYour sprites and settings are kept."), MB_YESNO | MB_ICONQUESTION) { return Ok(()); }

    fs::create_dir_all(&p.install).map_err(|e| format!("Couldn't create {}: {e}", p.install.display()))?;
    let mut bytes = 0u64;
    for (name, data) in list.iter().filter(|(n, _)| !n.starts_with('#')) {
        let dest = p.install.join(name);
        if let Some(d) = dest.parent() { fs::create_dir_all(d).map_err(|e| e.to_string())?; }
        fs::write(&dest, data).map_err(|e| {
            if name.eq_ignore_ascii_case("SpriteCraft.exe") { format!("{APP} is open. Close it, then run setup again.\n\n({e})") } else { format!("Couldn't write {}: {e}", dest.display()) }
        })?;
        bytes += data.len() as u64;
    }
    // This program, kept as the uninstaller.
    let me = env::current_exe().map_err(|e| e.to_string())?;
    let un = p.install.join(UNINSTALLER);
    if me != un { fs::copy(&me, &un).map_err(|e| format!("Couldn't write the uninstaller: {e}"))?; }

    let exe = p.install.join("SpriteCraft.exe");
    unsafe { let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED); }
    let desc = "SpriteCraft: pixel art and sprite animation";
    let mut notes = Vec::new();
    if let Err(e) = shortcut(&p.start_menu.join("SpriteCraft.lnk"), &exe, &p.install, desc) { notes.push(format!("Start menu shortcut: {e}")); }
    if let Err(e) = shortcut(&p.desktop.join("SpriteCraft.lnk"), &exe, &p.install, desc) { notes.push(format!("Desktop shortcut: {e}")); }

    let h = reg_open(&p.reg_key, true).ok_or("Couldn't register SpriteCraft in Apps & features.")?;
    reg_set_str(h, "DisplayName", APP);
    reg_set_str(h, "DisplayVersion", &version);
    reg_set_str(h, "Publisher", "CraftApps");
    reg_set_str(h, "DisplayIcon", &format!("{},0", exe.display()));
    reg_set_str(h, "InstallLocation", &p.install.display().to_string());
    let test = o.test_root.as_ref().map(|r| format!(" --test-root \"{}\"", r.display())).unwrap_or_default();
    reg_set_str(h, "UninstallString", &format!("\"{}\" --uninstall{test}", un.display()));
    reg_set_str(h, "QuietUninstallString", &format!("\"{}\" --uninstall --quiet{test}", un.display()));
    reg_set_dword(h, "NoModify", 1);
    reg_set_dword(h, "NoRepair", 1);
    reg_set_dword(h, "EstimatedSize", ((bytes + me.metadata().map(|m| m.len()).unwrap_or(0)) / 1024) as u32);
    unsafe { let _ = RegCloseKey(h); }

    let extra = if notes.is_empty() { String::new() } else { format!("\n\nNot everything worked:\n{}", notes.join("\n")) };
    if message(o, &format!("{APP} {version} is installed.{extra}\n\nOpen it now?"), MB_YESNO | MB_ICONINFORMATION) && !o.quiet {
        let _ = Command::new(&exe).current_dir(&p.install).spawn();
    }
    Ok(())
}

// ---- uninstall

fn uninstall(o: &Opts, from_temp: bool) -> Result<(), String> {
    let p = Places::new(o);
    let me = env::current_exe().map_err(|e| e.to_string())?;
    // A program can't delete the folder it runs from, so the uninstaller first copies itself to the temp folder and
    // runs from there.
    if !from_temp && me.starts_with(&p.install) {
        if !message(o, &format!("Remove {APP} from this PC?\n\nYour sprites and settings in %LOCALAPPDATA%\\CraftApps are kept."), MB_YESNO | MB_ICONQUESTION) { return Ok(()); }
        let tmp = env::temp_dir().join("SpriteCraft-uninstall.exe");
        fs::copy(&me, &tmp).map_err(|e| e.to_string())?;
        let mut c = Command::new(&tmp);
        c.arg("--uninstall").arg("--from-temp");
        if o.quiet { c.arg("--quiet"); }
        if let Some(r) = &o.test_root { c.arg("--test-root").arg(r); }
        c.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    if !from_temp && !message(o, &format!("Remove {APP} from this PC?\n\nYour sprites and settings in %LOCALAPPDATA%\\CraftApps are kept."), MB_YESNO | MB_ICONQUESTION) { return Ok(()); }
    // Give the copy that started us a moment to exit, then remove everything (retrying while files are released).
    let mut left = Ok(());
    for _ in 0..20 {
        left = if p.install.exists() { fs::remove_dir_all(&p.install) } else { Ok(()) };
        if left.is_ok() { break; }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let _ = fs::remove_file(p.start_menu.join("SpriteCraft.lnk"));
    let _ = fs::remove_file(p.desktop.join("SpriteCraft.lnk"));
    unsafe { let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(p.reg_key.as_str())); }
    match left {
        Ok(()) => { message(o, &format!("{APP} has been removed."), MB_ICONINFORMATION); Ok(()) }
        Err(e) => Err(format!("{APP} was unregistered, but some files are in use: {e}\nClose {APP} and delete {} by hand.", p.install.display())),
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let has = |f: &str| args.iter().any(|a| a == f);
    let test_root = args.iter().position(|a| a == "--test-root").and_then(|i| args.get(i + 1)).map(PathBuf::from);
    let o = Opts { quiet: has("--quiet"), test_root };
    let r = if has("--uninstall") { uninstall(&o, has("--from-temp")) } else { install(&o) };
    if let Err(e) = r {
        if !o.quiet { message(&o, &e, MB_ICONERROR); }
        std::process::exit(1);
    }
}
