#pragma once
#include "openvr_driver.h"
#include "FrameProcessor.h"
#include <vector>

// Phase 1: pass-through wrappers around a foreign HMD driver's frame-delivery
// components (used for the vrlink / Steam Link HMD, e.g. Galaxy XR).
//
// Purpose right now is purely diagnostic: confirm which component vrcompositor
// actually fetches (IVRDriverDirectModeComponent vs IVRVirtualDisplay) and log
// the facts the phase-2 GPU processing pass must be designed around:
// swap texture formats and flags (keyed mutex or not), layers per frame,
// texture bounds, and pose prediction times.
//
// Phase 2 will insert a D3D11 pass (saturation + radial distortion
// pre-perturbation) on the scene layer textures inside SubmitLayer/Present
// before forwarding to the original component.

// Wraps IVRDriverDirectModeComponent (compiled against IVRDriverDirectModeComponent_009).
class DirectModeComponentShim : public vr::IVRDriverDirectModeComponent{
public:
	explicit DirectModeComponentShim(vr::IVRDriverDirectModeComponent* original);
	// OF-SPIKE 2026-10-17 (brief W3A; remove or replace at W3C): releases the
	// injection spike's private swap sets + its local D3D11 objects; no-op
	// unless GXR_OF_INJECT=1 armed the spike.
	~DirectModeComponentShim();
	vr::IVRDriverDirectModeComponent* original;

	void CreateSwapTextureSet(uint32_t unPid, const SwapTextureSetDesc_t* pSwapTextureSetDesc, SwapTextureSet_t* pOutSwapTextureSet) override;
	void DestroySwapTextureSet(vr::SharedTextureHandle_t sharedTextureHandle) override;
	void DestroyAllSwapTextureSets(uint32_t unPid) override;
	void GetNextSwapTextureSetIndex(vr::SharedTextureHandle_t sharedTextureHandles[2], uint32_t (*pIndices)[2]) override;
	void SubmitLayer(const SubmitLayerPerEye_t (&perEye)[2]) override;
	void Present(vr::SharedTextureHandle_t syncTexture) override;
	void PostPresent(const Throttling_t* pThrottling) override;
	void GetFrameTiming(vr::DriverDirectMode_FrameTiming* pFrameTiming) override;

private:
	// layers submitted since the last Present, to learn the per-frame layer structure
	int layersThisFrame = 0;
	uint64_t frameCount = 0;
	// log verbosely only for the first frames to avoid spamming vrserver.txt
	bool VerboseFrame() const { return frameCount < 20; }

	// scene layer captured in SubmitLayer (the first layer of the frame) and
	// processed in Present under the sync texture keyed mutex
	bool haveSceneLayer = false;
	vr::SharedTextureHandle_t sceneLeft = 0;
	vr::SharedTextureHandle_t sceneRight = 0;
	vr::VRTextureBounds_t sceneLeftBounds = {};
	vr::VRTextureBounds_t sceneRightBounds = {};

	// sync texture from the previous Present, used when processing at submit time
	vr::SharedTextureHandle_t lastSyncTexture = 0;

	// snapshot current settings; returns false if processing is disabled or identity
	bool GetActiveSettings(FrameProcessSettings &settings, bool &processAtSubmit);
	// gaze prediction state (recent gaze angular motion, EMA smoothed)
	bool gazePrevValid = false;
	// one-shot projection tangent log flags (per eye), for the camera
	// distortion fit workflow (tools/gxr_distortion_fit.py)
	bool projLogged[2] = {false, false};
	double gazePrevDir[3] = {0, 0, -1};
	double gazePrevTime = 0;
	double gazeVelEma[3] = {0, 0, 0};
	bool gazeSmoothValid = false;
	double gazeSmoothEma[3] = {0, 0, -1};

	// stationary dimming state: last hmd orientation basis, time of last
	// detected movement, and the current dim factor (0 bright .. 1 black)
	bool havePose = false;
	float lastPoseX[3] = {1, 0, 0};
	float lastPoseZ[3] = {0, 0, 1};
	double lastMovementTime = 0;
	double lastDimUpdateTime = 0;
	double dimFactor = 0;
	// track stillness from a submitted pose and advance the dim factor
	void UpdateStationaryDimming(const vr::HmdMatrix34_t &pose);

