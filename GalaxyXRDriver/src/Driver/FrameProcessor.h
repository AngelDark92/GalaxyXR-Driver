#pragma once
#include "openvr_driver.h"
#include "../Config/Config.h"
#include "../Config/SdrColorPolicy.h"
#include <cstdint>
#include <array>

// Phase 2: GPU processing of direct mode layer textures before the headset
// driver (vrlink) consumes them.
//
// Contract (observed from the vrlink direct mode path):
// - Layer textures are per eye, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, legacy shared
//   handles (unTextureFlags == 0), full 0-1 bounds, no depth.
// - Synchronization between the app device and the driver device is done via a
//   keyed mutex on the sync texture passed to Present. Acquiring it guarantees
//   the app's rendering into the layer textures has completed; our release
//   followed by vrlink's own acquire orders vrlink's reads after our writes.
//
// Everything is fail safe: any error results in the frame being forwarded
// unprocessed and a (rate limited) log line.

// settings snapshot copied from driverConfig once per frame
struct FrameProcessSettings{
	StreamFrameConfig config = {};
	// 2026-09-19 SDR10 baseline: effective color/post-pack/VUI policy for
	// this frame, resolved ONCE under driverConfigLock from the same
	// snapshot as config (gxr::ResolveSdr10Policy). both eyes and the
	// encode config read this, so a mid-frame toggle cannot mix pre-toggle
	// NVENC policy with post-toggle color constants. inactive = passthrough
	// of config, so the off path is unchanged.
	gxr::Sdr10BaselinePolicy policy = {};
	// false while dashboard is open (compositor shader already applies the color
	// adjustments to the flattened scene in that state). does not gate cas/dither.
	bool applyColor = true;
	// stationary dimming factor, 0 bright to 1 black, applied after everything
	double dimAmount = 0;
	// live gaze from the eye tracking tap, sampled on the Present thread.
	// unit direction in HMD space (origin is the head origin; vrlink
	// publishes a combined ray with zero origin), valid=false when the tap
	// has no fresh sample.
	bool gazeValid = false;
	double gazeDirX = 0;
	double gazeDirY = 0;
	double gazeDirZ = -1;
	// real per-eye projection frusta from the HMD display component
	// ([eye][left,right,top,bottom], OpenVR raw convention: y-down
	// tangents). when valid the gaze mapping uses these — the same math
	// the runtime uses for GetEyeTrackedFoveationCenter — instead of the
	// symmetric tangent knobs.
	bool gazeProjValid = false;
	float gazeProj[2][4] = {};
	// raw gaze direction as published (before prediction and smoothing) and
	// its age at snapshot time. the swim probe fits against raw gaze: the
	// speed-adaptive smoothing lags during VOR, which would bias residuals
	// proportionally to head velocity.
	double gazeRawDirX = 0;
	double gazeRawDirY = 0;
	double gazeRawDirZ = -1;
	double gazeAgeMs = 0;
	// world-locked fixation dot direction in head space for the current
	// frame's render pose (computed in SubmitLayer from mHmdPose), and the
	// head angular velocity between successive submitted poses (deg/s)
	bool dotValid = false;
	double dotDirX = 0;
	double dotDirY = 0;
	double dotDirZ = -1;
	double headVelDegS = 0;
	// interactive distortion tuner: when active, ProcessEye highlights the
	// band being edited with a ring at tuneRingR (aspect-corrected radius
	// space, i.e. exactly where the spline knot acts), drawn only in the
	// eye(s) being edited (0 linked, 1 left, 2 right) so the eye mode is
	// readable in-headset without any text.
	bool tuneActive = false;
	double tuneRingR = 0;
	int tuneEyeMode = 0;
	// active band segment for the sector highlight: -1 = ALL (full ring),
	// 0..N-1 dims the ring outside that angular sector. count comes from
	// config.distortion.segments.
	int tuneSegIndex = -1;
	// the CURRENT band's segment count (sector span for the highlight);
	// may differ from the row count when a per-band layout is active
	int tuneSegCount = 0;
	// head orientation basis (columns = head x/y/z axes in world) from the
	// frame's submitted render pose, for the world-locked calibration grid
	bool headBasisValid = false;
	float headBasis[3][3] = {{1,0,0},{0,1,0},{0,0,1}};
	// auxiliary calibration marker: 0 none, 2 = cross at each eye's
	// configured distortion center (center tune mode), 3 = controller tip
	// marker at auxHead* (head-space position, meters; drawn with a simple
	// per-eye parallax so it reads at roughly the right depth)
	int auxMarkerMode = 0;
	double auxHeadX = 0;
	double auxHeadY = 0;
	double auxHeadZ = -1;
};

