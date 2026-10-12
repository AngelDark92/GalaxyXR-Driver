#include "../src/Driver/Hooking/ControllerPoseEpoch.h"
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace {
using Epoch = gxr::ControllerPoseEpoch;
using Result = Epoch::Result;
int checks = 0, failures = 0;
void Check(bool ok, const char* label) {
    ++checks;
    if (!ok) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}
bool Near(double a, double b) { return std::abs(a - b) < 1e-9; }
vr::DriverPose_t Pose() {
    vr::DriverPose_t p{};
    p.poseTimeOffset = .015;
    p.deviceIsConnected = p.poseIsValid = true;
    p.result = vr::TrackingResult_Running_OK;
    p.qRotation.w = p.qWorldFromDriverRotation.w = p.qDriverFromHeadRotation.w = 1;
    p.vecVelocity[0] = 1;
    return p;
}
std::vector<double*> Values(vr::DriverPose_t& p) {
    return {&p.qWorldFromDriverRotation.w, &p.qWorldFromDriverRotation.x,
        &p.qWorldFromDriverRotation.y, &p.qWorldFromDriverRotation.z,
        &p.vecWorldFromDriverTranslation[0], &p.vecWorldFromDriverTranslation[1], &p.vecWorldFromDriverTranslation[2],
        &p.qDriverFromHeadRotation.w, &p.qDriverFromHeadRotation.x, &p.qDriverFromHeadRotation.y, &p.qDriverFromHeadRotation.z,
        &p.vecDriverFromHeadTranslation[0], &p.vecDriverFromHeadTranslation[1], &p.vecDriverFromHeadTranslation[2],
        &p.vecPosition[0], &p.vecPosition[1], &p.vecPosition[2],
        &p.vecVelocity[0], &p.vecVelocity[1], &p.vecVelocity[2],
        &p.vecAcceleration[0], &p.vecAcceleration[1], &p.vecAcceleration[2],
        &p.qRotation.w, &p.qRotation.x, &p.qRotation.y, &p.qRotation.z,
        &p.vecAngularVelocity[0], &p.vecAngularVelocity[1], &p.vecAngularVelocity[2],
        &p.vecAngularAcceleration[0], &p.vecAngularAcceleration[1], &p.vecAngularAcceleration[2]};
}
void Tests() {
    Epoch e;
    auto p = Pose();
    Check(e.Apply(p, 100, true) == Result::Fresh && p.poseTimeOffset == .015, "first source time retained");
    for (int i = 1; i <= 3; ++i) {
        p = Pose(); const auto before = p;
        double t = 100 + i / 360.0;
        Check(e.Apply(p, t, true) == Result::Repeat && Near(t + p.poseTimeOffset, 100.015), "repeats keep source epoch");
        p.poseTimeOffset = before.poseTimeOffset;
        Check(std::memcmp(&p, &before, sizeof(p)) == 0, "only offset changes");
    }
    // Every value, including transformations and accelerations, signals a fresh
    // sample. Tiny updates must not be swallowed by an epsilon deduplicator.
    for (size_t i = 0; i < Values(p).size(); ++i) {
        e.Reset(); p = Pose(); e.Apply(p, 100, true);
        p = Pose(); *Values(p)[i] += 1e-12;
        Check(e.Apply(p, 100.003, true) == Result::Fresh, "any numeric field change is fresh");
        e.Reset(); p = Pose(); e.Apply(p, 100, true);
        p = Pose(); *Values(p)[i] = std::numeric_limits<double>::quiet_NaN();
        Check(e.Apply(p, 100.003, true) == Result::Passthrough, "nonfinite payload is untouched");
        p = Pose(); Check(e.Apply(p, 100.006, true) == Result::Fresh, "nonfinite payload resets history");
    }
    for (int which = 0; which < 5; ++which) {
        e.Reset(); p = Pose(); e.Apply(p, 100, true); p = Pose();
        if (which == 0) p.deviceIsConnected = false;
        if (which == 1) p.poseIsValid = false;
        if (which == 2) p.result = vr::TrackingResult_Running_OutOfRange;
        if (which == 3) p.result = vr::TrackingResult_Fallback_RotationOnly;
        const auto before = p;
        Check(e.Apply(p, 100.003, which != 4) == Result::Passthrough, "loss or ineligible routing bypasses");
        Check(std::memcmp(&p, &before, sizeof(p)) == 0, "loss or bypass preserves every byte");
        p = Pose(); Check(e.Apply(p, 100.006, true) == Result::Fresh, "reacquisition gets new epoch");
    }
    for (int which = 0; which < 2; ++which) {
        e.Reset(); p = Pose(); e.Apply(p, 100, true); p = Pose();
        if (which == 0) p.willDriftInYaw = true; else p.shouldApplyHeadModel = true;
        Check(e.Apply(p, 100.003, true) == Result::Fresh, "head model and drift changes are fresh");
    }
    e.Reset();
    for (int i = 0; i < 100; ++i) {
        p = Pose(); p.vecVelocity[0] = 0;
        Check(e.Apply(p, 100 + i * .01, true) == Result::Passthrough && p.poseTimeOffset == .015,
            "fresh stationary poses never accumulate age");
    }
    e.Reset(); p = Pose(); e.Apply(p, 100, true);
    p = Pose(); Check(e.Apply(p, 100.04, true) == Result::Repeat, "short repeat burst retained");
    for (int i = 6; i < 100; ++i) {
        p = Pose();
        Check(e.Apply(p, 100 + i * .01, true) == Result::Expired && p.poseTimeOffset == .015,
            "frozen stream expires once and does not rearm");
    }
    p = Pose(); p.vecPosition[0] = .1;
    Check(e.Apply(p, 101, true) == Result::Fresh, "new payload rearms after expiry");
    e.Reset(); p = Pose(); e.Apply(p, 100, true); p = Pose();
    Check(e.Apply(p, 100.1, true) == Result::Fresh, "callback gap resets epoch");
    p = Pose(); Check(e.Apply(p, 99, true) == Result::Fresh, "backwards receipt resets epoch");
    p = Pose(); p.poseTimeOffset = -.04;
    Check(e.Apply(p, 99.003, true) == Result::Fresh, "backwards source clock resets epoch");
    for (double offset : {.2, -.2, std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN()}) {
        p = Pose(); p.poseTimeOffset = offset;
        Check(e.Apply(p, 100, true) == Result::Passthrough, "invalid offsets bypass");
    }
    e.Reset(); p = Pose(); e.Apply(p, 100, true);
    p = Pose(); p.poseTimeOffset = .005;
    Check(e.Apply(p, 100.01, true) == Result::Repeat && Near(p.poseTimeOffset, .005), "already coherent epoch retained");
    Epoch hands[2];
    p = Pose(); hands[0].Apply(p, 100, true); p = Pose(); hands[1].Apply(p, 100.002, true);
    p = Pose(); hands[0].Apply(p, 100.004, true); Check(Near(100.004 + p.poseTimeOffset, 100.015), "left epoch independent");
    p = Pose(); hands[1].Apply(p, 100.005, true); Check(Near(100.005 + p.poseTimeOffset, 100.017), "right epoch independent");

    // Independent physical oracle: uniform 1 m/s motion, 90 Hz samples,
    // 360 Hz retransmits, 225 Hz consumer. Correct output moves continuously;
    // the old packet epoch creates backwards prediction resets.
    e.Reset();
    double oldX = 0, newX = 0, oldEpoch = 0, fixedEpoch = 0, x = 0;
    int packet = -1, oldBack = 0, newBack = 0;
    for (int frame = 0; frame < 225; ++frame) {
        double render = frame / 225.0;
        while ((packet + 1) / 360.0 <= render) {
            ++packet; double t = packet / 360.0;
            p = Pose(); p.poseTimeOffset = -.02;
            p.vecPosition[0] = (packet / 4) / 90.0 - .02;
            x = p.vecPosition[0]; oldEpoch = t + p.poseTimeOffset;
            e.Apply(p, t, true); fixedEpoch = t + p.poseTimeOffset;
        }
        const double a = x + render - oldEpoch, b = x + render - fixedEpoch;
        if (frame && a < oldX - .0001) ++oldBack;
        if (frame && b < newX - .0001) ++newBack;
        Check(Near(b, render), "constant velocity prediction agrees with physical oracle");
        oldX = a; newX = b;
    }
    Check(oldBack > 30 && newBack == 0, "90/360/225 Hz regression removes prediction sawtooth");
    std::cout << "Synthetic API backsteps: " << oldBack << " -> " << newBack << '\n';
}

#pragma pack(push, 1)
struct Header { char magic[8]; uint32_t version, recordSize; uint64_t frequency, start, filetime, end, count, dropped, invalid; };
struct Record { uint64_t qpc, seq, parent, delivery; uint32_t kind, tid, device, size; unsigned char bytes[368]; };
#pragma pack(pop)
void Replay(const char* directory, const char* output) {
    static_assert(sizeof(Record) == 416 && sizeof(Header) == 72 && sizeof(vr::DriverPose_t) == 280);
    Header h{};
    std::ifstream header(std::string(directory) + "/header.bin", std::ios::binary);
    header.read(reinterpret_cast<char*>(&h), sizeof(h));
    if (!header || h.recordSize != sizeof(Record) || !h.frequency || h.dropped || h.invalid)
        throw std::runtime_error("Invalid/incomplete capture header");
    std::ifstream input(std::string(directory) + "/records.bin", std::ios::binary);
    std::ofstream out(output);
    if (!input || !out) throw std::runtime_error("Replay file open failed");
    out << "delivery,device,receipt,epoch_before,epoch_after,result\n" << std::setprecision(17);
    Epoch hands[2]; Record r{}; uint64_t total = 0, repeated = 0, fresh = 0, expired = 0;
    while (input.read(reinterpret_cast<char*>(&r), sizeof(r))) {
        ++total;
        if (r.kind != 2 || r.device < 1 || r.device > 2) continue;
        if (r.size != sizeof(vr::DriverPose_t)) throw std::runtime_error("Pose ABI mismatch");
        vr::DriverPose_t pose{}; std::memcpy(&pose, r.bytes, sizeof(pose));
        const double t = double(r.qpc) / double(h.frequency), before = t + pose.poseTimeOffset;
        const auto result = hands[r.device - 1].Apply(pose, t, true);
        repeated += result == Result::Repeat; fresh += result == Result::Fresh; expired += result == Result::Expired;
        // Independent invariant: replay never changes p/q/v/w/status/transforms.
        auto restored = pose; std::memcpy(&restored.poseTimeOffset, r.bytes, sizeof(double));
        if (std::memcmp(&restored, r.bytes, sizeof(restored))) throw std::runtime_error("Unexpected non-time change");
        out << r.delivery << ',' << r.device << ',' << t << ',' << before << ','
            << t + pose.poseTimeOffset << ',' << int(result) << '\n';
    }
    if (input.gcount() || total != h.count || !out) throw std::runtime_error("Truncated capture/output");
    std::cout << "Recorded replay: fresh=" << fresh << " repeats=" << repeated << " expired=" << expired << '\n';
}
}
int main(int argc, char** argv) {
    try {
        Tests();
        if (argc == 3) Replay(argv[1], argv[2]);
        else if (argc != 1) throw std::runtime_error("Usage: test [capture-directory output.csv]");
        std::cout << "Controller pose epoch: " << checks << " checks, " << failures << " failures\n";
        return failures ? 1 : 0;
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
