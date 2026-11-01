// Applies the hybrid settings snapshot to the producer from unconditional call sites.
//
// The eye-processing path is optional (it only runs for colour/remap effects), so it cannot
// own hybrid configuration. Every settings publication calls ApplyHybridDriverConfig; the
// direct-mode Present calls ApplyHybridDriverConfigPerFrame so a change of the NVENC tap
// state (published per frame by the encoder settings) re-runs admission. Both do work only
// when the snapshot or the running encoder selection changed.
#pragma once

void ApplyHybridDriverConfig();
// One relaxed atomic load while hybrid is disabled in the settings; otherwise the hashed
// ApplyHybridDriverConfig.
void ApplyHybridDriverConfigPerFrame();
