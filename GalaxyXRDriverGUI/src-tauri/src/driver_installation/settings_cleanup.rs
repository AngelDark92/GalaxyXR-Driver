//! Explicit, backed-up reset of Companion-owned settings; never an uninstall.
//! Registration, installed packages, bindings, room setup and named profiles
//! are not reset. Unknown SteamVR values never become a guessed factory value.
use super::*;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CleanSettingsReport {
    backup_path: String,
    reset_files: Vec<String>,
    restored_settings: usize,
    removed_identity_keys: Vec<String>,
    removed_identity_sections: Vec<String>,
    steamvr_cleaned: bool,
    warnings: Vec<String>,
}

struct FileChange { path: PathBuf, before: Option<Vec<u8>>, after: Option<Vec<u8>> }
impl FileChange {
    fn new(path: PathBuf, after: Option<Vec<u8>>) -> Result<Self> {
        safe_chain(&path)?;
        let before = snapshot_file(&path)?;
        Ok(Self { path, before, after })
    }
}
fn lifecycle_key(section: &str, key: &str) -> bool {
    section.starts_with("driver_") && ["enable", "blocked_by_safe_mode", "hasBeenRun"].contains(&key)
}

/// Only recorded writes are reversible. Keep installation/safe-mode entries
/// in the recovery journal so a later uninstall still restores them correctly.
fn reset_owned_steamvr(settings: &mut Value, journal: Option<&Value>, config: &Value)
    -> Result<(Option<Value>, usize, IdentityCleanupReport)> {
    let mut identity = IdentityCleanupReport { removed_keys: vec![], removed_sections: vec![], warnings: vec![], backup_path: None };
    let mut reset_count = 0;
    let mut retained = journal.cloned();
    let mut protected = json!({"entries":{},"sectionPresence":{},"legacyKeys":{}});
    if let Some(journal) = journal {
        let mut reversible = journal.clone();
        for (section, keys) in reversible["entries"].as_object_mut().ok_or("Invalid journal entries")? {
            keys.as_object_mut().ok_or("Invalid journal section")?.retain(|key, _| !lifecycle_key(section, key));
        }
        // Every recorded key is protected from the old-identity pass. That
        // pass must never delete either an external edit OR a pre-install
        // value that the journal has just correctly restored.
        protected["entries"] = journal["entries"].clone();
        reset_count += restore_settings(settings, &reversible, &mut identity.warnings)?;
        if let Some(keep) = &mut retained {
            for (section, keys) in keep["entries"].as_object_mut().unwrap() {
                keys.as_object_mut().unwrap().retain(|key, _| lifecycle_key(section, key));
            }
            keep["entries"].as_object_mut().unwrap().retain(|_, keys| !keys.as_object().unwrap().is_empty());
            let sections: BTreeSet<String> = keep["entries"].as_object().unwrap().keys().cloned().collect();
            if let Some(presence) = keep.get_mut("sectionPresence").and_then(Value::as_object_mut) { presence.retain(|section, _| sections.contains(section)); }
            if let Some(legacy) = keep.get_mut("legacyKeys").and_then(Value::as_object_mut) {
                for (section, keys) in legacy.iter_mut() { keys.as_object_mut().unwrap().retain(|key, _| lifecycle_key(section, key)); }
                legacy.retain(|_, keys| !keys.as_object().unwrap().is_empty());
            }
            // Do not perform broad legacy deletion during a later uninstall.
            keep["legacy"] = json!(false);
        }
    } else {
        identity.warnings.push("No ownership journal was found. Recognized old Galaxy XR identity values and exact saved custom overrides are cleaned; other historical SteamVR values are preserved because their owner cannot be proved.".into());
    }
    // Extra-key JSON is user-configurable. Remove an older unjournaled value
    // only when it exactly matches the value stored by this app, and never
    // undo a recorded pre-install value that the journal just restored.
    if let Some(extra) = config["galaxyXr"]["vrlinkExtraKeys"].as_object() {
        for section in std::iter::once("driver_vrlink").chain(COMPANION_PROFILE_SECTIONS.iter().copied()) {
            for (key, raw) in extra {
                if lifecycle_key(section, key) || journal.and_then(|j| j["entries"].get(section)).and_then(|s| s.get(key)).is_some() { continue; }
                let expected = if raw.is_boolean() || raw.is_number() { Some(raw.clone()) }
                    else if let Some(v) = raw.get("i").and_then(Value::as_i64) { Some(json!(v)) }
                    else if let Some(v) = raw.get("f").and_then(Value::as_f64) { Some(json!(v as f32)) }
                    else { raw.get("b").and_then(Value::as_bool).map(|v| json!(v)) };
                if expected.is_some() && setting_equal(settings.get(section).and_then(|s| s.get(key)), expected.as_ref()) {
                    set_value(settings, section, key, None)?;
                    reset_count += 1;
                }
            }
        }
    }
    let old_warnings = identity.warnings.len();
    plan_identity_cleanup(settings, Some(&protected), &mut identity)?;
    for warning in &mut identity.warnings[old_warnings..] {
        *warning = warning.replace("tracked by the current installation journal; uninstall the driver first", "the recovery record protects its pre-existing or externally edited value");
    }
    Ok((retained, reset_count, identity))
}

