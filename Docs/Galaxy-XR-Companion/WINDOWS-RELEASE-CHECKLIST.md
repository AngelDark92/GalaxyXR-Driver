# Windows release checks — NOT RUN in the supplied evidence

Use a backed-up test installation. Record OS, scaling, WebView2 version, SteamVR/Steam Link versions, active registered driver path and build identifier with the results. A passed Linux pure test or mocked browser test does not mark these checks complete.

| Check | Expected evidence | Status |
|---|---|---|
| Full Galaxy portable build | Fresh frontend typecheck/Vite/Tauri/Rust and native DLL build succeeds; all three locale index pages embedded; GUI and driver resources staged together | NOT RUN |
| Neutral root build | Builds without inheriting Galaxy driver identity; existing neutral driver ID/resources remain intact | NOT RUN |
| Missing/unreadable driver | Only App Settings tab; direct links cannot render hidden pages; installation and checks reachable | NOT RUN |
| Driver state changes | Verified install restores tabs; removal/unreadability redirects; installed-but-disabled driver retains tabs | NOT RUN |
| Menu hierarchy | Parents and children bold/left-aligned; child indentation and distinct surfaces visible in light/dark at 100–200% scaling; keyboard collapse/expand works | NOT RUN |
| Baseline confirmation | Cancel leaves file and controls unchanged; confirm resets known picture defaults and disables enhancement master in one save | NOT RUN |
| Off-first mode guards | Enhancements On blocks baseline On; baseline On blocks enhancement On; explanations/links visible; baseline Off never auto-restores picture settings | NOT RUN |
| Reset scope and persistence | Color/curves/maps/alignment/dimming/calibration reset; controller/tracking/transport/quality/bitrate/unknown keys preserved; failed writes roll back | NOT RUN |
| Removed redundant switch | Profile: Supports 10-bit absent from all editable pages including Advanced; old stored fields preserved | NOT RUN |
| Older overlapping mode flags | Check/reload is read-only; baseline takes priority; native enhancement and post-pack passes remain bypassed | NOT RUN |
| Application name | Document, header, About, native titlebar and staged `Galaxy XR Companion.exe` use the new name | NOT RUN |
| Existing data | Old settings/profiles load from unchanged paths; no fresh empty app-data tree caused by branding | NOT RUN |
| Advanced visibility | Both identity switches hidden normally, visible in Advanced mode, On for missing keys; saved Off survives restart | NOT RUN |
| Confirmation | Off requires warning, Cancel restores the real switch, confirmed Off saves; warning remains when controls are hidden | NOT RUN |
| Settings refresh | About check rereads external changes and updates all visible and hidden values; malformed/unreadable files remain errors | NOT RUN |
| Profile On | Before connection, tuning settings reach `driver_vrlink` and the Galaxy request also lands in `vrlink_xrvst2ue` (the only additional headset section). The client reports model `xrvst2ue`, so VRLink reads that section on its unknown-model profile path. After restart/reconnect verify actual render size, stream width and bandwidth mode, not merely saved copies. Originals remain journaled | NOT RUN |
| Profile Off, baseline On | Saved switch remains Off; with the single reported model the capability destination is the same `vrlink_xrvst2ue` section, so Off restores the journaled baseline values instead of writing the enabled geometry; tuning uses `driver_vrlink` | NOT RUN |
| Profile Off, baseline Off | Prior routing retained; no spurious profile-enable mutation; picture values remain at the defaults intentionally reset when baseline was enabled | NOT RUN |
| Mid-session route change | Relevant writers all change route; UI explains restart; no claim that an active stream has already renegotiated | NOT RUN |
| Native journal cleanup | Only unchanged journal-owned values restored; preexisting values restored correctly; external edits preserved; journal remains compatible with existing uninstall logic | NOT RUN |
| Partial settings/retry | Missing individual render keys repaired; failed writes remain errors/recovery evidence, not false success | NOT RUN |
| Global settings | `steamvr.preferredRefreshRate` and driver enable/block/registration keys remain in required sections | NOT RUN |
| 10-bit negotiation | Inspect `driver_vrlink.txt` after reconnect; record actual mode and whether streamer reads profile-scoped keys | NOT RUN |
| Popups | Light/dark; keyboard/Escape; scrolling main/nested panes; every edge; long expanded details; small window; no clipped content, duplicate or orphan popups | NOT RUN |
| Locale launch | en-US, ja and zh-Hant packaged entry points open; untranslated new English help remains readable with technical detail separation | NOT RUN |
| Driver HMD icons | Updated registered DLL/resources publish ready/off/searching/alert/error/standby properties; searching animation retained; no repeated fallback to old icons while native identity On | NOT RUN |
| Controller/identity isolation | Controller artwork unchanged; native identity Off does not rewrite model/manufacturer or restore an identity it never owned | NOT RUN |
| Desktop icons | Newly built exe in Explorer, native titlebar and taskbar at 100%, 125%, 150%, 175%, 200%; repeat with fresh shortcut to new filename | NOT RUN |
| Portable behavior | Run from complete output folder, detect/update actual registered driver, saved-state check succeeds; no accidental dependency on source/dist folders | NOT RUN |
| Rollback | Previous complete app+driver bundle restored without changing identity/data paths or losing settings | NOT RUN |

Do not resolve an unknown setting state by deleting user settings or blindly clearing `steamvr.vrsettings`. Preserve backups and the driver recovery journal. If a streamer ignores a requested profile key, record the version and logs rather than moving global settings or silently changing saved switches.
