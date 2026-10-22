#pragma once
#include <windows.h>
#include <atomic>
#include <mutex>
#include <cstdint>
#include <string>

// ============================================================================
// NvencTap — hook on vrlink's NVENC usage (nvEncodeAPI64.dll), rebuilt
// 2026-08-27 as an ACTIVE tap. Field motivation (driver_vrlink.txt, runs 1-3):
//
//   * every nvEncReconfigureEncoder at 3072-wide frames fails with
//     NV_ENC_ERR_INVALID_PARAM ("NVENC: Invalid Level", 100-300x per
//     session) -> vrlink cannot adjust bitrate after init at all.
//   * vrlink clamps the encoder request to avg 350 / max 402.5 Mbit/s no
//     matter what targetBandwidth says (run 3: 600 requested, 350 sent).
//   * the stream is 8-bit HEVC ("Using 10bit mode: 0").
//
// Mechanism: MinHook on NvEncodeAPICreateInstance; the returned caller-
// owned function list has its nvEncInitializeEncoder / nvEncReconfigure-
// Encoder / nvEncRegisterResource / nvEncEncodePicture entries replaced by
// shims. Layouts come from the vendored ThirdParty/nvenc/nvEncodeAPI.h
// (MIT, FFmpeg nv-codec-headers) and every struct is version-gated.
//
// Safety contract:
//   1. overrides are applied to vrlink's structs IN PLACE, the original
//      bytes are snapshotted first, and the original bytes are RESTORED
//      after the call regardless of outcome. vrlink never sees its own
//      config mutated; every reconfigure re-derives the override from
//      whatever vrlink asked for (stateless).
//   2. explicit overrides fail with their actual NVENC status. Never retry
//      another codec or discard user settings after a rejection.
//   3. unsupported structures with explicit settings fail visibly; disabled
//      sessions remain passthrough except required lifetime ABI adaptation.
//   4. initialization without an explicit encodeConfig is valid NVENC usage
//      (a preset-defaults request): observe-only after active-geometry
//      validation; no codec substitution runs on that path. Initialization
//      allocation geometry may differ from the packed picture geometry.
//
// Install timing: TryInstall() pre-loads nvEncodeAPI64.dll itself and hooks
// it, so vrlink's later LoadLibrary finds the hooked export. Call it from
// driver Init so the hook precedes headset connect.
// ============================================================================