/// All originals are copied before the first replacement. Optimistic checks
/// catch an external editor that did not respect the native-driver mutex.
fn commit_clean(data: &Path, changes: Vec<FileChange>) -> Result<String> {
    commit_clean_with(data, changes, restore_file)
}
fn commit_clean_with<F>(data: &Path, changes: Vec<FileChange>, mut write_file: F) -> Result<String>
where F: FnMut(&Path, &Option<Vec<u8>>) -> Result<()> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let backup = data.parent().ok_or("Settings directory has no parent")?.join("Backups")
        .join(format!("clean-settings-{stamp}-{}", std::process::id()));
    safe_chain(&backup)?;
    fs::create_dir_all(&backup).map_err(|e| error(&backup, e))?;
    let mut manifest = vec![];
    for (index, change) in changes.iter().enumerate() {
        let name = format!("{index:02}-{}.before", change.path.file_name().unwrap_or_default().to_string_lossy());
        if let Some(bytes) = &change.before { atomic_bytes(&backup.join(&name), bytes)?; }
        manifest.push(json!({"path":change.path,"originallyPresent":change.before.is_some(),"backupFile":name}));
    }
    atomic_json(&backup.join("manifest.json"), &json!({"schema":1,"operation":"Clean Settings","files":manifest}))?;
    let mut committed: Vec<usize> = vec![];
    let transaction = (|| {
        for change in &changes {
            if snapshot_file(&change.path)? != change.before { return Err(error(&change.path, "File changed during cleanup; nothing was reset. Retry after closing other editors.")); }
        }
        for (index, change) in changes.iter().enumerate() {
            if change.before == change.after { continue; }
            if snapshot_file(&change.path)? != change.before { return Err(error(&change.path, "File changed during cleanup")); }
            write_file(&change.path, &change.after)?;
            committed.push(index);
        }
        Ok(())
    })();
    if let Err(e) = transaction {
        let mut errors = vec![e];
        for index in committed.into_iter().rev() {
            let change = &changes[index];
            match snapshot_file(&change.path) {
                Ok(current) if current == change.after => {
                    if let Err(e) = restore_file(&change.path, &change.before) { errors.push(format!("Rollback failed: {e}")); }
                }
                Ok(_) => errors.push(format!("Preserved an external edit during rollback: {}", change.path.display())),
                Err(e) => errors.push(format!("Cannot check rollback target: {e}")),
            }
        }
        return Err(format!("{}. Recovery backup: {}", errors.join("; "), backup.display()));
    }
    Ok(backup.to_string_lossy().into_owned())
}

fn clean_driver_config() -> Value {
    // 2026-09-26: an empty object would enable the installation's NVENC
    // defaults again. Persist stock passthrough, including the migration
    // version, so neither the driver nor the GUI revives encoder overrides.
    json!({"streamFrame":{
        "nvencSettingsVersion":4, "nvencTap":false, "nvencFixLevel":false,
        "nvencForceCbr":false, "nvencBitrateScale":false, "nvencPresetMerge":false,
        "nvencVbvFrames":0, "nvencLowDelayKfScale":0, "nvencForceFps":0,
        "nvencSplitMode":0, "postPack":{"enable":false,"casEnable":false}
    }})
}