// interpolate a spline distortion curve (monotone-ordered points assumed) at
// radius r; flat outside the covered range, identity when empty. shared by
// the lut bake and the interactive tuner's band initialization so the tuner
// starts from exactly the curve the shader was applying.
double EvaluateDistortionCurve(const std::vector<StreamFrameDistortionPoint> &points, double r);

// map a unit direction in head space to bounds-normalized viewport uv for one
// eye, using the real projection frusta when available (identical math to the
// gaze debug ring mapping) or the symmetric tangent knobs otherwise. returns
// false when the direction is behind the viewer or maps far outside the view.
// shared by the constant fill (gaze ring, pupil swim, fixation dot) and the
// swim probe logging so every consumer uses one mapping.
bool MapHeadDirToEyeUv(const FrameProcessSettings &settings, int eye,
	double dirX, double dirY, double dirZ, double &u, double &v);

#ifdef _WIN32

#include <d3d11.h>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

class FrameProcessor{
public:
	// 2026-09-25: encoder/post-pack settings must update even when the eye
	// pass is an identity transform or Image Enhancements has been disabled.
	static void UpdateEncoderSettings(const FrameProcessSettings &settings);

	// process both eye textures of the scene layer. syncTexture is the direct
	// mode sync texture whose keyed mutex guards the frame. returns true if the
	// frame was processed, false if it was skipped (frame is still valid).
	bool ProcessSceneLayer(vr::SharedTextureHandle_t leftEye, vr::SharedTextureHandle_t rightEye,
		const vr::VRTextureBounds_t &leftBounds, const vr::VRTextureBounds_t &rightBounds,
		vr::SharedTextureHandle_t syncTexture, const FrameProcessSettings &settings);

	// drop cached opened resources for a destroyed swap texture handle
	void EvictTexture(vr::SharedTextureHandle_t handle);
	// drop everything (e.g. DestroyAllSwapTextureSets); cheap, caches repopulate
	void EvictAll();

private:
	bool EnsureDevice();
	bool EnsureShaders();
	bool EnsureScratch(uint32_t width, uint32_t height, DXGI_FORMAT format, bool needOut);
	ID3D11Texture2D* OpenShared(vr::SharedTextureHandle_t handle);
	// process one eye region. slice selects the array slice for apps that
	// submit a single Texture2DArray shared by both eyes (unity single-pass
	// instanced: slice 0 = left, slice 1 = right); 0 for plain textures.
	bool ProcessEye(ID3D11Texture2D* texture, const vr::VRTextureBounds_t &bounds, int eye, int slice, const FrameProcessSettings &settings);
	// shared array-layer handles already announced in the log (once each)
	std::set<uint64_t> loggedArrayTextures;

	std::mutex lock;
	bool deviceFailed = false;
	// consecutive frames skipped on sync acquire timeout, drives the
	// escalating timeout that breaks flash streaks under load
	int consecutiveSyncSkips = 0;

	ID3D11Device* device = nullptr;
	ID3D11DeviceContext* context = nullptr;

	// fullscreen triangle vertex shader + processing pixel shader
	ID3D11VertexShader* vertexShader = nullptr;
	ID3D11PixelShader* pixelShader = nullptr;
	ID3D11SamplerState* sampler = nullptr;
	ID3D11Buffer* constantBuffer = nullptr;
	// mtime of the hlsl file the current pixel shader was compiled from (0 = embedded fallback)
	uint64_t pixelShaderFileTime = 0;
	// last time the hlsl file mtime was checked, to avoid a stat call every frame
	uint64_t lastShaderCheckMs = 0;
	bool shaderFailed = false;

	// distortion curve lookup table, rebaked when the distortion settings change
	bool BakeLutIfNeeded(const StreamFrameConfig &config);
	ID3D11Texture2D* lutTexture = nullptr;
	ID3D11ShaderResourceView* lutSRV = nullptr;
	// serialized copy of the settings the current lut was baked from
	std::string lastLutKey = "";
	// number of curve rows in the lut texture (1, 2 or 4)
	int lutRowCount = 1;
	bool lutBaked = false;

