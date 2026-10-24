#pragma once
#include "Config.h"

namespace gxr {
// 2026-10-24 (owner request): the former Controller Bypass is now the master
// disable for every controller feature. It is applied only to the runtime copy,
// after all persisted migrations, so settings.json keeps the user's per-feature
// choices and they return the moment the switch goes off. The flag itself stays
// galaxyXr.controllerBypass for compatibility with existing settings files.
//
// The master must run BEFORE ApplyGameLinkLayoutPolicy: a saved Game Link layout
// no longer overrides it. Identity, models, input profile, pose components,
// grip convention, offsets/trims, grip-touch synthesis, skeleton offsets and
// the two Controller-Fix-Off corrections are already gated by controllerBypass
// in DeviceProvider/GalaxyXR.cpp. This policy adds the pieces that bypass alone
// did not cover: the motion filter (every Kalman/legacy mode), the Game Link
// layout and the space velocity fix.
inline bool ControllerMasterDisabled(const Config& config) {
    return config.galaxyXr.controllerBypass;
}
inline void ApplyControllerMasterPolicy(Config& config) {
    if (!ControllerMasterDisabled(config)) return;
    config.galaxyXr.gameLinkLayout = false;
    config.galaxyXr.gripConvention = false;
    config.galaxyXr.synthesizeGripTouch = false;
    config.galaxyXr.officialComponents = false;
    config.streamFrame.velocityFixMode = 0;
    config.controllers.spaceVelocityFixMode = 0;
}
} // namespace gxr
