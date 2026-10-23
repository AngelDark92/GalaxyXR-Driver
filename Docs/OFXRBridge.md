# OFXR Bridge builds and the Companion

The Companion manages the [OFXR Bridge](https://github.com/tig3rmast3r/OFXR-Bridge)
OpenXR layer used by **Image Settings → Optical Flow**. It ships djules75's
actively maintained payload (v0.2.14.2, V557) and can install a downloaded fork
without a version-compatibility check.

## Install a downloaded fork

1. Download the fork release and unzip it.
2. In the Companion open **Image Settings → Optical Flow**.
3. Press **Install from folder…** and select either the release folder or its
   `ofxr` subfolder.
4. The build must contain `XR_APILAYER_XRFrameBridge_diagnostic.dll` and its own
   `ofxr_bridge.ini`. The whole payload folder is copied into the Companion's
   `%LOCALAPPDATA%\OFXR Bridge\RuntimeLayer\vNNN` area, so fork-specific helper
   DLLs survive.
5. If the fork's own tray is armed, disarm it there first. The Companion refuses
   to arm beside another manager's enabled registration rather than silently
   taking it over.

Imported builds are retained when the driver is uninstalled. **Uninstall
Optical Flow** removes the Companion's copies; it does not delete the source
folder or an external OFXR tray install.

## Shared vs build-specific settings

The Companion writes only the keys every verified fork reads:

| INI key | Companion control |
| --- | --- |
| `[ofxr] enabled`, `[ofxr] control_event` | Optical Flow arm/disarm |
| `[ofxr] backend`, `[ofxr] nvidia_preset` | Backend selector |
| `[ofxr] nvidia_bidirectional` | Bidirectional flow |
| `[diagnostics] logging_enabled` | Flight recorder |
| `[diagnostics] max_file_mb` | Flight log size |
| `[diagnostics] flush_each_event` | Flush every event |
| `[overlay] position` | FPS overlay position |

Everything else belongs to the downloaded build. The merge writer preserves it
unchanged, including:

- `nvidia_input_scale` (djules75 adds 25%; older forks only know 50/75/100)
- `motion_vectors`, `frame_generation`, `dlssg_resolution`, `dlssg_camera`
- `dlss_flow_hybrid`, `extrapolate`, `synthetic_pose`
- `hybrid`, `hybrid_depth_search`, `deep_pipeline`, `triple_frame_gen`
- `excluded_processes`, `single_swapchain_rings`, `capture_at_end_frame`,
  `vulkan_session_bridge`, `vulkan_bridge`, `d3d11_bridge`
- `overlay.size`, `overlay.latency`, `overlay.hybrid`, `overlay.multiplier`,
  `overlay.panel`, `overlay.panel_input`

Set those in the fork's own tray or INI. The Companion never rewrites a value
it does not expose.

## Verified contract

The current upstream (V116), djules75 (V557) and elliotttate
`native-dlss-fg` sources share the same layer contract:

- DLL and layer name `XR_APILAYER_XRFrameBridge_diagnostic`
- OpenXR manifest `file_format_version` 1.0.0, `api_version` 1.0,
  `disable_environment` `XRFG_DISABLE_OFXR_BRIDGE`
- arm event `Local\OFXRBridgeArmStop-<FNV-1a of the lower-cased UTF-16 path>`
- versioned runtime directory `vNNN` with `ofxr_bridge.ini` beside the DLL

The Companion's manifest and event name match that contract. A build newer
than the Companion is accepted; the version label is shown for identification,
not used as a gate.
