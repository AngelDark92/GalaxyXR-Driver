// Offline checks for the Game Link layout toggle: the runtime preset
// (Config/GameLinkLayoutPolicy.h). no driver, no SteamVR.
#include "../src/Config/GameLinkLayoutPolicy.h"
#include <cmath>
#include <iostream>
#include <string>

namespace {
int checks = 0;
int failures = 0;
void Check(bool condition, const std::string& description) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << description << '\n';
    }
}
} // namespace

int main() {
    {
        // the preset touches nothing while the toggle is off
        Config c;
        c.streamFrame.velocityFixMode = 6;
        c.galaxyXr.gripConvention = true;
        c.galaxyXr.renderModelScale = 1.15;
        c.controllers.positionOffsetCm[0] = 0.5;
        gxr::ApplyGameLinkLayoutPolicy(c);
        Check(!gxr::GameLinkLayoutMode(c), "the Game Link layout is off by default");
        Check(c.galaxyXr.gripConvention && c.galaxyXr.renderModelScale == 1.15 && c.controllers.positionOffsetCm[0] == 0.5, "toggle off: the controller settings are kept");
    }
    {
        Config c;
        c.galaxyXr.gameLinkLayout = true;
        c.galaxyXr.gripConvention = true;
        c.galaxyXr.officialComponents = false;
        c.galaxyXr.nativeIdentity = false;
        c.galaxyXr.nativeInputProfile = false;
        c.galaxyXr.renderModelScale = 1.15;
        c.galaxyXr.aimTrimYCm = -1.0;
        c.galaxyXr.meshOffsetZCm = 2.0;
        c.galaxyXr.handAnchorPitchDeg = 5.0;
        c.controllers.rotationOffsetDeg[1] = 5.0;
        c.controllers.positionOffsetCm[0] = 0.5;
        c.controllers.leftPositionOffsetCm[2] = -2.0;
        c.controllers.rightRotationOffsetDeg[0] = 3.0;
        const double jerk = c.streamFrame.kalmanCaJerk;
        gxr::ApplyGameLinkLayoutPolicy(c);
        const auto& g = c.galaxyXr;
        Check(gxr::GameLinkLayoutMode(c), "the toggle turns the Game Link layout on");
        Check(!g.gripConvention, "Game Link layout: no grip convention shift");
        Check(g.officialComponents && !g.componentRebaseIncludeTrim, "Game Link layout: Samsung's pose components as authored");
        Check(g.nativeIdentity && g.nativeInputProfile, "Game Link layout: model and input profile are applied");
        Check(g.renderModelScale == 1.0, "Game Link layout: model at its authored size");
        Check(g.aimTrimXCm == 0 && g.aimTrimYCm == 0 && g.aimTrimZCm == 0, "Game Link layout: no aim trim");
        Check(g.meshOffsetXCm == 0 && g.meshOffsetYCm == 0 && g.meshOffsetZCm == 0, "Game Link layout: no mesh offset");
        Check(g.handAnchorPitchDeg == 0, "Game Link layout: no hand anchor");
        const Config d;
        bool zero = true;
        for (int i = 0; i < 3; i++) {
            zero = zero && c.controllers.rotationOffsetDeg[i] == d.controllers.gameLinkRotationOffsetDeg[i]
                && c.controllers.positionOffsetCm[i] == d.controllers.gameLinkPositionOffsetCm[i]
                && c.controllers.leftRotationOffsetDeg[i] == 0 && c.controllers.leftPositionOffsetCm[i] == 0
                && c.controllers.rightRotationOffsetDeg[i] == 0 && c.controllers.rightPositionOffsetCm[i] == 0;
        }
        Check(zero, "Game Link layout: its default trim replaces the shared offsets, no per-hand trims");
        Check(c.controllers.mirrorOffsetsForRightHand, "Game Link layout: its trim is mirrored for the right hand");
        Check(c.streamFrame.kalmanCaJerk == jerk && c.streamFrame.velocityFixMode == 6, "Game Link layout: the Kalman CA tuning and the mode are untouched");
    }
    {
        // the layout's own trim replaces the shared offsets, mirrored
        Config c;
        c.galaxyXr.gameLinkLayout = true;
        c.controllers.mirrorOffsetsForRightHand = false;
        c.controllers.rotationOffsetDeg[1] = 5.0;
        c.controllers.positionOffsetCm[0] = 0.5;
        c.controllers.leftRotationOffsetDeg[1] = 2.0;
        for (int i = 0; i < 3; i++) {
            c.controllers.gameLinkRotationOffsetDeg[i] = 0.0;
            c.controllers.gameLinkPositionOffsetCm[i] = 0.0;
        }
        c.controllers.gameLinkRotationOffsetDeg[1] = -3.0;
        c.controllers.gameLinkPositionOffsetCm[2] = 1.0;
        gxr::ApplyGameLinkLayoutPolicy(c);
        const auto& k = c.controllers;
        Check(k.rotationOffsetDeg[0] == 0 && k.rotationOffsetDeg[1] == -3.0 && k.rotationOffsetDeg[2] == 0, "Game Link layout: its rotation trim is the shared rotation offset");
        Check(k.positionOffsetCm[0] == 0 && k.positionOffsetCm[1] == 0 && k.positionOffsetCm[2] == 1.0, "Game Link layout: its position trim is the shared position offset");
        Check(k.mirrorOffsetsForRightHand && k.leftRotationOffsetDeg[1] == 0, "Game Link layout: its trim is mirrored and the per-hand trims stay out");
    }
    {
        // controller bypass: the layout still applies, without the driver's own corrections
        Config c;
        c.galaxyXr.gameLinkLayout = true;
        c.galaxyXr.controllerBypass = true;
        c.galaxyXr.gripConvention = true;
        c.galaxyXr.nativeIdentity = false;
        c.galaxyXr.synthesizeGripTouch = true;
        c.galaxyXr.skeletonOffsetZCm = 1.0;
        c.controllers.gameLinkRotationOffsetDeg[1] = -3.0;
        c.controllers.gameLinkPositionOffsetCm[2] = 1.0;
        gxr::ApplyGameLinkLayoutPolicy(c);
        const auto& g = c.galaxyXr;
        Check(!g.controllerBypass && g.nativeIdentity && g.nativeInputProfile && !g.gripConvention, "bypass + Game Link layout: the layout is applied");
        Check(!g.synthesizeGripTouch && g.skeletonOffsetZCm == 0, "bypass + Game Link layout: no grip touch synthesis, no skeleton offset");
        Check(c.controllers.rotationOffsetDeg[1] == -3.0 && c.controllers.positionOffsetCm[2] == 1.0, "bypass + Game Link layout: the layout trim still applies");
    }
    {
        // bypass alone is left as chosen
        Config c;
        c.galaxyXr.controllerBypass = true;
        gxr::ApplyGameLinkLayoutPolicy(c);
        Check(c.galaxyXr.controllerBypass, "toggle off: controller bypass is left as chosen");
    }
    std::cout << checks << " checks, " << failures << " failures\n";
    return failures == 0 ? 0 : 1;
}