struct NvencTapConfig {
	bool enabled = false;
	// Transient parser validation failure; never serialize this as a setting.
	std::string requestError;
	// set hevcConfig.level = AUTOSELECT and tier = HIGH on init and every
	// reconfigure. fixes the Invalid Level reconfigure failures.
	bool fixLevel = true;
	// 2026-10-13: stream codec override. 0 = leave (vrlink's HEVC), 1 = H.264,
	// 2 = AV1. applied at init and every reconfigure by
	// rewriting encodeGUID / profileGUID / the codec config; H.264 gets the
	// High-profile 8-bit client class via the caps shim
	// while AV1 follows the session input depth (10-bit when the SDR 10-bit
	// baseline is on); every HEVC-only override below skips itself via
	// snap.hevc. paired with the Steam Link client "Codecs Support" patch and
	// streamFrame.nvencCodec.
	int codec = 0;
	// Explicit stream geometry; vendor maximum-dimension probes describe its
	// session allocation envelope after validating real selected-codec caps.
	int effectiveTileWidth = 1536;
	// Galaxy XR requires exact four-tile active pictures/reconfiguration;
	// initial allocation may differ. Neutral/legacy callers remain unchanged.
	bool enforceTile = false;
	// 0 = leave vrlink's bitrate alone. otherwise averageBitRate is
	// replaced by this (Mbit/s), maxBitRate by 1.15x, vbvBufferSize scaled
	// by the same ratio as the average. lifts the 350 Mbit/s clamp.
	int bitrateMbit = 0;
	// 0 = leave. otherwise enableMaxQP and set maxQP (P/B/I) to this value:
	// a ceiling on how coarsely any block may be quantized, the lever
	// against dark flat regions being crushed to the black floor.
	int maxQp = 0;
	// 0 = leave. 1..15 enable spatial AQ with this strength.
	int aqStrength = 0;
	// 0 = leave. else enableMinQP with this floor (1..51). run G2: the IDR
	// after every encoder reset came out at avgQP 8-9 and 3.5-5.4 MB, over
	// vrlink's ~2 MB send limit ("Packet too big" death loop). a floor of
	// ~14-18 stops near-lossless frames from ballooning.
	int minQp = 0;
	// 0 = same as minQp. else a separate floor for intra (IDR/I) frames.
	// vrlink's send limit is exactly 2 MB per frame; a 3200x8192 IDR at
	// QP 16 is 2.3 MB, at QP 23-24 it is 1.45 MB. so P-frames can keep a
	// low floor while intra frames get ~24.
	int minQpIntra = 0;
	// force CBR + lowDelayKeyFrameScale=1: NVENC's low-latency mode, the
	// one in which VBV is honoured on key frames (VBR ignores it right
	// after a reinit). the second lever against the reset-IDR fault.
	bool forceCbr = false;
	// with forceCbr: I-frame bits as a multiple of P-frame bits
	// (NV_ENC_RC_PARAMS::lowDelayKeyFrameScale). 1 = the reset IDR gets one
	// frame's budget (Q1/R runs: ~1.0 MB at QP 34-48, visibly soft for a few
	// frames after every reset; vrlink's watchdog resets 3-5x/s while an app
	// loads, so that softness is what the user sees during that phase).
	// 2 = IDR up to two frame budgets, still under the VBV of vbvFrames=2.
	int lowDelayKfScale = 1;
	// peak headroom over the average, percent. vrlink uses 15. run C died
	// with "FAULT: Packet too big" at 500 Mbit: a single (IDR) frame
	// exceeded vrlink's send limit. 0 = max == avg (flatter frames).
	int maxBitrateHeadroomPct = 15;
	// 0 = leave vbv alone. else vbvBufferSize = avg/fps * N frames, which
	// bounds the size of any one frame (the other lever against the
	// packet-too-big fault). vrlink's own value wanders 0.9..33 Mbit.
	// 2026-09-03: fps here is forceFps when set, else the NOMINAL 90, never
	// vrlink's per-call frameRateNum (see forceFps).
	int vbvFrames = 0;
	// 2026-09-03 runs 1/2: vrlink reconfigures the encoder before EVERY
	// frame (reconf count == encode count) and passes an instantaneous
	// frameRateNum: 90, 89, 57, 27, 15... it collapses while the stream
	// hitches. CBR's per-frame budget and any fps-derived VBV are
	// avg/fps, so a hitch made the budget balloon (450 Mbit / 15 fps x 2
	// frames = 7.5 MB VBV -> the 7.02 MB reset IDR of run 2 -> Packet too
	// big -> reset -> more hitching): a positive feedback loop. QP floors
	// were stable only because they are fps-independent. 0 = leave. else
	// frameRateNum/Den are forced to N/1 on init and every reconfigure so
	// the per-frame budget is constant. an HMD stream has one nominal
	// rate; frames that are not sent simply cost nothing.
	int forceFps = 0;
	// 2026-10-19 bitrate curve: how vrlink's request maps onto bitrateMbit.
	// 0 = linear (the pre-curve mapping: target = B * request / clamp),
	// 1 = power knee, 2 = soft knee (see CurveMath.h). constancy 0..100
	// lifts the selected curve toward the ceiling: 0 = the curve itself,
	// 100 = constant ceiling (the retired nvencBitrateScale=false).
	int bitrateCurve = 0;
	int bitrateConstancyPct = 0;
	// the encoder ceiling vrlink applies to its own request (run 3: 600
	// asked, 350 sent). the reference point for every curve.
	int vrlinkClampMbit = 350;
	// 2026-10-16: explicit H.264 tuning; zero GOP/IDR derives rational fps,
	// -1 preserves the caller. Other fields use their documented NVENC values.
	int h264GopFrames = 0, h264IdrFrames = 0;
	int h264RefFrames = 3, h264Entropy = 0;
	int h264SliceMode = 3, h264SliceData = 1;
	bool h264Aud = true, h264RepeatHeaders = true, h264DisableHeaders = false;
	bool h264BitstreamRestriction = true;
	int h264VbvInitialDelay = 0;
	// -1 uses preset/codec defaults; explicit 0/1/2 always wins.
	int multiPass = -1;
	bool postPackEnabled = false, postPackLimitedRange = false;
	// 0 = leave preset alone. 1..7 = NV_ENC_PRESET_P1..P7 (vrlink uses P2
	// with ultra-low-latency tuning; VD-class quality at equal bitrate
	// comes from higher presets). applied at init AND every reconfigure so
	// the two agree. costs encode time; watch driver_vrlink's encode ms.
	int preset = 0;
	// v3: with preset == 0, pick by NVENC engine count once it is known
	// (NV_ENC_CAPS_NUM_ENCODER_ENGINES at init): 3+ -> P7, 2 -> P5, 1 -> P4.
	// unknown (0) leaves vrlink's P2. resolves the "weaker GPU" problem
	// without a GPU table: P7 needs the split across 3 engines to hold 90.
	bool presetAuto = false;
	// 2026-08-30: swapping presetGUID alone is NOT a full preset change.
	// nvEncodeAPI.h (NV_ENC_INITIALIZE_PARAMS docs): with an explicit
	// encodeConfig the presetGUID "will not override the custom config
	// structure but will be used to determine other Encoder HW specific
	// parameters not exposed in the API". so the GUID swap only moves the
	// hardware-internal effort knobs; the visible config (multiPass, AQ,
	// refs) stays vrlink's P2-derived one. with presetMerge on, the tap
	// queries nvEncGetEncodePresetConfigEx(preset, vrlink's own tuning)
	// and adopts a whitelist from the canonical preset config: multiPass,
	// temporal AQ, spatial AQ (only if aqStrength is not set manually/by
	// tier), and HEVC DPB ref count. rc mode, bitrates, gop/idr, slices,
	// VUI, level and bit depth stay vrlink's. lookahead is never adopted
	// (latency); if the preset wanted it, that is logged only. the full
	// vrlink-vs-preset field diff is logged once per session.
	bool presetMerge = true;
	// -1 = leave. 0/1 = force hevcVUIParameters.videoFullRangeFlag. vrlink
	// signals fullRange=1 with matrix=0 (GBR identity!) primaries=9,
	// transfer=4; flipping the range flag tells us whether the client even
	// honours VUI, and if it does, which side the black floor is on.
	int vuiFullRange = -1;
	// -1 = leave. else force VUI colourMatrix / colourPrimaries / transfer
	// characteristics. run L proved the client honours VUI (flipping the
	// range flag visibly changed contrast), and vrlink's stock signalling
	// is incoherent: matrix=0 (identity/GBR!) primaries=9 transfer=4 on
	// 4:2:0 BT.709-converted content. the decoder must be guessing; a
	// wrong guess on matrix or transfer is exactly a lifted/crushed black
	// floor. sensible probes: matrix 1 (BT.709), transfer 1 (BT.709) or
	// 13 (sRGB), primaries 1 (BT.709).
	int vuiMatrix = -1;
	int vuiPrimaries = -1;
	int vuiTransfer = -1;
	// 2026-09-04 SPLIT-FRAME ENCODING (research slice). facts (NVENC
	// programming guide 13.0 s8.14 + the 11.1/12.1/13.1 headers):
	//   * the driver splits a frame across NVENC engines IMPLICITLY when
	//     NVENCs >= 2, HEVC height >= 2112, and preset/tuning is P1..P4 at
	//     LL/ULL (P5..P7: never). our frames are 6144/8192 tall at ULL, so
	//     P1..P4 already run split and P5..P7 do not: that is the P4 -> P5
	//     cliff (87 fps vs 50 fps at 2048x8192 on the 5090's 3 engines).
	//   * explicit control needs NV_ENC_INITIALIZE_PARAMS::splitEncodeMode,
	//     4 bits carved from reserved bitfield space in SDK 12.1 (struct
	//     v6). vrlink is SDK 11.1 (init v5, config v7).
	//   * 09-04 run U0: passing 12.1-versioned init/config structs into
	//     vrlink's 11.1 session -> NV_ENC_ERR_INVALID_VERSION (15). the
	//     runtime validates every struct against the apiVersion given at
	//     nvEncOpenEncodeSessionEx. so the tap now UPGRADES THE SESSION:
	//     it opens it as 12.1 and re-tags the version word of every struct
	//     vrlink passes afterwards (11.1 -> 12.1 digits), restoring the
	//     words after each call. this is sound because every 11.1 struct
	//     is byte-compatible with its 12.1 form (all additions are carved
	//     from reserved padding; zero = off) - verified by compiling both
	//     headers - EXCEPT two that GREW: NV_ENC_PIC_PARAMS (3344->3360)
	//     and NV_ENC_LOCK_BITSTREAM (1544->1552). those are copied into a
	//     larger scratch struct for the call (and copied back for the
	//     [out] lock struct) so the driver never touches memory past
	//     vrlink's allocation. the function list version is presented as
	//     12.1 too (same size; 12.1 only appends pointers).
	//     if the required upgrade is rejected, return that error without an
	//     older-API fallback. AV1 upgrades independently of split preference.
	//     Before the first config publish the open decision consults the same
	//     settings.json probe as the caps shim, mirroring the ConfigLoader
	//     parse (missing nvencTap -> true, nvencCodec -> 0, nvencSplitMode ->
	//     1). A genuinely rejected 12.1 open or function list keeps failing
	//     visibly (PublishFailure plus a one-shot log with the NVENC status);
	//     no pristine open, no silent downgrade latch.
	//   * split degrades quality a little (independent strips); the payoff
	//     is P5..P7 at full frame rate, and possibly 3 strips instead of
	//     the driver's implicit choice for P1..P4.
	// 0 = leave (implicit mode). 1 = AUTO_FORCED, 2/3/4 = forced strips,
	// 15 = disable split entirely (probe: proves whether implicit split is
	// active for P2 by watching engine time in CBR mode).
	int splitMode = 0;
	// 2026-09-05 foveated bit allocation (OPTION, off by default). NVENC
	// takes a signed QP delta per 32x32 block with every frame
	// (NV_ENC_PIC_PARAMS::qpDeltaMap, rcParams.qpMapMode = DELTA). the
	// fovea tile gets qpFovea (<= 0), the periphery qpPeriphery (>= 0),
	// with the same edge ramp as the post-pack CAS; rate control still
	// hits the CBR budget, so bits move from the stretched periphery into
	// the 1:1 gaze cut-out. too much makes saccades "pop" (the eye lands
	// on periphery-quality pixels until the box catches up).
	int qpFovea = 0;        // -10..0
	int qpPeriphery = 0;    //   0..10
	float qpEdgeFalloff = 0.12f; // fraction of the tile for the ramp
	bool qpFoveaTop = true;
	// log every reconfigure (not just the first few) and hex-dump structs.
	bool verbose = false;
};

