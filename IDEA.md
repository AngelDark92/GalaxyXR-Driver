**Summary:** An open-source Linux driver stack that turns a USB-C-docked Galaxy XR into a plug-and-play XR display and 6DoF tracking peripheral for PCs.

- Deliver stereoscopic 90Hz video over DisplayPort Alt Mode with sub-20ms motion-to-photon latency
- Stream IMU and camera-based 6DoF tracking data back to the host as standard HID-over-USB reports
- Provide an OpenXR-compliant compositor shim so SteamVR and native OpenXR titles run unmodified
- Ship per-model lens distortion and thermal throttling calibration profiles
- Distribute as DKMS modules with reproducible CI builds and signed releases
