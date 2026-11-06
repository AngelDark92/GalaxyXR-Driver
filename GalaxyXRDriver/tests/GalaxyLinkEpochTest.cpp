// Steam Link Galaxy XR ownership epoch: pure state-machine tests (no Windows
// module APIs, no SteamVR). Module evidence is injected through the tracker's
// validator seams; the evidence itself (GetModuleHandleW / _ReturnAddress) is
// exercised by the production detours, not here.
#define GXR_GALAXYLINK_PURE 1
#include "../src/Driver/GalaxyLinkEpoch.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

using namespace gxr::galaxylink;

static int checks = 0, failures = 0;
static void Check(bool ok, const char* what) {
    ++checks;
    if (!ok) { ++failures; std::cerr << "FAIL: " << what << '\n'; }
}

// A fake "driver_vrlink.dll image": any address inside this buffer is vrlink.
static unsigned char vrlinkImage[256];
static unsigned char otherImage[256];
static bool InVrlink(const void* p) noexcept {
    auto a = reinterpret_cast<const unsigned char*>(p);
    return a >= vrlinkImage && a < vrlinkImage + sizeof(vrlinkImage);
}
// A fake driver object: first pointer is a vtable whose slot 0 is configurable.
struct FakeDriver { void** vtable; };
static const void* ReadSlot0(void* object) noexcept {
    auto d = static_cast<FakeDriver*>(object);
    return d && d->vtable ? d->vtable[0] : nullptr;
}

static const void* const kVrlinkCaller = vrlinkImage + 16;
static const void* const kOtherCaller = otherImage + 16;

struct Fixture {
    Tracker t;
    void* vrlinkVtable[1] = { vrlinkImage + 32 };
    void* otherVtable[1] = { otherImage + 32 };
    FakeDriver vrlinkDriver{ vrlinkVtable };
    FakeDriver foreignVtableDriver{ otherVtable };
    Fixture() { t.addressValidator = &InVrlink; t.vtableReader = &ReadSlot0; }
    void Session() { t.ObserveLog(kSessionFormat, kSessionFormat, std::strlen(kSessionFormat)); }
    void Props(const char* model) {
        char line[160];
        std::snprintf(line, sizeof(line), "ReceivedHMDStaticProps. Model Number: %s, Serial Number: SN1234 (7)", model);
        t.ObserveLog(kPropsFormat, line, std::strlen(line));
    }
    void Arm() { Session(); Props(kOriginalModel); }
    bool Begin() { return t.BeginHmd(&vrlinkDriver, kVrlinkCaller); }
    // handshake -> provisional -> bound -> admitted at device index `id`
    void Admit(uint32_t id) {
        Arm();
        Check(Begin(), "fixture: provisional epoch opens");
        t.BindHmd(id);
        t.ConfirmHmd(id, true);
    }
};

