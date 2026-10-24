// Offline checks for the controller master disable
// (Config/ControllerMasterPolicy.h plus its production order with the Game
// Link layout policy). No driver, no SteamVR.
#include "../src/Config/ControllerMasterPolicy.h"
#include "../src/Config/GameLinkLayoutPolicy.h"
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
        // master off touches nothing
        Config c;
        c.streamFrame.velocityFixMode = 6;
        c.galaxyXr.gameLinkLayout = true;
        c.galaxyXr.gripConvention = true;
        c.galaxyXr.synthesizeGripTouch = true;
        c.galaxyXr.officialComponents = true;
        c.controllers.spaceVelocityFixMode = 2;
        gxr::ApplyControllerMasterPolicy(c);
        Check(!gxr::ControllerMasterDisabled(c), "the master disable is off by default");
        Check(c.streamFrame.velocityFixMode == 6 && c.galaxyXr.gameLinkLayout
            && c.galaxyXr.gripConvention && c.galaxyXr.synthesizeGripTouch
            && c.galaxyXr.officialComponents && c.controllers.spaceVelocityFixMode == 2,
            "master off: every controller setting is kept");
    }
    {
        // master on turns off every feature that bypass alone did not cover
        Config c;
        c.galaxyXr.controllerBypass = true;
        c.streamFrame.velocityFixMode = 6;
        c.galaxyXr.gameLinkLayout = true;
        c.galaxyXr.gripConvention = true;
        c.galaxyXr.synthesizeGripTouch = true;
        c.galaxyXr.officialComponents = true;
        c.controllers.spaceVelocityFixMode = 2;
        c.controllers.positionOffsetCm[0] = 0.5;
        c.streamFrame.kalmanCaJerk = 12345;
        gxr::ApplyControllerMasterPolicy(c);
        Check(gxr::ControllerMasterDisabled(c), "master on is detected");
        Check(c.galaxyXr.controllerBypass, "the stored switch stays on");
        Check(c.streamFrame.velocityFixMode == 0, "master on: every motion-filter mode is off");
        Check(!c.galaxyXr.gameLinkLayout, "master on: Game Link layout is off");
        Check(c.controllers.spaceVelocityFixMode == 0, "master on: space velocity fix is off");
        Check(!c.galaxyXr.gripConvention && !c.galaxyXr.synthesizeGripTouch
            && !c.galaxyXr.officialComponents, "master on: the remaining controller feature flags are off");
        Check(c.controllers.positionOffsetCm[0] == 0.5 && c.streamFrame.kalmanCaJerk == 12345,
            "master on: stored offsets and motion tuning are preserved");
    }
    {
        // production order: master, then Game Link layout; the master wins
        Config c;
        c.galaxyXr.controllerBypass = true;
        c.galaxyXr.gameLinkLayout = true;
        c.galaxyXr.nativeIdentity = false;
        c.galaxyXr.nativeInputProfile = false;
        c.controllers.rotationOffsetDeg[1] = 5.0;
        c.controllers.gameLinkRotationOffsetDeg[1] = -3.0;
        gxr::ApplyControllerMasterPolicy(c);
        gxr::ApplyGameLinkLayoutPolicy(c);
        Check(!c.galaxyXr.gameLinkLayout, "master on: layout stays off after both policies");
        Check(!c.galaxyXr.nativeIdentity && !c.galaxyXr.nativeInputProfile,
            "master on: the layout does not force identity or the input profile");
        Check(c.controllers.rotationOffsetDeg[1] == 5.0,
            "master on: the layout does not replace the shared offsets");
    }
    {
        // master off: the Game Link layout still applies as before
        Config c;
        c.galaxyXr.gameLinkLayout = true;
        c.galaxyXr.gripConvention = true;
        c.galaxyXr.nativeIdentity = false;
        c.galaxyXr.nativeInputProfile = false;
        gxr::ApplyControllerMasterPolicy(c);
        gxr::ApplyGameLinkLayoutPolicy(c);
        Check(c.galaxyXr.gameLinkLayout && !c.galaxyXr.gripConvention
            && c.galaxyXr.nativeIdentity && c.galaxyXr.nativeInputProfile,
            "master off: the Game Link layout still applies");
        Check(c.streamFrame.velocityFixMode == 6,
            "master off: the motion-filter default is kept");
    }
    std::cout << checks << " checks, " << failures << " failures\n";
    return failures == 0 ? 0 : 1;
}