struct NvencTapStats {
	uint32_t initCalls = 0, initOverridden = 0, initFailedThenPristineOk = 0, initFailed = 0;
	uint32_t reconfCalls = 0, reconfOverridden = 0, reconfFailedThenPristineOk = 0, reconfFailed = 0;
	uint32_t reconfFailedStock = 0; // failed with overrides disabled: the stock Invalid Level count
	uint32_t registerCalls = 0, encodeCalls = 0;
	// encoded frame sizes (from nvEncLockBitstream): the "Packet too big"
	// fault is a vrlink send limit on one encoded frame; these locate it.
	uint32_t lockCalls = 0;
	uint32_t maxFrameBytes = 0, maxFrameBytesIdr = 0, lastFrameBytes = 0;
	uint32_t idrFrames = 0;
	uint32_t sizeBucket[7] = {0,0,0,0,0,0,0}; // <256K <512K <1M <1.5M <2M <4M >=4M
	uint32_t lastAvgQp = 0, maxAvgQp = 0;
	uint64_t sumFrameBytes = 0;
	// encode latency: nvEncEncodePicture submit -> nvEncLockBitstream
	// return, per frame, in ms. preset/AQ triage metric (vrlink's perf
	// warnings only count frames over a threshold).
	uint32_t latSamples = 0;
	double latSumMs = 0, latMaxMs = 0;
	uint32_t latBucket[6] = {0,0,0,0,0,0}; // <5 <8 <11 <16 <33 >=33 ms
	uint32_t apiMajor = 0;
	// per-heartbeat-interval view (zeroed by MaybeHeartbeat): what vrlink
	// ASKED for (averageBitRate before our override, in Mbit) and the
	// encode latency in this interval only. run Q1 showed vrlink's
	// per-frame request is its real rate control (1..350 Mbit swinging
	// every reconfigure), so the cumulative numbers hid the trend.
	uint32_t ivReqCount = 0; double ivReqSumMbit = 0, ivReqMinMbit = 1e9, ivReqMaxMbit = 0;
	// 2026-10-19: the last five pre-override requests (Mbit), median-filtered
	// by the bitrate curve so one deep one-frame dip cannot drag the target.
	// guarded by statsLock; reset on a fresh init and on an enable transition.
	double reqHist[5] = {0,0,0,0,0};
	uint32_t reqHistCount = 0, reqHistPos = 0;
	bool reqHistEnabled = false;
	uint32_t ivLatSamples = 0, ivLatOver11 = 0; double ivLatSumMs = 0, ivLatMaxMs = 0;
	// how long nvEncEncodePicture itself BLOCKED (submit duration). async
	// encode should return in well under 1 ms; a blocking submit means the
	// encoder input path is waiting (queue full or a D3D dependency on the
	// GPU finishing vrlink's pre-encode work behind the app's render). this
	// is the quantity vrlink's ">10 ms" perf warning + Cause-Mask-0 encoder
	// reset watchdog keys on. submit->lock (the latency above) includes
	// vrlink's own scheduling and is NOT engine time.
	uint32_t ivSubmitSamples = 0, ivSubmitOver10 = 0; double ivSubmitSumMs = 0, ivSubmitMaxMs = 0;
	// 2026-10-21 (S0): real occupancy on the encode path. The 16-slot
	// submits[] table pairs a lock to its submit by bitstream pointer; it is
	// not an occupancy counter and a failed submit used to leave its
	// timestamp behind until the ring wrapped, inflating the latency numbers.
	// inflight = pictures submitted and not yet locked; ivInflightMax is the
	// interval high-water mark.
	uint32_t inflight = 0, ivInflightMax = 0;
	// preset-merge health: fetches of the canonical preset config and the
	// struct version that finally worked (0 = none yet / all rejected)
	uint32_t presetFetchOk = 0, presetFetchFail = 0;
	// split-frame experiment: 0 = not tried, 1 = accepted (12.1 structs
	// taken by the 11.1 session), 2 = rejected (status in splitStatus)
	uint32_t splitState = 0, splitStatus = 0, splitApplied = 0;
	// 0 = no upgrade attempted, 1 = session opened as 12.1, 2 = rejected
	uint32_t sessionUpgrade = 0, sessionUpgradeStatus = 0, retagCalls = 0;
	uint32_t qpMapFrames = 0; // frames submitted with a QP delta map
	uint32_t numEncoderEngines = 0; // NV_ENC_CAPS_NUM_ENCODER_ENGINES (0 = not queried / unknown)
	uint32_t presetCfgVerUsed = 0;
	uint32_t lastAvgBitrate = 0, lastMaxBitrate = 0;
	uint32_t lastWidth = 0, lastHeight = 0;
	uint32_t lastLevel = 0, lastTier = 0, lastBitDepth = 0;
	// colour-depth fix A (2026-10-17): the raw NV_ENC_BUFFER_FORMAT vrlink
	// passed at the last guarded init/reconfigure, unmodified by any override
	// (overrides restore caller bytes and never touch bufferFormat). the
	// heartbeat prints it as the inBf hex class: 0x1 NV12, 0x10000 YUV420_10BIT.
	uint32_t lastInputBufferFormat = 0;
};