int main() {
    // ---- model parsing -----------------------------------------------------
    {
        char m[64];
        const char* ok = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: A (1)";
        Check(Tracker::ParseModel(ok, std::strlen(ok), m, sizeof(m)) && std::strcmp(m, "xrvst2ue") == 0, "exact model parsed");
        const char* quest = "ReceivedHMDStaticProps. Model Number: Oculus Quest3, Serial Number: A (1)";
        Check(Tracker::ParseModel(quest, std::strlen(quest), m, sizeof(m)) && std::strcmp(m, "Oculus Quest3") == 0, "other model parsed verbatim");
        const char* noPrefix = "Something else. Model Number: xrvst2ue, Serial Number: A (1)";
        Check(!Tracker::ParseModel(noPrefix, std::strlen(noPrefix), m, sizeof(m)), "wrong prefix rejected");
        const char* noMid = "ReceivedHMDStaticProps. Model Number: xrvst2ue";
        Check(!Tracker::ParseModel(noMid, std::strlen(noMid), m, sizeof(m)), "missing serial separator rejected");
        const char* empty = "ReceivedHMDStaticProps. Model Number: , Serial Number: A (1)";
        Check(!Tracker::ParseModel(empty, std::strlen(empty), m, sizeof(m)), "empty model rejected");
        std::string longModel = "ReceivedHMDStaticProps. Model Number: " + std::string(80, 'x') + ", Serial Number: A (1)";
        Check(!Tracker::ParseModel(longModel.c_str(), longModel.size(), m, sizeof(m)), "oversized model rejected, buffer never overrun");
        // length bound is honoured even when the buffer continues with a valid tail
        const char* tail = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: A (1)";
        Check(!Tracker::ParseModel(tail, 45, m, sizeof(m)), "length bound hides a later separator");
        const char* forged = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: forged, Serial Number: A (1)";
        Check(!Tracker::ParseModel(forged, std::strlen(forged), m, sizeof(m)), "a second delimiter (forged model split) fails closed");
        const char* forgedModel = "ReceivedHMDStaticProps. Model Number: Quest, Serial Number: xrvst2ue, Serial Number: A (1)";
        Check(!Tracker::ParseModel(forgedModel, std::strlen(forgedModel), m, sizeof(m)), "an ambiguous line never yields any model");
        char withNul[] = "ReceivedHMDStaticProps. Model Number: xrvst2ue\0X, Serial Number: A (1)";
        Check(!Tracker::ParseModel(withNul, sizeof(withNul) - 1, m, sizeof(m)), "embedded NUL inside the reported length is rejected");
        const char* percent = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: 50%s%%d (1)";
        Check(Tracker::ParseModel(percent, std::strlen(percent), m, sizeof(m)) && std::strcmp(m, "xrvst2ue") == 0, "an ordinary serial containing % is preserved");
    }

    // ---- no evidence, no admission --------------------------------------------
    {
        Fixture f;
        Check(!f.Begin(), "no handshake: foreign pass-through");
        Check(f.t.State() == TargetState::Closed && !f.t.TargetOpen(), "stays closed");
        f.Props(kOriginalModel); // props without a session marker
        Check(!f.Begin() && !f.t.HandshakeArmed(), "props without a session marker never arm");
        f.Session();
        Check(!f.Begin() && !f.t.HandshakeArmed(), "session marker alone never arms");
        f.Props("xrvst2ue");
        Check(f.t.HandshakeArmed(), "session then exact original model arms");
    }

    // ---- module evidence ---------------------------------------------------------
    {
        Fixture f;
        f.Arm();
        const uint64_t e0 = f.t.CurrentEpoch();
        Check(!f.t.BeginHmd(&f.vrlinkDriver, kOtherCaller), "caller outside driver_vrlink.dll is rejected");
        Check(!f.t.BeginHmd(&f.foreignVtableDriver, kVrlinkCaller), "vtable[0] outside driver_vrlink.dll is rejected");
        Check(!f.t.BeginHmd(nullptr, kVrlinkCaller), "null driver is rejected");
        Check(!f.t.BeginHmd(&f.vrlinkDriver, nullptr), "null caller is rejected");
        Check(f.t.CurrentEpoch() == e0 && f.t.HandshakeArmed(), "rejections neither open an epoch nor spend the handshake");
        Check(!f.t.BeginHmdValidated(&f.vrlinkDriver, false), "unvalidated module is rejected");
        Check(f.Begin(), "exact module caller + vtable opens a provisional epoch");
        Check(f.t.State() == TargetState::Provisional && f.t.TargetOpen(), "provisional state");
        Check(f.t.CurrentEpoch() > e0, "opening bumps the epoch");
        Check(!f.t.IsAdmittedEpoch(f.t.CurrentEpoch()) && f.t.IsOpenEpoch(f.t.CurrentEpoch()), "provisional is open but not admitted");
        Check(!f.Begin(), "a second HMD add never steals the open target");
        f.Props(kOriginalModel); // repeated props in the same session
        Check(!f.Begin(), "a repeated handshake cannot open a second target while one is open");
        f.Arm(); // a new session marker invalidates the open target by design...
        Check(f.t.State() == TargetState::Closed, "a new session marker closes an open provisional target");
        Check(f.Begin(), "...and its own fresh handshake opens a new one");
    }

    // ---- handshake model rules -------------------------------------------------------
    {
        Fixture f;
        f.Session();
        f.Props("Oculus Quest 3");
        Check(!f.t.HandshakeArmed() && !f.Begin(), "a different Steam Link model never arms");
        f.Session();
        f.Props("xrvst2ue");
        f.Props("xrvst2ue");
        f.Props("xrvst2ue");
        Check(f.t.HandshakeArmed(), "repeated same-model props in one session keep the handshake");
        const uint64_t e = f.t.CurrentEpoch();
        Check(f.Begin(), "armed handshake opens");
        f.Props("xrvst2ue");
        Check(f.t.CurrentEpoch() == e + 1 && f.t.State() == TargetState::Provisional, "repeated valid props never revoke an open provisional epoch");
        f.Props("PICO 4 Pro");
        Check(f.t.State() == TargetState::Closed && !f.t.TargetOpen(), "a new model invalidates an open target");
        Check(!f.t.HandshakeArmed(), "and clears the session");
        // unknown / unparsable props clear too
        Fixture g;
        g.Arm();
        const char* garbage = "ReceivedHMDStaticProps. Model Number: xrvst2ue";
        g.t.ObserveLog(kPropsFormat, garbage, std::strlen(garbage));
        Check(!g.t.HandshakeArmed(), "unparsable props clear the handshake");
        // unrelated formats are ignored
        Fixture h;
        h.Arm();
        h.t.ObserveLog("Something else %d", "Something else 1", 16);
        h.t.ObserveLog(nullptr, "x", 1);
        h.t.ObserveLog(kPropsFormat, nullptr, 0);
        Check(h.t.HandshakeArmed(), "unrelated or null observations change nothing");
        // exact format match: a near-miss format string is not the session marker
        Fixture n;
        n.t.ObserveLog("New Session detected; Invalidating.", "New Session detected; Invalidating.", 35);
        n.Props("xrvst2ue");
        Check(!n.t.HandshakeArmed(), "near-miss session format does not count");
    }

    // ---- confirmation ------------------------------------------------------------------
    {
        Fixture f;
        f.Arm();
        f.Begin();
        f.t.BindHmd(3);
        f.t.ConfirmHmd(3, false);
        Check(f.t.State() == TargetState::Closed && !f.t.IsAdmittedDevice(3), "failed Activate / foreign parent denies and closes");
        Check(!f.Begin(), "a denied epoch needs a fresh session and handshake");

        Fixture g;
        g.Arm(); g.Begin(); g.t.BindHmd(2);
        g.t.ConfirmHmd(5, true);
        Check(g.t.State() == TargetState::Closed, "confirming a different device than the bound one denies");

        Fixture h;
        h.Arm(); h.Begin();
        h.t.ConfirmHmd(kInvalidDevice, true);
        Check(h.t.State() == TargetState::Closed, "an invalid device index never admits");

        Fixture i;
        i.Admit(4);
        Check(i.t.State() == TargetState::Admitted, "success + ownership admits");
        Check(i.t.IsAdmittedDevice(4) && !i.t.IsAdmittedDevice(0) && !i.t.IsAdmittedDevice(5) && !i.t.IsAdmittedDevice(kInvalidDevice), "only the exact device is admitted");
        Check(i.t.AdmittedDevice() == 4 && i.t.TargetDevice() == 4, "admitted/target device accessors");
        Check(i.t.IsAdmittedEpoch(i.t.CurrentEpoch()), "current epoch is admitted");
        Check(!i.t.IsAdmittedEpoch(0) && !i.t.IsAdmittedEpoch(i.t.CurrentEpoch() - 1), "epoch 0 and a stale epoch are never admitted");
        // confirm without a provisional epoch does nothing
        Fixture j;
        j.t.ConfirmHmd(1, true);
        Check(j.t.State() == TargetState::Closed && !j.t.IsAdmittedDevice(1), "confirm without a provisional epoch cannot admit");
        // the bound index is visible before admission
        Fixture k;
        k.Arm(); k.Begin(); k.t.BindHmd(6);
        Check(k.t.TargetDevice() == 6 && !k.t.IsAdmittedDevice(6), "device index binds before admission without admitting");
        k.t.BindHmd(7);
        k.t.ConfirmHmd(7, true);
        Check(k.t.IsAdmittedDevice(7), "rebinding while provisional is allowed");
        k.t.BindHmd(9);
        Check(k.t.TargetDevice() == 7, "binding after admission cannot move the target");
    }

    // ---- connection edge, disconnect, reconnect --------------------------------------------
    {
        Fixture f;
        f.Admit(1);
        const uint64_t admitted = f.t.CurrentEpoch();
        f.t.ObservePose(1, true);
        f.t.ObservePose(0, false); // foreign device down pose
        f.t.ObservePose(7, false);
        Check(f.t.IsAdmittedDevice(1) && f.t.CurrentEpoch() == admitted, "connected poses and foreign down poses never close the target");
        f.t.ObservePose(1, false);
        Check(!f.t.IsAdmittedDevice(1) && f.t.State() == TargetState::Closed, "the target's disconnected pose closes synchronously");
        Check(f.t.CurrentEpoch() == 0 && !f.t.IsAdmittedEpoch(admitted) && !f.t.IsOpenEpoch(admitted), "the old epoch is dead immediately");
        f.t.ObservePose(1, true);
        Check(!f.t.IsAdmittedDevice(1), "a later connected pose never re-admits");
        Check(!f.Begin(), "reconnect without a fresh session + handshake is refused (no stale adoption)");
        f.Session();
        Check(!f.Begin(), "fresh session without a handshake is still refused");
        f.Props("xrvst2ue");
        Check(f.Begin(), "fresh session + handshake opens a new provisional epoch");
        f.t.BindHmd(1);
        f.t.ConfirmHmd(1, true);
        Check(f.t.IsAdmittedDevice(1) && f.t.CurrentEpoch() != 0 && f.t.CurrentEpoch() != admitted && !f.t.IsAdmittedEpoch(admitted), "reconnect admits under a brand-new epoch");

        // provisional: a down pose must not stop Activate-time confirmation
        Fixture g;
        g.Arm(); g.Begin(); g.t.BindHmd(2);
        g.t.ObservePose(2, false);
        g.t.ConfirmHmd(2, true);
        Check(g.t.IsAdmittedDevice(2), "confirmation does not require a connected pose during Activate");
        g.t.ObservePose(2, false);
        Check(!g.t.IsAdmittedDevice(2), "but a settled disconnected state is denied");
    }

    // ---- session, close, deactivate ---------------------------------------------------------------
    {
        Fixture f;
        f.Admit(1);
        const uint64_t e = f.t.CurrentEpoch();
        f.Session();
        Check(!f.t.IsAdmittedDevice(1) && f.t.State() == TargetState::Closed && f.t.CurrentEpoch() == 0 && e != 0, "a new session marker invalidates the admitted target");
        Check(!f.t.HandshakeArmed(), "and demands a fresh handshake");

        Fixture g;
        g.Admit(1);
        const uint64_t cur = g.t.CurrentEpoch();
        g.t.CloseIfEpoch(cur - 1);
        g.t.CloseIfEpoch(0);
        Check(g.t.IsAdmittedDevice(1), "closing a different/zero epoch is a no-op");
        g.t.CloseIfEpoch(cur);
        Check(!g.t.IsAdmittedDevice(1), "deactivate closes its own epoch");

        Fixture h;
        h.Admit(1);
        h.t.Close();
        Check(h.t.State() == TargetState::Closed && !h.t.TargetOpen() && !h.t.IsAdmittedDevice(1), "cleanup closes synchronously");
        h.t.Close();
        Check(h.t.State() == TargetState::Closed, "close is idempotent");
        Check(!h.t.HandshakeArmed(), "close clears the handshake");
    }

    // ---- consumer gating model: wrappers captured under an epoch ----------------------------------------
    {
        // Frame/eye/controller wrappers store the epoch they were created under
        // and ask the tracker per call.
        Fixture f;
        f.Arm(); f.Begin();
        const uint64_t wrapEpoch = f.t.CurrentEpoch();
        Check(f.t.IsOpenEpoch(wrapEpoch) && !f.t.IsAdmittedEpoch(wrapEpoch), "wrap decision (open) precedes admission");
        f.t.BindHmd(1); f.t.ConfirmHmd(1, true);
        Check(f.t.IsAdmittedEpoch(wrapEpoch), "wrapper acts once admitted");
        f.t.ObservePose(1, false);
        Check(!f.t.IsAdmittedEpoch(wrapEpoch) && !f.t.IsOpenEpoch(wrapEpoch), "wrapper is transparent the instant the target disconnects");
        f.Arm(); f.Begin(); f.t.BindHmd(1); f.t.ConfirmHmd(1, true);
        Check(!f.t.IsAdmittedEpoch(wrapEpoch), "an old wrapper never wakes up under a later epoch");
    }

    // ---- same-object reconnect (no new TrackedDeviceAdded) ---------------------------------------------------
    {
        Fixture f;
        f.Admit(2);
        const uint64_t lineage = f.t.CurrentLineage();
        const uint64_t firstEpoch = f.t.CurrentEpoch();
        Check(lineage != 0 && f.t.IsAdmittedLineage(lineage) && f.t.IsOpenLineage(lineage), "lineage is admitted with the target");
        f.t.ObservePose(2, false);
        Check(f.t.RetainedDevice() == 2 && !f.t.IsAdmittedLineage(lineage) && !f.t.IsOpenLineage(lineage), "disconnect retains the HMD object but admits nothing");
        // no fresh identity: stays closed whatever the pose says
        Check(!f.t.CanRebind(2, true), "no fresh session/handshake: cannot rebind");
        Check(!f.t.RebindHmd(2, kVrlinkCaller, true, true), "no fresh session/handshake: rebind refused");
        f.Session();
        Check(!f.t.CanRebind(2, true) && !f.t.RebindHmd(2, kVrlinkCaller, true, true), "a session marker alone is not enough");
        f.Props(kOriginalModel);
        Check(f.t.CanRebind(2, true) && !f.t.CanRebind(2, false) && !f.t.CanRebind(5, true), "armed: only the retained device on a connected-up edge may rebind");
        Check(!f.t.RebindHmd(2, kOtherCaller, true, true), "pose caller outside driver_vrlink.dll is refused");
        Check(!f.t.RebindHmd(2, nullptr, true, true), "missing pose caller is refused");
        Check(!f.t.RebindHmd(2, kVrlinkCaller, true, false), "a device whose parent driver is not vrlink is refused");
        Check(!f.t.RebindHmd(2, kVrlinkCaller, false, true), "a still-disconnected pose is refused");
        Check(!f.t.RebindHmd(4, kVrlinkCaller, true, true), "a different device index is refused");
        Check(f.t.State() == TargetState::Closed && f.t.HandshakeArmed(), "refusals neither admit nor spend the fresh handshake");
        Check(f.t.RebindHmd(2, kVrlinkCaller, true, true), "fresh session + handshake + connected-up from vrlink admits the same object");
        Check(f.t.State() == TargetState::Admitted && f.t.IsAdmittedDevice(2), "re-admitted under a live open epoch");
        Check(f.t.CurrentLineage() == lineage && f.t.IsAdmittedLineage(lineage), "same lineage: wrappers of that object wake up");
        Check(f.t.CurrentEpoch() != 0 && f.t.CurrentEpoch() != firstEpoch && !f.t.IsAdmittedEpoch(firstEpoch), "but under a brand-new epoch; the old epoch stays dead");
        Check(f.t.RetainedDevice() == kInvalidDevice, "the retained marker is consumed");
        Check(!f.t.RebindHmd(2, kVrlinkCaller, true, true), "an open target cannot be rebound again");
        // the evidence is spent: a second disconnect needs a second fresh identity
        f.t.ObservePose(2, false);
        Check(!f.t.CanRebind(2, true) && !f.t.RebindHmd(2, kVrlinkCaller, true, true), "the previous handshake cannot be reused");
        f.Arm();
        Check(f.t.RebindHmd(2, kVrlinkCaller, true, true) && f.t.IsAdmittedDevice(2), "a second reconnect works with its own fresh identity");
    }
    {
        // a different headset reusing the same index is denied
        Fixture f;
        f.Admit(1);
        f.t.ObservePose(1, false);
        f.Session();
        f.Props("Oculus Quest 3"); // another Steam Link model
        Check(f.t.RetainedDevice() == kInvalidDevice && !f.t.CanRebind(1, true), "a different model forgets the retained object");
        f.Session();
        f.Props(kOriginalModel);
        Check(!f.t.RebindHmd(1, kVrlinkCaller, true, true), "even a later xrvst2ue handshake cannot revive a forgotten object");
        // a stream session change while admitted also retains (and then demands fresh identity)
        Fixture g;
        g.Admit(3);
        g.Session();
        Check(g.t.RetainedDevice() == 3 && g.t.State() == TargetState::Closed, "a new session marker closes the target and retains the object");
        Check(!g.t.RebindHmd(3, kVrlinkCaller, true, true), "the marker alone does not re-admit");
        g.Props(kOriginalModel);
        Check(g.t.RebindHmd(3, kVrlinkCaller, true, true), "marker + exact handshake does");
        // a failed confirmation never leaves a rebindable object
        Fixture h;
        h.Arm(); h.Begin(); h.t.BindHmd(4); h.t.ConfirmHmd(4, false);
        h.Arm();
        Check(h.t.RetainedDevice() == kInvalidDevice && !h.t.RebindHmd(4, kVrlinkCaller, true, true), "a denied activation is never retained or rebound");
    }
    {
        // deactivate of the old object cannot close a newer lineage, and a
        // deactivated object can never be rebound
        Fixture f;
        f.Admit(1);
        const uint64_t oldLineage = f.t.CurrentLineage();
        f.t.ObservePose(1, false);
        f.t.CloseIfLineage(oldLineage); // the old object is deactivated while closed
        Check(f.t.RetainedDevice() == kInvalidDevice, "deactivate forgets the retained object");
        f.Arm();
        Check(!f.t.RebindHmd(1, kVrlinkCaller, true, true), "a deactivated object cannot be rebound");
        Check(f.Begin(), "a NEW TrackedDeviceAdded opens a new object");
        f.t.BindHmd(1); f.t.ConfirmHmd(1, true);
        const uint64_t newLineage = f.t.CurrentLineage();
        Check(newLineage > oldLineage && f.t.IsAdmittedLineage(newLineage) && !f.t.IsAdmittedLineage(oldLineage), "new object, new lineage; old wrappers stay dead");
        f.t.CloseIfLineage(oldLineage);
        f.t.CloseIfLineage(0);
        Check(f.t.IsAdmittedLineage(newLineage), "late deactivate of the previous object cannot close the new one");
        f.t.CloseIfLineage(newLineage);
        Check(!f.t.IsAdmittedLineage(newLineage) && f.t.RetainedDevice() == kInvalidDevice, "deactivate of the current object closes without retaining");
    }

    // ---- global API: own poses never close the epoch -------------------------------------------------------
    {
        auto& g = detail::Global();
        g.addressValidator = &InVrlink;
        g.vtableReader = &ReadSlot0;
        Close();
        static void* vtable[1] = { vrlinkImage + 32 };
        static FakeDriver driver{ vtable };
        const char* s = kSessionFormat;
        ObserveLog(kSessionFormat, s, std::strlen(s));
        const char* p = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: Z (1)";
        ObserveLog(kPropsFormat, p, std::strlen(p));
        Check(BeginHmd(&driver, kVrlinkCaller), "global API opens");
        BindHmd(3); ConfirmHmd(3, true);
        Check(IsAdmittedDevice(3) && TargetOpen() && AdmittedDevice() == 3 && TargetDevice() == 3, "global API admits");
        Check(IsVrlinkAddress(kVrlinkCaller) && !IsVrlinkAddress(kOtherCaller) && !IsVrlinkAddress(nullptr), "global module check");
        {
            OwnPoseScope scope;
            ObservePose(3, false);
        }
        Check(IsAdmittedDevice(3), "this driver's own synthetic disconnected pose does not close the epoch");
        ObservePose(3, false);
        Check(!IsAdmittedDevice(3), "a real disconnected pose does");
        Close();
    }

    // ---- CurrentEpoch() contract: 0 whenever no provisional/admitted target ----------------------------
    {
        Fixture f;
        Check(f.t.CurrentEpoch() == 0, "initial: 0");
        f.Session();
        Check(f.t.CurrentEpoch() == 0, "session marker only: 0");
        f.Props(kOriginalModel);
        Check(f.t.CurrentEpoch() == 0, "armed handshake without an HMD add: 0");
        Check(f.Begin() && f.t.CurrentEpoch() != 0, "provisional: nonzero");
        const uint64_t provisional = f.t.CurrentEpoch();
        f.t.BindHmd(1); f.t.ConfirmHmd(1, true);
        Check(f.t.CurrentEpoch() == provisional && f.t.IsAdmittedEpoch(provisional), "admitted keeps the SAME epoch as its provisional");
        f.t.ObservePose(1, false);
        Check(f.t.CurrentEpoch() == 0, "closed by disconnect: 0 (never the old generation)");
        f.Arm();
        Check(f.t.CurrentEpoch() == 0, "handshake after close, before any add: still 0");
        Check(f.Begin() && f.t.CurrentEpoch() != 0 && f.t.CurrentEpoch() != provisional, "a new add publishes a different epoch");
        f.Session();
        Check(f.t.CurrentEpoch() == 0, "session start closes: 0");
        f.Arm(); f.Begin(); f.t.BindHmd(2); f.t.ConfirmHmd(2, false);
        Check(f.t.CurrentEpoch() == 0, "failed confirmation: 0");
        f.Arm(); f.Begin();
        f.Props("Oculus Quest 3");
        Check(f.t.CurrentEpoch() == 0, "mismatched model: 0");
        f.Arm(); f.Begin(); f.t.Close();
        Check(f.t.CurrentEpoch() == 0, "explicit close: 0");
        // same-object reconnect publishes a fresh epoch, same lineage
        f.Admit(3);
        const uint64_t before = f.t.CurrentEpoch(); const uint64_t lineage = f.t.CurrentLineage();
        f.t.ObservePose(3, false);
        Check(f.t.CurrentEpoch() == 0, "reconnect pending: 0");
        f.Arm();
        Check(f.t.RebindHmd(3, kVrlinkCaller, true, true) && f.t.CurrentEpoch() != 0 && f.t.CurrentEpoch() != before && f.t.CurrentLineage() == lineage, "rebind: new epoch, same lineage");
        // A wrapper created for a proven target object while it is closed (early or
        // reconnect-time fetch) stays inert until its OWN lineage is admitted again.
        f.t.ObservePose(3, false);
        Check(!f.t.IsAdmittedLineage(lineage) && !f.t.IsOpenLineage(lineage), "closed fetch: wrapper inert");
        f.Arm();
        Check(f.t.RebindHmd(3, kVrlinkCaller, true, true) && f.t.IsAdmittedLineage(lineage), "wrapper created while closed activates on its own new epoch");
        f.t.Close(); f.Arm(); f.Begin(); f.t.BindHmd(3); f.t.ConfirmHmd(3, true);
        Check(!f.t.IsAdmittedLineage(lineage) && f.t.CurrentLineage() != lineage, "a different HMD object never wakes that wrapper");
    }
    // ---- concurrency smoke -------------------------------------------------------------------------------------------
    {
        Fixture f;
        std::atomic<bool> stop{ false };
        std::atomic<long> reads{ 0 };
        std::vector<std::thread> threads;
        for (int i = 0; i < 4; ++i) {
            threads.emplace_back([&] {
                while (!stop.load()) {
                    const uint64_t e = f.t.CurrentEpoch();
                    (void)f.t.IsAdmittedEpoch(e); (void)f.t.IsAdmittedDevice(1); (void)f.t.TargetOpen();
                    f.t.ObservePose(1, (reads.fetch_add(1) & 3) != 0);
                }
            });
        }
        for (int cycle = 0; cycle < 2000; ++cycle) {
            f.Arm();
            if (f.Begin()) { f.t.BindHmd(1); f.t.ConfirmHmd(1, true); }
            if (cycle % 3 == 0) f.t.Close();
        }
        stop = true;
        for (auto& th : threads) th.join();
        f.t.Close();
        Check(f.t.State() == TargetState::Closed && f.t.AdmittedDevice() == kInvalidDevice, "state is consistent after concurrent churn");
    }

    std::cout << "GalaxyLinkEpoch: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
