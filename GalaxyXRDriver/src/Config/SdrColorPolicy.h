#pragma once
#include "Config.h"

// 2026-09-19 SDR10 baseline (plan: steamlink-colour/VD-LIKE-SDR10-IMPLEMENTATION-PLAN.md,
// Phase 1/2). Pure policy resolver shared by the Galaxy XR startup writer
// (GalaxyXR.cpp), the per-frame frame processing (FrameProcessor.cpp via
// FrameComponentShim.cpp) and the standalone test
// (tests/SdrColorPolicyTest.cpp).
//
// Design rules:
// - PURE: no IO, no locks, no globals, no side effects. it reads one
//   immutable Config snapshot and returns a value object of EFFECTIVE
//   values. callers that must see a consistent snapshot resolve it while
//   holding driverConfigLock (the caller's existing lock discipline).
// - OFF-PATH UNCHANGED: while sdr10Baseline is off (or in conflict) every
//   policy field passes the stored config through exactly, so every
//   consumer that reads only the policy behaves byte-for-byte as before.
// - PURE RESOLVER: stored user controls are never modified or pruned here;
//   Companion explicitly resets picture controls when the user enables it. force10bit stays
//   retired and is deliberately absent from this policy.
// - CONFLICT: a per-device custom shader enabled for "other" headsets
//   (Galaxy XR lands in that bucket) owns the compositor color path;
//   the baseline yields to it (active=false, conflict=true) instead of
//   silently overriding it. the GUI shows a not-baseline status.
// - SCOPE: only the controls listed in plan section 4.2. FXAA, pre-encode
//   CAS, the black-floor ramp bar (user debug overlay), bitrate/preset/QP/
//   split, tracking, geometry/distortion, blackout/dimming safety and the
//   nvencTap master switch are NOT scalar overrides in this policy.
//   ImageEnhancementsEnabled separately bypasses image-processing passes
//   while the baseline is requested without explicit enhancement consent,
//   including legacy overlapping settings.

namespace gxr{

// Effective SDR10 baseline values for one settings snapshot.
// field defaults are the ACTIVE baseline values, so a default-constructed
// policy is the neutral baseline (the safe state) and the inactive path
// overwrites every field with the stored config.
struct Sdr10BaselinePolicy{
	// 2026-09-25: consent gates combined SDR10 + enhancement use separately
	// from the capability request, preserving safe behavior for old files.
	bool requested = false;
	bool allowEnhancements = false;
	bool conflict = false;
	bool active = false;
	// effective vrlink headset profile request (startup writer)
	bool profileEnabled = true;
	bool profileSupports10bit = true;
	// effective host color chain (neutral baseline)
	double saturation = 50;
	double vibrance = 0;
	double contrast = 50;
	double contrastMidpoint = 50;
	bool contrastLinear = false;
	double gamma = 2.2;
	double brightness = 1.0;
	ConfigColor colorMultiplier = {};
	std::vector<double> srgbMatrix = {};
	bool dither = false;
	// effective black-floor fix state (rampBar is a user debug overlay and
	// is NOT part of the baseline)
	int blackFloorRangeMode = 0;
	bool blackFloorShadowLift = false;
	double blackFloorFloorCode = 2.0;
	double blackFloorKneeCode = 8.0;
	double blackFloorBlackPointCode = 0.0;
	// effective post-pack / VUI state: baseline bypasses the host YUV
	// range remap + post-pack sharpening and leaves Valve's original
	// pixel/metadata pair untouched (-1 = leave, the stored default)
	bool postPackEnable = false;
	int vuiFullRange = -1;
	int vuiMatrix = -1;
	int vuiPrimaries = -1;
	int vuiTransfer = -1;
};

// Companion mode contract: the saved baseline has priority unless the user
// explicitly accepted the image-quality warning. Older overlapping files
// remain bypassed; checking settings never rewrites user files.
inline bool ImageEnhancementsEnabled(const StreamFrameConfig &config, const Sdr10BaselinePolicy &policy){
	return config.enable && (!policy.requested || policy.allowEnhancements);
}

// Resolve the effective baseline policy from one settings snapshot.
// see the header comment for the off-path-unchanged and conflict rules.
inline Sdr10BaselinePolicy ResolveSdr10Policy(const Config &config){
	Sdr10BaselinePolicy p;
	p.requested = config.galaxyXr.sdr10Baseline;
	p.allowEnhancements = config.galaxyXr.sdr10AllowEnhancements;
	p.conflict = p.requested && config.customShader.enable && config.customShader.enableForOther;
	p.active = p.requested && !p.conflict;
	if(p.active && !ImageEnhancementsEnabled(config.streamFrame, p)){
		return p; // neutral baseline: struct defaults already hold it
	}
	// 2026-09-25: consent restores stored picture controls, but keeps the
	// active baseline's 10-bit capability request. Master OFF stays neutral.
	// Inactive or conflicting: pass the stored config through exactly.
	// This is the ONLY place the stored picture values are read, and only as-is,
	// so with the baseline off the policy equals today's behavior.
	if(!p.active){
		p.profileEnabled = config.galaxyXr.vrlinkHeadsetProfile;
		p.profileSupports10bit = config.galaxyXr.profileSupports10bit;
	}
	p.saturation = config.streamFrame.saturation;
	p.vibrance = config.streamFrame.vibrance;
	p.contrast = config.streamFrame.contrast;
	p.contrastMidpoint = config.streamFrame.contrastMidpoint;
	p.contrastLinear = config.streamFrame.contrastLinear;
	p.gamma = config.streamFrame.gamma;
	p.brightness = config.streamFrame.brightness;
	p.colorMultiplier = config.streamFrame.colorMultiplier;
	p.srgbMatrix = config.streamFrame.srgbMatrix;
	p.dither = config.streamFrame.dither;
	p.blackFloorRangeMode = config.streamFrame.blackFloor.rangeMode;
	p.blackFloorShadowLift = config.streamFrame.blackFloor.shadowLift;
	p.blackFloorFloorCode = config.streamFrame.blackFloor.floorCode;
	p.blackFloorKneeCode = config.streamFrame.blackFloor.kneeCode;
	p.blackFloorBlackPointCode = config.streamFrame.blackFloor.blackPointCode;
	p.postPackEnable = config.streamFrame.postPack.enable;
	p.vuiFullRange = config.streamFrame.nvencVuiFullRange;
	p.vuiMatrix = config.streamFrame.nvencVuiMatrix;
	p.vuiPrimaries = config.streamFrame.nvencVuiPrimaries;
	p.vuiTransfer = config.streamFrame.nvencVuiTransfer;
	return p;
}

} // namespace gxr
