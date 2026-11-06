// Scoped VRLink settings read overlay: the REAL detours installed on the shared
// vtable of a fake IVRSettings, called through a pointer cached BEFORE the hook
// was armed (the way VRLink holds its pointer). Module identity is injected;
// the call-site capture is verified to be a real address inside the calling
// function (captured in the detour, not in a helper).
#include "../src/Driver/Hooking/VrlinkSettingsHook.h"

#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <string>
#include <utility>

static int checks = 0, failures = 0;
static void Check(bool ok, const std::string& what) {
    ++checks;
    if (!ok) { ++failures; std::cerr << "FAIL: " << what << '\n'; }
}

void DriverLog(const char*, ...) {}

// ---- fake shared IVRSettings with in-memory typed values ------------------------
struct Value {
    enum Kind { Bool, Int, Float, Str } kind = Int;
    bool b = false; int32_t i = 0; float f = 0; std::string s;
};
class FakeSettings : public vr::IVRSettings {
public:
    std::map<std::pair<std::string, std::string>, Value> values;
    int writes = 0;
    const char* GetSettingsErrorNameFromEnum(vr::EVRSettingsError) override { return "fake"; }
    void SetBool(const char*, const char*, bool, vr::EVRSettingsError* e = nullptr) override { ++writes; if (e) *e = vr::VRSettingsError_None; }
    void SetInt32(const char*, const char*, int32_t, vr::EVRSettingsError* e = nullptr) override { ++writes; if (e) *e = vr::VRSettingsError_None; }
    void SetFloat(const char*, const char*, float, vr::EVRSettingsError* e = nullptr) override { ++writes; if (e) *e = vr::VRSettingsError_None; }
    void SetString(const char*, const char*, const char*, vr::EVRSettingsError* e = nullptr) override { ++writes; if (e) *e = vr::VRSettingsError_None; }
    void RemoveSection(const char*, vr::EVRSettingsError* e = nullptr) override { ++writes; if (e) *e = vr::VRSettingsError_None; }
    void RemoveKeyInSection(const char*, const char*, vr::EVRSettingsError* e = nullptr) override { ++writes; if (e) *e = vr::VRSettingsError_None; }
    bool GetBool(const char* s, const char* k, vr::EVRSettingsError* e = nullptr) override {
        const Value* v = Find(s, k, Value::Bool, e); return v ? v->b : false;
    }
    int32_t GetInt32(const char* s, const char* k, vr::EVRSettingsError* e = nullptr) override {
        const Value* v = Find(s, k, Value::Int, e); return v ? v->i : 0;
    }
    float GetFloat(const char* s, const char* k, vr::EVRSettingsError* e = nullptr) override {
        const Value* v = Find(s, k, Value::Float, e); return v ? v->f : 0.0f;
    }
    void GetString(const char* s, const char* k, char* out, uint32_t len, vr::EVRSettingsError* e = nullptr) override {
        const Value* v = Find(s, k, Value::Str, e);
        if (!out || !len) return;
        const std::string text = v ? v->s : std::string();
        const size_t n = text.size() < len - 1 ? text.size() : len - 1;
        std::memcpy(out, text.data(), n);
        out[n] = '\0';
    }
    void SetValue(const char* s, const char* k, Value v) { values[{ s, k }] = std::move(v); }
private:
    const Value* Find(const char* s, const char* k, Value::Kind kind, vr::EVRSettingsError* e) {
        auto it = values.find({ s ? s : "", k ? k : "" });
        if (it == values.end()) { if (e) *e = vr::VRSettingsError_UnsetSettingHasNoDefault; return nullptr; }
        if (it->second.kind != kind) { if (e) *e = vr::VRSettingsError_ReadFailed; return nullptr; }
        if (e) *e = vr::VRSettingsError_None;
        return &it->second;
    }
};