// 2026-09-30: passive session evidence, not per-frame encoder instrumentation.
struct NvencTapRuntimeState {
	bool enabled = false;
	bool hookInstalled = false;
	bool upgradedSessionsRemain = false;
	int requestedCodec = 0, effectiveCodec = -1;
	uint32_t lastStatus = 0;
	std::string error;
	// 2026-10-17: first startup allocation/initialization failure of the encoder
	// session. Error text names the phase, distinguishing capability/setup
	// validation from NVIDIA's initialization call.
	// Captured atomically at origin; retries/reconfiguration cannot overwrite
	// it. Matching successful initialization clears it; after destruction,
	// a successful replacement session retires the archived failure too.
	uint32_t lastInitStatus = 0;
	std::string initError;
	uint32_t lastPictureStatus = 0;
	std::string pictureError;
	int effectiveRateControl = -1, effectiveSplit = -1;
	uint32_t encodeWidth = 0, encodeHeight = 0;
};

// 2026-10-21 (S1): the relationship between the encoder ceiling (Bandwidth
// row), VRLink's own request clamp, and the request it currently makes.
// overdrive = the ceiling is above the clamp while the request sits at the
// clamp: the encoder is asked to send more than the streamer requests, so the
// pacer plans for less than it receives. Published for the Companion, which
// shows it and offers an explicit align action; the driver never rewrites the
// user's value.
struct BitratePolicyState {
	bool overdrive = false;
	int ceilingMbit = 0;
	int clampMbit = 0;
	int requestMbit = 0;
	int targetMbit = 0;
};