fn clean_settings_at(data: &Path, ctx: Option<&Context>) -> Result<CleanSettingsReport> {
    safe_chain(data)?;
    let mut warnings = vec![];
    // Capture each file BEFORE interpreting it. Planning from one snapshot and
    // later capturing a different baseline can overwrite a concurrent editor.
    let config_change = FileChange::new(data.join("settings.json"),
        Some(serde_json::to_vec_pretty(&clean_driver_config()).map_err(|e| e.to_string())?))?;
    // gui-settings.json is app state (color scheme, update mode, advanced
    // mode) and is intentionally not reset: cleaning driver settings must
    // not change this app's appearance or behavior (2026-09-22).
    let info_change = FileChange::new(data.join("info.json"), None)?;
    let diagnostic_change = FileChange::new(data.join("diagnostic.json"), None)?;
    let config = match &config_change.before {
        Some(bytes) => match parse_json_bytes(&config_change.path, bytes) {
            Ok(v) if v.is_object() => v,
            _ => { warnings.push("The driver settings file could not be parsed. Its original bytes are backed up; it is reset to defaults without guessing old SteamVR overrides.".into()); json!({}) }
        },
        None => json!({}),
    };
    let mut changes = vec![];
    let mut restored_settings = 0;
    let mut identity = IdentityCleanupReport { removed_keys: vec![], removed_sections: vec![], warnings: vec![], backup_path: None };
    if let Some(ctx) = ctx {
        let mut steamvr_change = FileChange::new(ctx.settings.clone(), None)?;
        let mut journal_change = FileChange::new(ctx.journal(), None)?;
        // Bad SteamVR JSON/journal is an error, never permission to overwrite it.
        let mut settings = match &steamvr_change.before {
            Some(bytes) => parse_json_bytes(&steamvr_change.path, bytes)?,
            None => json!({}),
        };
        if !settings.is_object() { return Err("SteamVR settings must be a JSON object; no files were changed".into()); }
        let journal = match &journal_change.before {
            Some(bytes) => Some(validate_journal(ctx, parse_json_bytes(&journal_change.path, bytes)?)?),
            None => None,
        };
        let (keep, restored, report) = reset_owned_steamvr(&mut settings, journal.as_ref(), &config)?;
        identity = report;
        restored_settings = restored;
        if steamvr_change.before.is_some() {
            steamvr_change.after = Some(serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?);
            changes.push(steamvr_change);
        }
        if let Some(keep) = keep {
            journal_change.after = Some(serde_json::to_vec_pretty(&keep).map_err(|e| e.to_string())?);
            changes.push(journal_change);
        }
    } else {
        if data.join("steamvr-changes.json").exists() {
            return Err("SteamVR cannot be located, but a settings recovery journal exists. Locate/register SteamVR and retry; the journal and settings were left intact.".into());
        }
        warnings.push("SteamVR is not registered on this computer. Only driver configuration was reset; app preferences and SteamVR files were not changed.".into());
    }
    // Other settings use current driver defaults. Named Distortion/ files are
    // user data, not deleted. NVENC stays off until explicitly enabled again.
    changes.push(config_change);
    changes.push(info_change);
    changes.push(diagnostic_change);
    let reset_files = changes.iter().filter(|c| c.before != c.after).map(|c| c.path.to_string_lossy().into_owned()).collect();
    let backup_path = commit_clean(data, changes)?;
    warnings.extend(identity.warnings);
    Ok(CleanSettingsReport { backup_path, reset_files, restored_settings,
        removed_identity_keys: identity.removed_keys, removed_identity_sections: identity.removed_sections,
        steamvr_cleaned: ctx.is_some(), warnings })
}