static Value B(bool v) { Value x; x.kind = Value::Bool; x.b = v; return x; }
static Value I(int32_t v) { Value x; x.kind = Value::Int; x.i = v; return x; }
static Value F(float v) { Value x; x.kind = Value::Float; x.f = v; return x; }
static Value S(const char* v) { Value x; x.kind = Value::Str; x.s = v; return x; }

// ---- "call sites": noinline functions the detour sees as the return address ------
static const void* g_lastCaller = nullptr;
static bool g_vrlinkCaller = false;
static bool Validator(const void* address) noexcept {
    g_lastCaller = address;
    return g_vrlinkCaller;
}
// A tiny dedicated call site: the detour's _ReturnAddress must land inside it.
static volatile int32_t g_siteSink = 0;
static __declspec(noinline) void VrlinkSite(vr::IVRSettings* api) {
    g_siteSink = api->GetInt32("driver_vrlink", "targetBandwidth", nullptr); // not a tail call
    g_siteSink = g_siteSink + 1;
}
template <class Fn>
static __declspec(noinline) void CallAsVrlink(Fn fn) { g_vrlinkCaller = true; fn(); g_vrlinkCaller = false; }
template <class Fn>
static __declspec(noinline) void CallAsForeign(Fn fn) { g_vrlinkCaller = false; fn(); }

// fake "driver_vrlink.dll image" used for BeginHmd evidence (vtable slot / caller)
static unsigned char fakeImage[64];
struct FakeDrv { void** vt; };
static const void* ReadFakeSlot(void* o) noexcept { return static_cast<FakeDrv*>(o)->vt[0]; }
static bool RealishValidator(const void* a) noexcept {
    g_lastCaller = a;
    return g_vrlinkCaller || (a >= fakeImage && a < fakeImage + sizeof(fakeImage));
}

static bool admittedFlag = false;
static bool AdmittedSeam() noexcept { return admittedFlag; }
static int overlayReports = 0;
static void Observer(const char*, const char*) { ++overlayReports; }

struct Snapshot {
    bool b; int32_t i; float f; std::string s; vr::EVRSettingsError eb, ei, ef, es;
    bool operator==(const Snapshot& o) const {
        return b == o.b && i == o.i && f == o.f && s == o.s && eb == o.eb && ei == o.ei && ef == o.ef && es == o.es;
    }
};
static Snapshot ReadAll(vr::IVRSettings* api, const char* section, const char* key) {
    Snapshot r{};
    r.eb = r.ei = r.ef = r.es = vr::VRSettingsError_JsonParseFailed;
    r.b = api->GetBool(section, key, &r.eb);
    r.i = api->GetInt32(section, key, &r.ei);
    r.f = api->GetFloat(section, key, &r.ef);
    char buffer[64] = {};
    api->GetString(section, key, buffer, sizeof(buffer), &r.es);
    r.s = buffer;
    return r;
}

