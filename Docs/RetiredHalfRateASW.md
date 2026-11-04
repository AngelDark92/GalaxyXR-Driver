# Async Spacewarp (retired and deleted)

Async Spacewarp (ASW) was retired and deleted on 2026-11-01.

It could only be implemented by tapping vrlink's private in-process value
transport or by running a separate listener beside Steam Link. Neither is a
supported or stable integration point. The host publisher, the automatic
half-rate cadence tracker, the `streamFrame.spacewarp*` settings, the status
rows, the GUI controls and the regression tests were removed with the feature.

Optical Flow (OFXR Bridge) is the supported PC-side frame-synthesis path. Old
`spacewarpEnable`, `spacewarpMode` and `spacewarpSettingsVersion` values in
`settings.json` are ignored and pruned from the Companion's next settings save.