// 2026-10-21 (S0): admission cadence at the DirectMode shim, i.e. what the
// compositor offers vrlink before any encoding (defined in
// FrameComponentShim.cpp). Returns the interval event count and the worst gap
// between consecutive submissions, then resets both.
void FrameShimCadenceSnapshot(uint32_t* count, double* maxGapMs);

class NvencTap{
public:
	static NvencTap& Get();

	// idempotent, self-throttled (1/s), safe to call every frame
	void TryInstall();
	bool Installed() const { return installed.load(std::memory_order_relaxed); }

	// snapshot the live config for the shims (called from our threads;
	// shims run on vrlink's encode thread and read under the same mutex)
	void SetConfig(const NvencTapConfig &cfg);
	NvencTapConfig GetConfig();
	// 2026-10-16 open-time parity: false until the first SetConfig publish.
	// Before it the shims consult the caps shim's settings.json probe for the
	// open/function-list upgrade decisions and the caps answers as well.
	bool ConfigPublished() const { return cfgPublished.load(std::memory_order_relaxed); }
	NvencTapStats GetStats();
	NvencTapRuntimeState GetRuntimeState();
	BitratePolicyState GetBitratePolicyState();

	// periodic one-line summary to the log while enabled (10 s)
	void MaybeHeartbeat();

private:
	NvencTap() = default;
	NvencTap(const NvencTap&) = delete;
	NvencTap& operator=(const NvencTap&) = delete;

	std::atomic<bool> installed{false};
	std::atomic<bool> failedPermanently{false};
	double lastAttempt = 0;
	double lastHeartbeat = 0;
	// 2026-09-30: prevent premature OFF confirmation while hook enable is in flight.
	std::mutex installationLock;
	std::mutex cfgLock;
	NvencTapConfig cfg;
	// 2026-10-15: true once SetConfig has published a live config; the caps
	// shim's settings-file fallback and the open-time upgrade decisions
	// (UpgradeWanted, the CreateInstance wrap gate) apply only before that
	// (pre-publish).
	// Legacy caller feature caps retain their codec GUID; target-codec caps
	// validate the explicit vendor allocation envelope separately. H.264 High
	// 8-bit restricts input depth to match the selected client profile.
	std::atomic<bool> cfgPublished{false};

	friend struct NvencTapShims;
};