#[tauri::command]
pub fn clean_galaxyxr_settings(steamvr_path: Option<String>) -> Result<CleanSettingsReport> {
    let _lock = platform::Lock::acquire()?;
    require_stopped()?;
    let ctx = steamvr_path.filter(|p| !p.trim().is_empty()).map(Context::live).transpose()?;
    let data = match &ctx {
        Some(ctx) => ctx.data.clone(),
        None => PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA unavailable")?).join("GalaxyXR/CustomHeadset"),
    };
    clean_settings_at(&data, ctx.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(original: Option<Value>, last: Option<Value>) -> Value {
        json!({"present":original.is_some(),"value":original,"lastPresent":last.is_some(),"lastValue":last})
    }
    #[test]
    fn reset_restores_all_owned_tab_settings_and_retains_installation() {
        let mut settings = json!({"driver_GalaxyXRNative":{"enable":true,"hasBeenRun":"1.2.0"},"steamvr":{"preferredRefreshRate":90,"roomSetup":"keep"},"vrlink_xrvst2ue":{"force10bit":true,"renderWidth":3552,"otherApp":42}});
        let journal = json!({"schema":1,"driver":DRIVER,"legacy":false,"sectionPresence":{},"entries":{
            "driver_GalaxyXRNative":{"enable":entry(Some(json!(false)),Some(json!(true)))},
            "steamvr":{"preferredRefreshRate":entry(Some(json!(120)),Some(json!(90)))},
            "vrlink_xrvst2ue":{"force10bit":entry(None,Some(json!(true))),"renderWidth":entry(None,Some(json!(3552)))}}});
        let (kept,count,_) = reset_owned_steamvr(&mut settings,Some(&journal),&json!({})).unwrap();
        assert_eq!(count,3); assert_eq!(settings["steamvr"]["preferredRefreshRate"],120);
        assert_eq!(settings["steamvr"]["roomSetup"],"keep"); assert_eq!(settings["vrlink_xrvst2ue"],json!({"otherApp":42}));
        assert_eq!(settings["driver_GalaxyXRNative"]["enable"],true);
        assert!(kept.unwrap()["entries"].get("steamvr").is_none());
    }
    #[test]
    fn cleanup_preserves_external_changes_and_other_drivers() {
        let mut settings = json!({"driver_vrlink":{"targetBandwidth":333},"driver_other":{"enable":false,"blocked_by_safe_mode":true},"perApp":{"someGame":42}});
        let journal = json!({"entries":{"driver_vrlink":{"targetBandwidth":entry(None,Some(json!(200)))},"driver_other":{"blocked_by_safe_mode":entry(Some(json!(true)),None)}},"sectionPresence":{}});
        let original=settings.clone();let (_,_,report)=reset_owned_steamvr(&mut settings,Some(&journal),&json!({})).unwrap();
        assert_eq!(settings,original); assert!(report.warnings.iter().any(|w|w.contains("external")));
    }
    #[test]
    fn unjournaled_custom_keys_match_both_profile_and_old_section() {
        let mut settings=json!({"driver_vrlink":{"foo":12},"vrlink_xrvst2ue":{"foo":12,"changed":99},"driver_other":{"foo":12}});
        let (_,count,_)=reset_owned_steamvr(&mut settings,None,&json!({"galaxyXr":{"vrlinkExtraKeys":{"foo":{"i":12},"changed":4}}})).unwrap();
        assert_eq!(count,2);assert_eq!(settings["vrlink_xrvst2ue"]["changed"],99);assert_eq!(settings["driver_other"]["foo"],12);
    }
    #[test]
    fn mirrored_profiles_restore_independent_originals_and_preserve_external_changes() {
        let profiles = ["vrlink_Oculus Quest Pro", "vrlink_PICO 4 Pro"];
        let mut settings = json!({});
        let mut journal = json!({"entries":{},"sectionPresence":{}});
        for (index, section) in profiles.iter().enumerate() {
            settings[*section] = json!({"renderWidth":3552,"supports10bit":true,"targetBandwidth":999,
                "custom":8,"resourceRoot":"temporary","otherApp":42});
            journal["entries"][*section] = json!({
                "renderWidth":entry(Some(json!(2000 + index)),Some(json!(3552))),
                "supports10bit":entry(None,Some(json!(true))),
                "targetBandwidth":entry(Some(json!(80)),Some(json!(200))),
                "maxVideoQueueLatencyUs":entry(Some(json!(100)),Some(json!(200))),
                "custom":entry(Some(json!(7)),Some(json!(8))),
                "resourceRoot":entry(Some(json!(DRIVER)),Some(json!("temporary")))});
        }
        let (_,count,report) = reset_owned_steamvr(&mut settings,Some(&journal),
            &json!({"galaxyXr":{"vrlinkExtraKeys":{"custom":7}}})).unwrap();
        assert_eq!(count,8);
        for (index,section) in profiles.iter().enumerate() {
            assert_eq!(settings[*section],json!({"renderWidth":2000 + index,"targetBandwidth":999,
                "custom":7,"resourceRoot":DRIVER,"otherApp":42}));
            assert!(report.warnings.iter().any(|w|w.contains(&format!("{section}.targetBandwidth"))));
            assert!(report.warnings.iter().any(|w|w.contains(&format!("{section}.maxVideoQueueLatencyUs"))));
        }
        assert!(report.removed_keys.is_empty());
    }
    #[test]
    fn mirrored_profiles_clean_only_exact_saved_unjournaled_extras() {
        let mut settings = json!({});
        for section in ["vrlink_Oculus Quest Pro", "vrlink_PICO 4 Pro", "vrlink_other"] {
            settings[section] = json!({"integer":12,"float":0.5,"boolean":true,"changed":99,
                "supports10bit":true,"otherApp":42});
        }
        let untouched = settings["vrlink_other"].clone();
        let (_,count,report) = reset_owned_steamvr(&mut settings,None,
            &json!({"galaxyXr":{"vrlinkExtraKeys":{"integer":{"i":12},"float":{"f":0.5},"boolean":{"b":true},"changed":4}}})).unwrap();
        assert_eq!(count,6);assert!(report.removed_keys.is_empty());
        for section in ["vrlink_Oculus Quest Pro", "vrlink_PICO 4 Pro"] {
            assert_eq!(settings[section],json!({"changed":99,"supports10bit":true,"otherApp":42}));
        }
        assert_eq!(settings["vrlink_other"],untouched);
    }
    #[test]
    fn local_reset_backs_up_raw_files_and_keeps_named_profiles() {
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root=std::env::temp_dir().join(format!("gxr-clean-test-{stamp}"));let data=root.join("CustomHeadset");
        atomic_bytes(&data.join("settings.json"),b"malformed old file").unwrap();
        atomic_json(&data.join("gui-settings.json"),&json!({"advanceMode":true})).unwrap();
        atomic_json(&data.join("Distortion/my-profile.json"),&json!({"keep":true})).unwrap();
        atomic_json(&data.join("info.json"),&json!({"driverVersion":"old"})).unwrap();
        let report=clean_settings_at(&data,None).unwrap();
        assert_eq!(read_json(&data.join("settings.json")).unwrap(),clean_driver_config());
        assert_eq!(read_json(&data.join("gui-settings.json")).unwrap(),json!({"advanceMode":true}));
        assert!(data.join("Distortion/my-profile.json").exists());assert!(!data.join("info.json").exists());
        assert!(Path::new(&report.backup_path).join("manifest.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_steamvr_with_recovery_journal_fails_without_resetting() {
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let root=std::env::temp_dir().join(format!("gxr-clean-journal-{stamp}"));
        atomic_json(&root.join("steamvr-changes.json"),&json!({})).unwrap();atomic_json(&root.join("settings.json"),&json!({"keep":42})).unwrap();
        assert!(clean_settings_at(&root,None).is_err());assert_eq!(read_json(&root.join("settings.json")).unwrap()["keep"],42);fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_file_is_not_overwritten_by_commit() {
        let stamp=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();let root=std::env::temp_dir().join(format!("gxr-clean-cas-{stamp}"));let data=root.join("CustomHeadset");
        atomic_bytes(&data.join("settings.json"),b"one").unwrap();let change=FileChange::new(data.join("settings.json"),Some(b"{}".to_vec())).unwrap();
        atomic_bytes(&change.path,b"external").unwrap();assert!(commit_clean(&data,vec![change]).is_err());assert_eq!(fs::read(data.join("settings.json")).unwrap(),b"external");fs::remove_dir_all(root).unwrap();
    }
    fn fixture() -> (PathBuf, Context) {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("gxr-clean-fixture-{stamp}"));
        let ctx = Context { steamvr: root.join("runtime"), paths_file: root.join("openvrpaths.vrpath"),
            settings: root.join("config/steamvr.vrsettings"), data: root.join("GalaxyXR/CustomHeadset"), managed: root.join("packages") };
        atomic_json(&ctx.settings, &json!({"steamvr":{"roomSetup":"keep"},"driver_other":{"enable":true}})).unwrap();
        atomic_json(&ctx.data.join("settings.json"), &json!({"galaxyXr":{"nativeIdentity":false}})).unwrap();
        (root, ctx)
    }
    #[test]
    fn full_clean_works_without_any_installed_driver_and_is_repeatable() {
        let (root, ctx) = fixture();
        let before = read_json(&ctx.settings).unwrap();
        atomic_json(&ctx.paths_file, &json!({"external_drivers":["unrelated"]})).unwrap();
        atomic_json(&ctx.receipt(), &json!({"keep":"receipt"})).unwrap();
        for _ in 0..2 {
            let report = clean_settings_at(&ctx.data, Some(&ctx)).unwrap();
            assert!(report.steamvr_cleaned);
            assert_eq!(read_json(&ctx.settings).unwrap(), before);
            assert_eq!(read_json(&ctx.data.join("settings.json")).unwrap(), clean_driver_config());
            assert_eq!(read_json(&ctx.receipt()).unwrap()["keep"], "receipt");
            assert_eq!(read_json(&ctx.paths_file).unwrap()["external_drivers"][0], "unrelated");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_steamvr_prevents_all_local_resets() {
        let (root, ctx) = fixture();
        let before = fs::read(ctx.data.join("settings.json")).unwrap();
        atomic_bytes(&ctx.settings, b"not JSON").unwrap();
        assert!(clean_settings_at(&ctx.data, Some(&ctx)).is_err());
        assert_eq!(fs::read(ctx.data.join("settings.json")).unwrap(), before);
        assert_eq!(fs::read(&ctx.settings).unwrap(), b"not JSON");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_journal_prevents_all_changes() {
        let (root, ctx) = fixture();
        let before = fs::read(ctx.data.join("settings.json")).unwrap();
        atomic_json(&ctx.journal(), &json!({"schema":999,"entries":{}})).unwrap();
        assert!(clean_settings_at(&ctx.data, Some(&ctx)).is_err());
        assert_eq!(fs::read(ctx.data.join("settings.json")).unwrap(), before);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn later_write_failure_rolls_back_prior_changes() {
        let (root, ctx) = fixture();
        let old = fs::read(ctx.data.join("settings.json")).unwrap();
        let changes = vec![FileChange::new(ctx.data.join("settings.json"), Some(b"{}".to_vec())).unwrap(),
            FileChange::new(ctx.data.join("gui-settings.json"), Some(b"{}".to_vec())).unwrap()];
        let mut writes = 0;
        let result = commit_clean_with(&ctx.data, changes, |path, bytes| {
            writes += 1;
            if writes == 2 { return Err("Injected write failure".into()); }
            restore_file(path, bytes)
        });
        assert!(result.unwrap_err().contains("Recovery backup"));
        assert_eq!(fs::read(ctx.data.join("settings.json")).unwrap(), old);
        assert!(!ctx.data.join("gui-settings.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rollback_does_not_overwrite_a_later_external_edit() {
        let (root, ctx) = fixture();
        let first = ctx.data.join("settings.json");
        let changes = vec![FileChange::new(first.clone(), Some(b"{}".to_vec())).unwrap(),
            FileChange::new(ctx.data.join("gui-settings.json"), Some(b"{}".to_vec())).unwrap()];
        let mut writes = 0;
        let result = commit_clean_with(&ctx.data, changes, |path, bytes| {
            writes += 1;
            if writes == 2 { atomic_bytes(&first, b"external edit")?; return Err("Injected failure".into()); }
            restore_file(path, bytes)
        });
        assert!(result.unwrap_err().contains("Preserved an external edit"));
        assert_eq!(fs::read(&first).unwrap(), b"external edit");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_pass_cannot_delete_a_restored_preinstall_identity() {
        let original = json!("{GalaxyXRNative}/input/galaxy_xr_hmd_profile.json");
        let mut settings = json!({"vrlink_xrvst2ue":{"inputProfilePath":"changed by us"}});
        let journal = json!({"entries":{"vrlink_xrvst2ue":{"inputProfilePath":entry(Some(original.clone()),Some(json!("changed by us")))}},"sectionPresence":{}});
        let (_, _, report) = reset_owned_steamvr(&mut settings, Some(&journal), &json!({})).unwrap();
        assert_eq!(settings["vrlink_xrvst2ue"]["inputProfilePath"], original);
        assert!(report.removed_keys.is_empty());
    }

}