	// swim probe state: the fixation dot's latched world direction, its
	// per-frame head-space direction (from the submitted render pose, so
	// the dot is consistent with the world the app rendered), and the head
	// angular velocity between successive submitted poses
	bool dotLatched = false;
	double dotWorldDir[3] = {0, 0, -1};
	bool dotHeadValid = false;
	double dotHeadDir[3] = {0, 0, -1};
	bool probePoseValid = false;
	// full head basis (columns = head axes in world) from the submitted
	// render pose, for the world-locked calibration grid
	bool headBasisValid = false;
	float headBasisW[3][3] = {{1,0,0},{0,1,0},{0,0,1}};
	float headPosW[3] = {0, 0, 0};
	float probePrevX[3] = {1, 0, 0};
	float probePrevZ[3] = {0, 0, 1};
	double probePrevTime = 0;
	double headVelDegS = 0;
	double lastSwimProbeLogTime = 0;
	// ---- interactive distortion tuner ----
	// working per-band curve state, owned by the frame processing thread.
	// activated by streamFrame.distortion.tune.enable; while active the
	// frame's distortion config is replaced by these bands (spline, per
	// eye, gain 1) so the human nulls the swim band by band with the
	// controllers, then saves an importable profile.
	struct TunerState {
		bool active = false;
		std::vector<double> bandR;
		std::vector<double> scaleL, scaleR;
		std::vector<double> initL, initR;   // activation snapshot (Y resets to these)
		// band segments: additive deltas on top of the base band value,
		// [band][segment], plus their activation snapshot. seg = -1 is the
		// ALL position (base band editing, exactly the classic behavior).
		std::vector<std::vector<double>> segDeltaL, segDeltaR;
		std::vector<std::vector<double>> initSegL, initSegR;
		// per-band segment counts (inner to outer); segCount = max of them
		// = the uniform row count the working curves flatten into
		std::vector<int> segCounts;
		int segCount = 1;
		int seg = -1;
		int band = 0;
		int eyeMode = 0;                    // 0 linked, 1 left, 2 right
		bool prevBandOut = false, prevBandIn = false;
		bool prevEyeToggle = false, prevReset = false;
		bool prevSegToggle = false;
		double lastTime = 0;
		bool gripWasHigh = false;
		double gripHoldStart = 0;
		bool savedThisHold = false;
		double lastNudgeLogTime = 0;
		double lastStepTime = 0;
	};
	TunerState tuner;
	// ---- center-offset tuning mode (distinct from the band tuner) ----
	struct CenterTuneState {
		bool active = false;
		int eyeMode = 0; // 0 both-shift, 1 both-mirrored (ipd), 2 left, 3 right
		double cxL = 0, cxR = 0, cy = 0;
		double initCxL = 0, initCxR = 0, initCy = 0;
		bool prevEyeToggle = false, prevReset = false;
		double lastTime = 0;
		bool gripWasHigh = false;
		double gripHoldStart = 0;
		bool savedThisHold = false;
		double lastLogTime = 0;
	};
	CenterTuneState centerTune;
	// ---- controller offset aligner ----
	struct AlignerState {
		bool active = false;
		int hand = 1;      // start on the right controller
		int group = 0;     // 0 position (cm), 1 rotation (deg), 2 grip (cm, per hand)
		int axis = 0;      // 0 x, 1 y, 2 z
		double rotDeg[3] = {0, 0, 0};
		double posCm[3] = {0, 0, 0};
		// grip-point compensator working offsets, PER HAND (local frame
		// cm) — unlike the shared pose offsets above, r is anatomical
		double gripCm[2][3] = {};
		double initRot[3] = {0, 0, 0};
		double initPos[3] = {0, 0, 0};
		bool prevHandToggle = false, prevGroupToggle = false;
		bool prevAxisUp = false, prevAxisDown = false;
		double lastTime = 0;
		bool gripWasHigh = false;
		double gripHoldStart = 0;
		bool savedThisHold = false;
		double lastLogTime = 0;
		// pivot capture (trigger held, tip planted, swirl)
		bool capturing = false;
		std::vector<double> sampleQ; // w,x,y,z per sample
		std::vector<double> sampleP; // x,y,z per sample
		double lastSampleTime = 0;
	};
	AlignerState aligner;
	// mode dispatcher: aligner > center tune > band tuner, one active at a
	// time (they share the controller inputs)
	void UpdateInteractiveModes(FrameProcessSettings &settings);
	void UpdateCenterTune(FrameProcessSettings &settings);
	void SaveCenterProfile(const FrameProcessSettings &settings);
	void UpdateAligner(FrameProcessSettings &settings);
	void SaveControllerOffsets();
	// least-squares pivot solve: R_i o + p_i = c over the captured swirl.
	// returns false when the system is degenerate (not enough rotation
	// spread). residualM reports fit quality in meters.
	static bool SolvePivot(const std::vector<double> &sampleQ, const std::vector<double> &sampleP,
		double pivotLocal[3], double &residualM);
	// advance the tuner from controller input and, while active, override
	// the frame's distortion config with the working bands + force the
	// calibration view (angular grid + warped overlays) on
	void UpdateTuner(FrameProcessSettings &settings);
	// write the working curves as an importable profile json into the
	// Distortion folder and log a paste-ready settings block
	void SaveTunedProfile(const FrameProcessSettings &settings);
	// latch/track the fixation dot and head velocity from a submitted pose
	void UpdateSwimProbePose(const vr::HmdMatrix34_t &pose);
	// throttled SwimProbe log line (gaze-vs-dot residuals, head velocity,
	// per-eye lens uvs) while the dot and probe logging are enabled
	void MaybeLogSwimProbe(const FrameProcessSettings &settings);