int main() {
    namespace hook = gxr::vrlinksettings;
    FakeSettings fake;
    FakeSettings pristine; // never hooked: the byte-for-byte oracle for original behaviour
    vr::IVRSettings* cachedByVrlink = &fake; // the pointer VRLink cached during ITS init

    auto populate = [](FakeSettings& s) {
        s.SetValue("driver_vrlink", "targetBandwidth", I(100));
        s.SetValue("driver_vrlink", "automaticBandwidth", B(true));
        s.SetValue("driver_vrlink", "backoffRecoveryCoefficient", F(0.25f));
        s.SetValue("driver_vrlink", "customFlag", I(7));
        s.SetValue("driver_vrlink", "enable", B(true));
        s.SetValue("driver_vrlink", "hasBeenRun", B(true));
        s.SetValue("driver_vrlink", "maxVideoQueueLatencyUs", I(5000));
        s.SetValue("driver_vrlink", "encodeWidth", S("not-a-number"));
        s.SetValue("vrlink_xrvst2ue", "targetBandwidth", I(350));
        s.SetValue("vrlink_xrvst2ue", "automaticBandwidth", B(false));
        s.SetValue("vrlink_xrvst2ue", "backoffRecoveryCoefficient", F(0.75f));
        s.SetValue("vrlink_xrvst2ue", "customFlag", I(9));
        s.SetValue("vrlink_xrvst2ue", "enable", B(false));
        s.SetValue("vrlink_xrvst2ue", "hasBeenRun", B(false));
        s.SetValue("vrlink_xrvst2ue", "unrelatedKey", I(11));
        s.SetValue("vrlink_xrvst2ue", "maxVideoQueueLatencyUs", S("wrong-type"));
        s.SetValue("vrlink_xrvst2ue", "encodeWidth", I(4096));
        s.SetValue("vrlink_xrvst2ue", "streamFormatWidth", I(2048));
        s.SetValue("vrlink_xrvst2ue", "displayFrequency", S("90 Hz"));
        s.SetValue("vrlink_Quest", "targetBandwidth", I(777));
        s.SetValue("steamvr", "targetBandwidth", I(55));
    };
    populate(fake);
    populate(pristine);

    // Module identity is injected; the global tracker doubles as the real admission state.
    auto& tracker = gxr::galaxylink::detail::Global();
    tracker.addressValidator = &Validator;
    hook::S().admitted = &AdmittedSeam;
    hook::S().observer = &Observer;

    // ---- install on the shared vtable AFTER the pointer was cached ----------
    Check(hook::Install(&fake), "install on the shared IVRSettings vtable");
    Check(hook::Install(&fake), "install is idempotent");

    // ---- not admitted: every caller gets the original ------------------------
    admittedFlag = false;
    {
        Snapshot expected = ReadAll(&pristine, "driver_vrlink", "targetBandwidth");
        Snapshot got{};
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got == expected && got.i == 100, "no admitted epoch: a vrlink caller reads the shared value");
        Check(overlayReports == 0, "no overlay report without an overlay");
    }

    // ---- admitted + exact vrlink caller: overlay through the cached pointer ------
    admittedFlag = true;
    {
        int32_t bandwidth = 0; bool automatic = true; float coefficient = 0; vr::EVRSettingsError e1{}, e2{}, e3{};
        CallAsVrlink([&] {
            bandwidth = cachedByVrlink->GetInt32("driver_vrlink", "targetBandwidth", &e1);
            automatic = cachedByVrlink->GetBool("driver_vrlink", "automaticBandwidth", &e2);
            coefficient = cachedByVrlink->GetFloat("driver_vrlink", "backoffRecoveryCoefficient", &e3);
        });
        Check(bandwidth == 350 && e1 == vr::VRSettingsError_None, "cached pointer sees the scoped int overlay");
        Check(automatic == false && e2 == vr::VRSettingsError_None, "cached pointer sees the scoped bool overlay");
        Check(coefficient == 0.75f && e3 == vr::VRSettingsError_None, "float overlay keeps its float value");
        Check(overlayReports == 3, "each overlaid key is reported once");
        CallAsVrlink([&] { cachedByVrlink->GetInt32("driver_vrlink", "targetBandwidth", nullptr); });
        Check(overlayReports == 3, "a repeated overlaid key is not reported again");
        Check(g_lastCaller != nullptr, "the detour captured a real call-site address");
    }
    {
        // the captured address lies inside the CALLING function (VrlinkSite),
        // i.e. it was taken in the detour itself and is the real return address
        g_vrlinkCaller = true;
        VrlinkSite(cachedByVrlink);
        g_vrlinkCaller = false;
        const auto site = reinterpret_cast<uintptr_t>(&VrlinkSite);
        const auto captured = reinterpret_cast<uintptr_t>(g_lastCaller);
        Check(captured > site && captured < site + 0x100, "the recorded caller is the real return address inside the calling function");
    }
    {
        char buffer[16]; std::memset(buffer, 'Z', sizeof(buffer)); vr::EVRSettingsError e = vr::VRSettingsError_JsonParseFailed;
        fake.SetValue("vrlink_xrvst2ue", "displayFrequency", S("ninety-hertz-long"));
        hook::SetExpertKeys({ "displayFrequency" });
        CallAsVrlink([&] { cachedByVrlink->GetString("driver_vrlink", "displayFrequency", buffer, 8, &e); });
        Check(e == vr::VRSettingsError_None && std::strcmp(buffer, "ninety-") == 0, "string overlay is truncated and terminated at the buffer length");
        Check(buffer[8] == 'Z' && buffer[15] == 'Z', "bytes past the caller's buffer length are untouched");
        // zero/one byte buffers and null buffer
        char one[2] = { 'Q', 'Q' };
        CallAsVrlink([&] { cachedByVrlink->GetString("driver_vrlink", "displayFrequency", one, 1, nullptr); });
        Check(one[0] == '\0' && one[1] == 'Q', "one-byte buffer receives only the terminator (null error pointer accepted)");
        char zero[2] = { 'Q', 'Q' };
        CallAsVrlink([&] { cachedByVrlink->GetString("driver_vrlink", "displayFrequency", zero, 0, nullptr); });
        Check(zero[0] == 'Q' && zero[1] == 'Q', "zero-length buffer is never written");
        CallAsVrlink([&] { cachedByVrlink->GetString("driver_vrlink", "displayFrequency", nullptr, 16, nullptr); });
        Check(true, "null buffer does not crash");
    }

    // ---- lifecycle keys, other sections, unknown keys, absent, mismatch ----------
    {
        Snapshot lifecycle{}, expected = ReadAll(&pristine, "driver_vrlink", "enable");
        CallAsVrlink([&] { lifecycle = ReadAll(cachedByVrlink, "driver_vrlink", "enable"); });
        Check(lifecycle == expected && lifecycle.b == true, "lifecycle key enable is never overlaid");
        Snapshot ran{}, expectedRan = ReadAll(&pristine, "driver_vrlink", "hasBeenRun");
        CallAsVrlink([&] { ran = ReadAll(cachedByVrlink, "driver_vrlink", "hasBeenRun"); });
        Check(ran == expectedRan && ran.b == true, "lifecycle key hasBeenRun is never overlaid");
        Snapshot other{}, expectedOther = ReadAll(&pristine, "steamvr", "targetBandwidth");
        CallAsVrlink([&] { other = ReadAll(cachedByVrlink, "steamvr", "targetBandwidth"); });
        Check(other == expectedOther && other.i == 55, "other sections are never overlaid");
        Snapshot quest{}, expectedQuest = ReadAll(&pristine, "vrlink_Quest", "targetBandwidth");
        CallAsVrlink([&] { quest = ReadAll(cachedByVrlink, "vrlink_Quest", "targetBandwidth"); });
        Check(quest == expectedQuest && quest.i == 777, "a foreign vrlink_<model> read is untouched");
        Snapshot unknown{}, expectedUnknown = ReadAll(&pristine, "driver_vrlink", "customFlag");
        CallAsVrlink([&] { unknown = ReadAll(cachedByVrlink, "driver_vrlink", "customFlag"); });
        Check(unknown == expectedUnknown && unknown.i == 7, "a key that is neither routed nor an explicit expert entry is untouched");
        hook::SetExpertKeys({ "customFlag" });
        CallAsVrlink([&] { unknown = ReadAll(cachedByVrlink, "driver_vrlink", "customFlag"); });
        Check(unknown.i == 9, "an explicit expert entry that exists in the canonical profile is overlaid");
        hook::SetExpertKeys({ "neverWritten" });
        Snapshot absent{}, expectedAbsent = ReadAll(&pristine, "driver_vrlink", "neverWritten");
        CallAsVrlink([&] { absent = ReadAll(cachedByVrlink, "driver_vrlink", "neverWritten"); });
        Check(absent == expectedAbsent, "an explicit key absent from the canonical profile falls through to the exact original");
        hook::SetExpertKeys({});
        Snapshot unrelated{}, expectedUnrelated = ReadAll(&pristine, "driver_vrlink", "unrelatedKey");
        CallAsVrlink([&] { unrelated = ReadAll(cachedByVrlink, "driver_vrlink", "unrelatedKey"); });
        Check(unrelated == expectedUnrelated, "unrelated canonical key does not leak into driver_vrlink");
        // type mismatch: canonical holds a string, vrlink asks an int -> original (shared) value and error
        Snapshot mismatch{}, expectedMismatch = ReadAll(&pristine, "driver_vrlink", "maxVideoQueueLatencyUs");
        CallAsVrlink([&] { mismatch = ReadAll(cachedByVrlink, "driver_vrlink", "maxVideoQueueLatencyUs"); });
        Check(mismatch.i == expectedMismatch.i && mismatch.ei == expectedMismatch.ei && mismatch.i == 5000
            && mismatch.b == expectedMismatch.b && mismatch.eb == expectedMismatch.eb,
            "canonical type mismatch preserves the original value and error semantics for the mismatched typed read");
        // canonical int, shared string: only the typed read that exists in canonical overlays
        Snapshot widthRead{}, expectedWidth = ReadAll(&pristine, "driver_vrlink", "encodeWidth");
        CallAsVrlink([&] { widthRead = ReadAll(cachedByVrlink, "driver_vrlink", "encodeWidth"); });
        Check(widthRead.ei == vr::VRSettingsError_None && widthRead.i == 4096, "the typed read with a canonical value overlays");
        Check(widthRead.eb == expectedWidth.eb && widthRead.b == expectedWidth.b, "other typed reads of the same key keep the original answer");
    }

    // ---- foreign callers: byte-identical results and errors ---------------------
    {
        for (const char* key : { "targetBandwidth", "automaticBandwidth", "backoffRecoveryCoefficient", "enable", "customFlag", "encodeWidth", "maxVideoQueueLatencyUs", "missingKey" }) {
            Snapshot expected = ReadAll(&pristine, "driver_vrlink", key), got{};
            CallAsForeign([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", key); });
            Check(got == expected, std::string("foreign caller reads the original value/error for ") + key);
        }
    }

    // ---- unknown / disconnected / other epoch denies --------------------------------
    {
        tracker.Close();
        admittedFlag = false;
        hook::S().admitted = nullptr; // use the REAL admission state from here on
        Snapshot got{};
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 100, "no open epoch (real tracker): original value");
        {
            // handshake-only / unbound state denies too
            const char* sess = gxr::galaxylink::kSessionFormat;
            gxr::galaxylink::ObserveLog(gxr::galaxylink::kSessionFormat, sess, std::strlen(sess));
            const char* pr = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: S (1)";
            gxr::galaxylink::ObserveLog(gxr::galaxylink::kPropsFormat, pr, std::strlen(pr));
            CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
            Check(got.i == 100, "handshake-only (no HMD add) state denies");
            tracker.Close();
        }

        static void* vtable[1] = { fakeImage };
        static FakeDrv drv{ vtable };
        tracker.vtableReader = &ReadFakeSlot;
        tracker.addressValidator = &RealishValidator;
        const char* session = gxr::galaxylink::kSessionFormat;
        gxr::galaxylink::ObserveLog(gxr::galaxylink::kSessionFormat, session, std::strlen(session));
        const char* props = "ReceivedHMDStaticProps. Model Number: xrvst2ue, Serial Number: S (1)";
        gxr::galaxylink::ObserveLog(gxr::galaxylink::kPropsFormat, props, std::strlen(props));
        Check(gxr::galaxylink::BeginHmd(&drv, fakeImage + 4), "real tracker: provisional epoch");
        gxr::galaxylink::BindHmd(2);
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 350, "provisional epoch overlays reads made inside the original Activate (before Confirm)");
        CallAsForeign([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 100, "provisional epoch never affects a foreign caller");
        gxr::galaxylink::ConfirmHmd(2, true);
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 350, "admitted epoch overlays for the exact vrlink caller");
        CallAsForeign([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 100, "admitted epoch does not affect a foreign caller on the same object");
        gxr::galaxylink::ObservePose(2, false);
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 100, "the disconnected edge denies the overlay immediately");
        tracker.Close();
    }

    // ---- no writes ever ----------------------------------------------------------------
    Check(fake.writes == 0, "no setter or removal was ever reached through the overlay path");

    // ---- uninstall restores the original vtable ---------------------------------------
    hook::S().admitted = &AdmittedSeam;
    admittedFlag = true;
    hook::Uninstall();
    {
        Snapshot got{};
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 100, "after uninstall the shared getters are the originals again");
    }
    Check(hook::Install(&fake), "re-install after uninstall");
    {
        Snapshot got{};
        CallAsVrlink([&] { got = ReadAll(cachedByVrlink, "driver_vrlink", "targetBandwidth"); });
        Check(got.i == 350, "re-installed hook overlays again");
    }
    hook::Uninstall();

    // ---- pin failure, changed slots, foreign chains -----------------------------------------------------------------
    {
        struct Fake2 : FakeSettings { const char* GetSettingsErrorNameFromEnum(vr::EVRSettingsError) override { return "fake2"; } };
        Fake2 other; populate(other);
        vr::IVRSettings* api = &other;
        void** vt = *reinterpret_cast<void***>(api);
        void* const pristineGetInt32 = vt[hook::kSlotGetInt32];
        hook::S().pinned = false; // the earlier install already pinned this process
        hook::S().pin = +[]() { return false; };
        Check(!hook::Install(api), "a failed module pin refuses the install");
        Check(vt[hook::kSlotGetInt32] == pristineGetInt32, "refused install leaves every slot untouched");
        hook::S().pin = +[]() { return true; };
        Check(hook::Install(api), "install succeeds once the pin succeeds");
        Check(vt[hook::kSlotGetInt32] != pristineGetInt32, "slot is detoured");
        // another party hooks the same slot AFTER us and chains through our detour
        static void* chained = nullptr;
        chained = vt[hook::kSlotGetInt32];
        struct Foreign {
            static int32_t Hook(vr::IVRSettings* self, const char* s, const char* k, vr::EVRSettingsError* e) {
                return reinterpret_cast<hook::GetInt32Fn>(chained)(self, s, k, e) + 1000;
            }
        };
        Check(hook::PatchSlotIf(vt, hook::kSlotGetInt32, chained, reinterpret_cast<void*>(&Foreign::Hook)), "a foreign party replaces the slot after us");
        void* const foreignHook = vt[hook::kSlotGetInt32];
        hook::Install(api); // must not clobber the foreign replacement
        Check(vt[hook::kSlotGetInt32] == foreignHook, "re-install leaves a foreign replacement in place");
        hook::Uninstall();
        Check(vt[hook::kSlotGetInt32] == foreignHook, "uninstall leaves a foreign replacement in place");
        Check(vt[hook::kSlotGetBool] != nullptr && vt[hook::kSlotGetBool] != reinterpret_cast<void*>(&hook::DetourGetBool), "uninstall restores the slots that are still ours");
        admittedFlag = true;
        int32_t chainedValue = 0;
        CallAsForeign([&] { chainedValue = api->GetInt32("driver_vrlink", "targetBandwidth", nullptr); });
        Check(chainedValue == 1100, "the foreign chain through our retained detour still forwards the exact original (no default 0)");
        CallAsVrlink([&] { chainedValue = api->GetInt32("driver_vrlink", "targetBandwidth", nullptr); });
        Check(chainedValue == 1350, "and a vrlink caller still gets the scoped overlay through that chain");
        hook::S().pin = nullptr;
    }
    std::cout << "VrlinkSettingsHook: " << checks << " checks, " << failures << " failures\n";
    return failures ? 1 : 0;
}
