#include "../src/Driver/FrameProcessor.h"
#include "../src/Driver/ReconLogger.h"
#include "../src/Driver/ZeroCopy.h"
#include <cstdarg>
#include <cstdio>
#include <iostream>
#include <string>

namespace {
int checks = 0;
int failures = 0;
uint64_t clockUs = 1000000;
int hitchClockReads = 0;
int errorClockReads = 0;
int hitchLines = 0;
int summaryLines = 0;
int heartbeatCalls = 0;
int reconResets = 0;

void Check(bool condition, const char* description) {
    ++checks;
    if (!condition) {
        ++failures;
        std::cerr << "FAIL: " << description << '\n';
    }
}

// Keep the production error-budget clock active independently of HITCHDIAG.
uint64_t NowMs() { ++errorClockReads; return clockUs / 1000; }
}

uint64_t FrameProcessor::NowUs() { ++hitchClockReads; return clockUs; }
void DriverLog(const char* format, ...) {
    char message[2048];
    va_list arguments;
    va_start(arguments, format);
    std::vsnprintf(message, sizeof(message), format, arguments);
    va_end(arguments);
    const std::string line(message);
    if (line.find("FrameProcessor: HITCH gap=") == 0) ++hitchLines;
    if (line.find("FrameProcessor: HITCHDIAG ") == 0) ++summaryLines;
}

// Only unrelated frame-start entry points are substituted. No GPU, SteamVR,
// hooks, files, or host settings are touched by this executable.
ZeroCopyV3& ZeroCopyV3::Get() { static ZeroCopyV3 instance; return instance; }
void ZeroCopyV3::MaybeHeartbeat() { ++heartbeatCalls; }
ReconLogger& ReconLogger::Get() { static ReconLogger instance; return instance; }
void ReconLogger::ResetSuppression() { ++reconResets; }

// The runner extracts the actual production function prefix verbatim, ending
// immediately before device/shader creation, then appends only return false.
#include "HitchFrameStart.generated.h"

int main() {
    FrameProcessor processor;
    FrameProcessSettings settings;
    const vr::VRTextureBounds_t bounds{0, 0, 1, 1};
    int frames = 0;
    auto frame = [&] {
        ++frames;
        Check(!processor.ProcessSceneLayer(0, 0, bounds, bounds, 0, settings),
            "test boundary stops before GPU processing");
        clockUs += 30000;
    };

    Check(!settings.config.hitchDiag, "native Hitch Diagnostics default is OFF");
    frame();
    frame();
    Check(hitchClockReads == 0, "default OFF makes no diagnostic clock reads");
    Check(hitchLines == 0 && summaryLines == 0, "default OFF emits no hitch logs");
    Check(errorClockReads == frames, "OFF preserves the independent error-budget clock");

    settings.config.hitchDiag = true;
    frame();
    Check(hitchClockReads == 1, "first enabled frame reads the diagnostic clock");
    Check(hitchLines == 0 && summaryLines == 0, "first enabled frame starts a clean window");
    frame();
    Check(hitchLines == 1, "enabled 30ms frame gap emits a hitch");

    settings.config.hitchDiag = false;
    const int readsBeforeOff = hitchClockReads;
    const int hitchesBeforeOff = hitchLines;
    const int summariesBeforeOff = summaryLines;
    // Keep this interval below the separate >1000ms idle-break threshold: a
    // missing transition reset would otherwise hide the phantom re-enable gap.
    for (int index = 0; index < 20; ++index) frame();
    Check(hitchClockReads == readsBeforeOff, "explicit OFF performs no diagnostic clock reads");
    Check(hitchLines == hitchesBeforeOff && summaryLines == summariesBeforeOff,
        "explicit OFF emits no diagnostic logs");

    settings.config.hitchDiag = true;
    frame();
    Check(hitchClockReads == readsBeforeOff + 1, "re-enable resumes diagnostic clock reads");
    Check(hitchLines == hitchesBeforeOff && summaryLines == summariesBeforeOff,
        "re-enable discards disabled time without a phantom hitch or summary");
    frame();
    Check(hitchLines == hitchesBeforeOff + 1, "re-enabled diagnostics resume real gap reporting");
    for (int index = 0; index < 69; ++index) frame();
    Check(summaryLines == summariesBeforeOff + 1, "enabled two-second window emits a summary");
    Check(errorClockReads == frames, "diagnostic toggles preserve the independent error clock");
    Check(heartbeatCalls == frames && reconResets == 0,
        "unrelated frame-start heartbeat remains active without arming recon");

    std::cout << "Hitch Diagnostics: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