	// dense displacement map: the control lattice from the config is
	// bicubic upsampled at bake time into a 2 slice (left/right) R32G32
	// float texture array the shader samples with one bilinear tap.
	// rebaked when the map or the gain change. dispActive false = the
	// map is empty/malformed/disabled and the shader skips the tap.
	bool BakeMapIfNeeded(const StreamFrameConfig &config);
	ID3D11Texture2D* dispTexture = nullptr;
	ID3D11ShaderResourceView* dispSRV = nullptr;
	std::string lastMapKey = "";
	bool mapBaked = false;
	bool dispActive = false;
	static const int dispTexSize = 256;

	// calibration pattern echo for the diagnostic handshake: the index
	// shown last frame and how many consecutive frames it has been shown
	int calibPatternShown = -1;
	uint32_t calibPatternFrames = 0;
	uint64_t lastDiagUpdateMs = 0;

	// scratch texture cache, keyed by size + format family. multiple sizes are
	// live simultaneously during app transitions and dashboard flattening
	// (scene frames alternate between vrcompositor's set and the app's set);
	// a single set caused ~half a GB of alloc/free per flip, under the sync
	// keyed mutex, which showed up as multi second stutter at app launches.
	struct ScratchSet{
		ID3D11Texture2D* in = nullptr;
		ID3D11ShaderResourceView* inSRV = nullptr;
		ID3D11Texture2D* out = nullptr;
		ID3D11RenderTargetView* outRTV = nullptr;
		// fxaa quality intermediate: pass 1 renders FXAA(in) here, the
		// main pass samples it. lazily created when quality mode is on.
		ID3D11Texture2D* fx = nullptr;
		ID3D11ShaderResourceView* fxSRV = nullptr;
		ID3D11RenderTargetView* fxRTV = nullptr;
		uint64_t lastUsedMs = 0;
	};
	void EnsureFxTexture(ScratchSet &set, uint32_t width, uint32_t height, DXGI_FORMAT format);
	ID3D11PixelShader* fxaaShader = nullptr;
	uint64_t fxaaShaderFileTime = 0;
	bool cfgFxaaQuality = false;
	ID3D11Texture2D* scratchFx = nullptr;
	ID3D11ShaderResourceView* scratchFxSRV = nullptr;
	ID3D11RenderTargetView* scratchFxRTV = nullptr;
	std::set<ID3D11Texture2D*> fxaaFallbackLogged;
	static constexpr size_t maxScratchSets = 4;
	std::map<uint64_t, ScratchSet> scratchSets;
	static void ReleaseScratchSet(ScratchSet &set);
	// deferred scratch eviction: LRU victims are moved here (map entry
	// erased immediately, resources kept alive) and released at most one
	// per frame, at least 3 frames later, AFTER ReleaseSync - never inside
	// the mutex-held processing window. drained fully on EvictAll.
	struct PendingEvict{
		ScratchSet set;
		uint64_t frame = 0;
	};
	std::vector<PendingEvict> pendingEvictions;
	void DrainPendingEvictions(bool force);
	// live-reloaded copy of streamFrame.deferredEviction, latched at frame
	// start so EnsureScratch (no settings param) can read it
	bool cfgDeferEvict = true;
	// ---- HITCHDIAG: render-side cadence instrumentation (KALDIAG analog).
	// gap between successive ProcessSceneLayer entries is the observable a
	// user feels; acquire and work times plus per-frame event tags let an
	// outlier gap self-attribute to what the PREVIOUS frame did.
	// Latched at frame start for helpers without a settings parameter.
	bool cfgHitchDiag = false;
	static uint64_t NowUs();
	uint64_t hdLastFrameStartUs = 0;
	uint64_t hdWindowStartUs = 0;
	uint32_t hdFrames = 0;
	double hdGapSumMs = 0, hdGapMaxMs = 0;
	double hdAcqSumMs = 0, hdAcqMaxMs = 0;
	double hdWorkSumMs = 0, hdWorkMaxMs = 0;
	uint32_t hdOver16 = 0, hdOver33 = 0, hdSkips = 0;
	uint32_t hdCreates = 0, hdEvicts = 0, hdIdleBreaks = 0;
	// tags for the CURRENT frame (set by EnsureScratch / BakeLutIfNeeded /
	// EnsureShaders), rotated into prev* at frame end for attribution
	enum HitchTag : uint32_t { TagScratchCreate = 1, TagLutBake = 2, TagShaderCompile = 4, TagSyncSkip = 8 };
	uint32_t hdFrameTags = 0;
	uint32_t hdPrevTags = 0;
	double hdPrevAcqMs = 0, hdPrevWorkMs = 0;
	// one-shot HITCH line budget, re-armed with the 5 minute error re-arm
	uint32_t hdHitchLines = 0;
	// direct render path: per layer-texture RTVs (one per slice) so the
	// warped output is drawn straight into the layer, eliminating the
	// scratchOut target and the bounds copy-back. per-texture fallback if
	// the shared texture refuses an RTV (bind flags out of our control).
	std::map<ID3D11Texture2D*, std::array<ID3D11RenderTargetView*, 2>> layerRTVs;
	std::set<ID3D11Texture2D*> layerRtvFailed;
	std::set<ID3D11Texture2D*> layerPathLogged;
	ID3D11RenderTargetView* GetLayerRTV(ID3D11Texture2D* texture, int slice, DXGI_FORMAT rtvFormat);
	// zero-copy v3: per-layer SRVs (the shader samples the layer DIRECTLY,
	// no scratchIn copy) and rotating shared shadow sets the warped output
	// is drawn into. vrlink's staging copy is redirected to read the fresh
	// shadow (ZeroCopy.cpp); the layer itself keeps the app's unprocessed
	// frame so every failure degrades to a passthrough flash. per-texture
	// sticky fallback mirrors the RTV fallback precedent.
	std::map<ID3D11Texture2D*, std::array<ID3D11ShaderResourceView*, 2>> layerSRVs;
	std::set<ID3D11Texture2D*> v3Failed;
	ID3D11ShaderResourceView* GetLayerSRV(ID3D11Texture2D* texture, int slice, DXGI_FORMAT srvFormat);
	struct ShadowSet{
		static constexpr int slots = 3;
		ID3D11Texture2D* tex[slots] = {};
		HANDLE handle[slots] = {};
		uint32_t arraySize = 0;
		uint64_t lastFrame = 0;
		int index = 0;
		bool usedThisFrame = false;
	};
	std::map<uint64_t, ShadowSet> shadowSets; // key = (w << 32) | h
	// per-frame dedup of the layer->scratchIn copy: for layouts where both
	// eyes process the same subresource, the second eye reuses the copy
	// already made this frame (a full-slice copy of a 5-8K texture, saved
	// once per frame)
	std::map<ID3D11Texture2D*, std::array<uint64_t, 2>> layerCopyFrame;
	bool EnsureShadow(uint32_t width, uint32_t height, DXGI_FORMAT format, uint32_t arraySize, ShadowSet*& outSet);
	static void ReleaseShadowSet(ShadowSet &set);
	uint64_t frameCounter = 0;
	// layer formats already reported as unsupported (log each once, not
	// against the errorCount budget, so per-game skips stay visible)
	std::set<unsigned> skippedFormats;
	// periodic re-arm of the errorCount budget so a game launched late in a
	// session still gets its 20 diagnostic lines
	uint64_t lastErrorResetMs = 0;
	// non owning aliases into the cache entry selected by the last
	// EnsureScratch call, consumed by ProcessEye
	ID3D11Texture2D* scratchIn = nullptr;      // copy of the layer texture, sampled by the shader
	ID3D11ShaderResourceView* scratchInSRV = nullptr;
	ID3D11Texture2D* scratchOut = nullptr;     // render target, copied back into the layer texture
	ID3D11RenderTargetView* scratchOutRTV = nullptr;

	// cache of opened shared resources by handle value. handles can be reused
	// after destruction, so DestroySwapTextureSet must evict.
	std::map<uint64_t, ID3D11Texture2D*> openedTextures;

	// rate limited error logging
	uint64_t errorCount = 0;
	// gaze ring state logging
	bool gazeRingWasActive = false;
	uint64_t lastGazeRingLogMs = 0;
};

#else

// non windows stub
class FrameProcessor{
public:
	static void UpdateEncoderSettings(const FrameProcessSettings &){}
	bool ProcessSceneLayer(vr::SharedTextureHandle_t, vr::SharedTextureHandle_t,
		const vr::VRTextureBounds_t &, const vr::VRTextureBounds_t &,
		vr::SharedTextureHandle_t, const FrameProcessSettings &){ return false; }
	void EvictTexture(vr::SharedTextureHandle_t){}
	void EvictAll(){}
};

#endif