	FrameProcessor processor;

	// ========================================================================
	// OF-SPIKE 2026-10-17 (brief W3A; remove or replace at W3C)
	// Env-gated phase-0 scaffolding for the host-side Optical Flow gate
	// (builds/GalaxyXR-Driver/build/of-20261017/). Cadence diagnostics ride
	// GXR_OF_CADENCE=1; the injection spike rides GXR_OF_INJECT=1 (which
	// implies the diagnostics). With both env vars absent nothing in this
	// block is ever read, written or logged and behavior is byte-identical
	// to stock. Spike content is static only (two private swap sets cleared
	// to alternating solid colors); any failure disarms the injection for
	// the session with ONE log line and the stock path continues. Only the
	// compositor thread reaches SubmitLayer/Present, like every other member
	// of this class, so this state needs no extra synchronization.
	// ========================================================================
	struct OfSpikeState {
		// cadence counters (lifetime)
		uint64_t slCalls = 0;
		uint64_t rawLines = 0;      // raw per-call OFSpike lines emitted (capped)
		bool slPairValid = false;
		vr::SharedTextureHandle_t slPairL = 0, slPairR = 0;
		bool lastPresentValid = false;
		double lastPresentMs = 0;
		// per-second summary window
		bool windowStarted = false;
		double windowStartMs = 0;
		uint64_t windowSlCalls = 0, windowPCalls = 0;
		uint64_t windowDistinctPairs = 0;
		uint64_t windowIvCount = 0;
		double windowIvSumMs = 0, windowIvMaxMs = 0;
		// last real inputs, stored only while the diagnostics are enabled
		vr::IVRDriverDirectModeComponent::SubmitLayerPerEye_t realPerEye[2] = {};
		bool haveRealPerEye = false;
		uint32_t appPid = 0;
		bool appPidValid = false;
		vr::IVRDriverDirectModeComponent::SwapTextureSetDesc_t capturedDesc = {};
		uint32_t capturedFlags = 0;
		bool capturedDescValid = false;
		// injection spike
		bool injectInitTried = false;
		bool spikeDisarmed = false;
		bool disarmLogged = false;
		bool injectArmed = false;
		int injectRatio = 1;
		int injectSyncMode = 0;
		uint64_t realPresentCount = 0;
#ifdef _WIN32
		// local D3D11 objects (created lazily on the first enabled Present
		// after a real CreateSwapTextureSet; guarded so this header keeps
		// parsing against the non-Windows FrameProcessor stub)
		ID3D11Device* localDevice = nullptr;
		ID3D11DeviceContext* localContext = nullptr;
		ID3D11Texture2D* texL = nullptr;
		ID3D11Texture2D* texR = nullptr;
		ID3D11RenderTargetView* rtvL = nullptr;
		ID3D11RenderTargetView* rtvR = nullptr;
#endif
		// rSharedTextureHandles[0] of each private set: the texture submitted
		// for that eye AND the token passed to original->DestroySwapTextureSet
		vr::SharedTextureHandle_t privateHandleL = 0;
		vr::SharedTextureHandle_t privateHandleR = 0;
	};
	OfSpikeState ofSpike;
	void OfSpikeSubmitLayer(const SubmitLayerPerEye_t (&perEye)[2]);
	void OfSpikeRecordPresent(uint64_t frameIdx, double tMs, int layers,
		vr::SharedTextureHandle_t pairL, vr::SharedTextureHandle_t pairR,
		vr::SharedTextureHandle_t sync, double durFwdMs);
	void OfSpikeMaybeSum(double nowMs);
	void OfSpikeMaybeInject(uint64_t frameIdx, int layers, vr::SharedTextureHandle_t realSync);
	void OfSpikeInitInjection();
	void OfSpikeDeliverSynthetic(uint64_t frameIdx, vr::SharedTextureHandle_t realSync);
	void OfSpikeDisarm(const char* reason);
	void OfSpikeDestroyPrivateSets();
};

// Wraps IVRVirtualDisplay (compiled against IVRVirtualDisplay_002).
class VirtualDisplayShim : public vr::IVRVirtualDisplay{
public:
	explicit VirtualDisplayShim(vr::IVRVirtualDisplay* original);
	vr::IVRVirtualDisplay* original;

	void Present(const vr::PresentInfo_t* pPresentInfo, uint32_t unPresentInfoSize) override;
	void WaitForPresent() override;
	bool GetTimeSinceLastVsync(float* pfSecondsSinceLastVsync, uint64_t* pulFrameCounter) override;

private:
	uint64_t frameCount = 0;
};
