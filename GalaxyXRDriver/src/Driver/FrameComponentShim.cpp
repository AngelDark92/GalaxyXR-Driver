#include "FrameComponentShim.h"
#include "DriverLog.h"
#include "EyeTrackingTap.h"
#include "DeviceProvider.h"
#include "../Config/ConfigLoader.h"
#include <chrono>
#include <cmath>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <ctime>
#include "nlohmann/json.hpp"

// ---------------------------------------------------------------------------
// DirectModeComponentShim
// ---------------------------------------------------------------------------

DirectModeComponentShim::DirectModeComponentShim(vr::IVRDriverDirectModeComponent* original){
	this->original = original;
	DriverLog("FrameComponentShim: wrapping IVRDriverDirectModeComponent %p", (void*)original);
}

void DirectModeComponentShim::CreateSwapTextureSet(uint32_t unPid, const SwapTextureSetDesc_t* pSwapTextureSetDesc, SwapTextureSet_t* pOutSwapTextureSet){
	original->CreateSwapTextureSet(unPid, pSwapTextureSetDesc, pOutSwapTextureSet);
	if(pSwapTextureSetDesc && pOutSwapTextureSet){
		// nFormat is a DXGI_FORMAT on D3D11. unTextureFlags tells us about
		// keyed-mutex / shared handle semantics (vr::VRSwapTextureFlag_*).
		DriverLog("FrameComponentShim: CreateSwapTextureSet pid=%u %ux%u format=%u samples=%u -> flags=%u handles=%llx %llx %llx",
			unPid,
			pSwapTextureSetDesc->nWidth, pSwapTextureSetDesc->nHeight,
			pSwapTextureSetDesc->nFormat, pSwapTextureSetDesc->nSampleCount,
			pOutSwapTextureSet->unTextureFlags,
			(unsigned long long)pOutSwapTextureSet->rSharedTextureHandles[0],
			(unsigned long long)pOutSwapTextureSet->rSharedTextureHandles[1],
			(unsigned long long)pOutSwapTextureSet->rSharedTextureHandles[2]);
	}
}

void DirectModeComponentShim::DestroySwapTextureSet(vr::SharedTextureHandle_t sharedTextureHandle){
	DriverLog("FrameComponentShim: DestroySwapTextureSet %llx", (unsigned long long)sharedTextureHandle);
	processor.EvictTexture(sharedTextureHandle);
	original->DestroySwapTextureSet(sharedTextureHandle);
}

void DirectModeComponentShim::DestroyAllSwapTextureSets(uint32_t unPid){
	DriverLog("FrameComponentShim: DestroyAllSwapTextureSets pid=%u", unPid);
	// handles are not tracked per pid, drop everything and let the caches repopulate
	processor.EvictAll();
	original->DestroyAllSwapTextureSets(unPid);
}

void DirectModeComponentShim::GetNextSwapTextureSetIndex(vr::SharedTextureHandle_t sharedTextureHandles[2], uint32_t (*pIndices)[2]){
	original->GetNextSwapTextureSetIndex(sharedTextureHandles, pIndices);
}

void DirectModeComponentShim::SubmitLayer(const SubmitLayerPerEye_t (&perEye)[2]){
	layersThisFrame++;
	if(VerboseFrame()){
		DriverLog("FrameComponentShim: SubmitLayer frame=%llu layer=%d tex=(%llx, %llx) depth=(%llx, %llx) boundsL=(%.3f %.3f %.3f %.3f) predict=%.4fs",
			(unsigned long long)frameCount, layersThisFrame,
			(unsigned long long)perEye[0].hTexture, (unsigned long long)perEye[1].hTexture,
			(unsigned long long)perEye[0].hDepthTexture, (unsigned long long)perEye[1].hDepthTexture,
			perEye[0].bounds.uMin, perEye[0].bounds.vMin, perEye[0].bounds.uMax, perEye[0].bounds.vMax,
			perEye[0].flHmdPosePredictionTimeInSecondsFromNow);
	}
	// capture the scene layer (first layer of the frame) for processing in Present.
	// later layers (e.g. the dashboard while it is open) are quads recomposited by
	// the driver at their own pose and are left untouched.
	if(layersThisFrame == 1){
		UpdateStationaryDimming(perEye[0].mHmdPose);
		UpdateSwimProbePose(perEye[0].mHmdPose);
		haveSceneLayer = true;
		sceneLeft = perEye[0].hTexture;
		sceneRight = perEye[1].hTexture;
		sceneLeftBounds = perEye[0].bounds;
		sceneRightBounds = perEye[1].bounds;
		FrameProcessSettings settings;
		bool processAtSubmit = false;
		bool active = GetActiveSettings(settings, processAtSubmit);
		// optional submit time processing, in case the driver already consumes the
		// layer during SubmitLayer. uses the previous frame's sync texture, which
		// stays constant across frames.
		if(active && processAtSubmit && lastSyncTexture != 0){
			MaybeLogSwimProbe(settings);
			processor.ProcessSceneLayer(sceneLeft, sceneRight, sceneLeftBounds, sceneRightBounds, lastSyncTexture, settings);
			haveSceneLayer = false;
		}
	}
	original->SubmitLayer(perEye);
}

static double NowSeconds(){
	return std::chrono::duration_cast<std::chrono::duration<double>>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

void DirectModeComponentShim::UpdateStationaryDimming(const vr::HmdMatrix34_t &pose){
	StreamFrameDimmingConfig dimming;
	{
		std::lock_guard<std::mutex> configGuard(driverConfigLock);
		dimming = driverConfig.streamFrame.stationaryDimming;
	}
	double now = NowSeconds();
	if(!dimming.enable){
		dimFactor = 0;
		lastMovementTime = now;
		lastDimUpdateTime = now;
		return;
	}
	// orientation basis vectors of the pose
	float x[3] = { pose.m[0][0], pose.m[1][0], pose.m[2][0] };
	float z[3] = { pose.m[0][2], pose.m[1][2], pose.m[2][2] };
	if(havePose){
		float dotX = x[0] * lastPoseX[0] + x[1] * lastPoseX[1] + x[2] * lastPoseX[2];
		float dotZ = z[0] * lastPoseZ[0] + z[1] * lastPoseZ[1] + z[2] * lastPoseZ[2];
		float minDot = dotX < dotZ ? dotX : dotZ;
		if(minDot > 1.0f){ minDot = 1.0f; }
		double angleDegrees = std::acos((double)minDot) * 180.0 / 3.14159265358979;
		if(angleDegrees > dimming.movementThreshold){
			lastMovementTime = now;
			lastPoseX[0] = x[0]; lastPoseX[1] = x[1]; lastPoseX[2] = x[2];
			lastPoseZ[0] = z[0]; lastPoseZ[1] = z[1]; lastPoseZ[2] = z[2];
		}
	}else{
		havePose = true;
		lastMovementTime = now;
		lastPoseX[0] = x[0]; lastPoseX[1] = x[1]; lastPoseX[2] = x[2];
		lastPoseZ[0] = z[0]; lastPoseZ[1] = z[1]; lastPoseZ[2] = z[2];
	}
	double delta = now - lastDimUpdateTime;
	if(delta < 0 || delta > 1){ delta = 0; }
	lastDimUpdateTime = now;
	bool still = now - lastMovementTime > dimming.movementTime;
	if(still){
		double rate = dimming.dimSeconds > 0.01 ? 1.0 / dimming.dimSeconds : 100.0;
		dimFactor += delta * rate;
	}else{
		double rate = dimming.brightenSeconds > 0.01 ? 1.0 / dimming.brightenSeconds : 100.0;
		dimFactor -= delta * rate;
	}
	if(dimFactor < 0){ dimFactor = 0; }
	if(dimFactor > 1){ dimFactor = 1; }
}

void DirectModeComponentShim::UpdateSwimProbePose(const vr::HmdMatrix34_t &pose){
	bool calibDot;
	{
		std::lock_guard<std::mutex> configGuard(driverConfigLock);
		// probeCapture is the one-switch scoring mode: it implies the dot
		calibDot = driverConfig.streamFrame.eyeGaze.calibDot
			|| driverConfig.streamFrame.eyeGaze.probeCapture;
	}
	double now = NowSeconds();
	// orientation basis columns of the render pose (head basis in world)
	float x[3] = { pose.m[0][0], pose.m[1][0], pose.m[2][0] };
	float y[3] = { pose.m[0][1], pose.m[1][1], pose.m[2][1] };
	float z[3] = { pose.m[0][2], pose.m[1][2], pose.m[2][2] };
	// keep the full basis + position for the world-locked calibration grid
	// and the controller aligner's tip marker
	for(int i = 0; i < 3; i++){
		headBasisW[0][i] = x[i];
		headBasisW[1][i] = y[i];
		headBasisW[2][i] = z[i];
		headPosW[i] = pose.m[i][3];
	}
	headBasisValid = true;
	// head angular velocity between successive submitted render poses, so
	// the probe can reject or regress high-velocity samples. the larger of
	// the x/z basis rotations bounds the true rotation well enough here.
	if(probePoseValid){
		double dt = now - probePrevTime;
		if(dt > 0.0001 && dt < 0.5){
			double dotX = x[0] * probePrevX[0] + x[1] * probePrevX[1] + x[2] * probePrevX[2];
			double dotZ = z[0] * probePrevZ[0] + z[1] * probePrevZ[1] + z[2] * probePrevZ[2];
			double minDot = dotX < dotZ ? dotX : dotZ;
			if(minDot > 1.0){ minDot = 1.0; }
			if(minDot < -1.0){ minDot = -1.0; }
			headVelDegS = std::acos(minDot) * 180.0 / 3.14159265358979 / dt;
		}
	}
	probePoseValid = true;
	probePrevTime = now;
	probePrevX[0] = x[0]; probePrevX[1] = x[1]; probePrevX[2] = x[2];
	probePrevZ[0] = z[0]; probePrevZ[1] = z[1]; probePrevZ[2] = z[2];
	if(!calibDot){
		// toggling the dot off clears the latch, so the next enable
		// re-centers it on the current view direction
		dotLatched = false;
		dotHeadValid = false;
		return;
	}
	if(!dotLatched){
		dotLatched = true;
		// head forward (0, 0, -1) in world space is the negated z basis.
		// direction only (dot at infinity): rotate the head in place while
		// probing; translation would add parallax the dot cannot show.
		dotWorldDir[0] = -z[0];
		dotWorldDir[1] = -z[1];
		dotWorldDir[2] = -z[2];
		DriverLog("SwimProbe: fixation dot latched, world dir=(%.4f, %.4f, %.4f)",
			dotWorldDir[0], dotWorldDir[1], dotWorldDir[2]);
	}
	// world -> head is the transpose of the rotation (columns are the head
	// basis): each head component is the dot with a basis column
	dotHeadDir[0] = x[0] * dotWorldDir[0] + x[1] * dotWorldDir[1] + x[2] * dotWorldDir[2];
	dotHeadDir[1] = y[0] * dotWorldDir[0] + y[1] * dotWorldDir[1] + y[2] * dotWorldDir[2];
	dotHeadDir[2] = z[0] * dotWorldDir[0] + z[1] * dotWorldDir[1] + z[2] * dotWorldDir[2];
	dotHeadValid = true;
}

void DirectModeComponentShim::MaybeLogSwimProbe(const FrameProcessSettings &settings){
	bool capture = settings.config.eyeGaze.probeCapture;
	if(!(settings.config.eyeGaze.swimProbe || capture) || !(settings.config.eyeGaze.calibDot || capture)){
		return;
	}
	if(!settings.dotValid || !settings.gazeValid){
		return;
	}
	double now = NowSeconds();
	if(now - lastSwimProbeLogTime < 0.05){
		return;
	}
	lastSwimProbeLogTime = now;
	// angular residuals between the gaze and the dot, both in head space.
	// resid uses the smoothed/predicted gaze the correction consumes;
	// residRaw uses the gaze as published, which is what fitting wants
	// (the speed-adaptive smoothing lags during VOR).
	// NORMALIZE both vectors first: the published gaze target is only
	// approximately unit length (magnitude wobbles ~0.5%), and acos of a
	// non-unit dot product turns that into degrees of phantom residual
	// (0.4% magnitude error at perfect alignment reads as ~5 degrees, and
	// magnitudes above 1 clamp to an impossible exact 0).
	auto angleDeg = [](double ax, double ay, double az, double bx, double by, double bz){
		double na = std::sqrt(ax * ax + ay * ay + az * az);
		double nb = std::sqrt(bx * bx + by * by + bz * bz);
		if(na < 1e-6 || nb < 1e-6){
			return 0.0;
		}
		double d = (ax * bx + ay * by + az * bz) / (na * nb);
		if(d > 1.0){ d = 1.0; }
		if(d < -1.0){ d = -1.0; }
		return std::acos(d) * 180.0 / 3.14159265358979;
	};
	double resid = angleDeg(settings.gazeDirX, settings.gazeDirY, settings.gazeDirZ,
		settings.dotDirX, settings.dotDirY, settings.dotDirZ);
	double residRaw = angleDeg(settings.gazeRawDirX, settings.gazeRawDirY, settings.gazeRawDirZ,
		settings.dotDirX, settings.dotDirY, settings.dotDirZ);
	// published-target magnitude, to keep the vrlink normalization wobble
	// visible in the data (it is NOT exactly unit length)
	double gazeRawLen = std::sqrt(settings.gazeRawDirX * settings.gazeRawDirX
		+ settings.gazeRawDirY * settings.gazeRawDirY
		+ settings.gazeRawDirZ * settings.gazeRawDirZ);
	// per-eye lens uvs of dot and raw gaze through the shared mapping, so
	// residuals can be binned by where the rays cross the lens
	double dotUv[2][2] = {{-1, -1}, {-1, -1}};
	double gazeUv[2][2] = {{-1, -1}, {-1, -1}};
	for(int eye = 0; eye < 2; eye++){
		double u, v;
		if(MapHeadDirToEyeUv(settings, eye, settings.dotDirX, settings.dotDirY, settings.dotDirZ, u, v)){
			dotUv[eye][0] = u;
			dotUv[eye][1] = v;
		}
		if(MapHeadDirToEyeUv(settings, eye, settings.gazeRawDirX, settings.gazeRawDirY, settings.gazeRawDirZ, u, v)){
			gazeUv[eye][0] = u;
			gazeUv[eye][1] = v;
		}
	}
	DriverLog("SwimProbe: resid=%.3f residRaw=%.3f rawLen=%.4f headVel=%.1f ageMs=%.1f "
		"dotL=(%.4f, %.4f) dotR=(%.4f, %.4f) gazeL=(%.4f, %.4f) gazeR=(%.4f, %.4f) "
		"dotHead=(%.4f, %.4f, %.4f) gazeRawHead=(%.4f, %.4f, %.4f)",
		resid, residRaw, gazeRawLen, settings.headVelDegS, settings.gazeAgeMs,
		dotUv[0][0], dotUv[0][1], dotUv[1][0], dotUv[1][1],
		gazeUv[0][0], gazeUv[0][1], gazeUv[1][0], gazeUv[1][1],
		settings.dotDirX, settings.dotDirY, settings.dotDirZ,
		settings.gazeRawDirX, settings.gazeRawDirY, settings.gazeRawDirZ);
}



// rotate a vector by a unit quaternion (w, x, y, z) — local copy so the
// shim has no dependency on DeviceProvider's file-static math helpers
static void ShimQuatRotate(const vr::HmdQuaternion_t &q, const double v[3], double out[3]){
	double w = q.w, x = q.x, y = q.y, z = q.z;
	out[0] = (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2];
	out[1] = 2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2];
	out[2] = 2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2];
}

// ---------------------------------------------------------------------------
// interactive mode dispatcher
// ---------------------------------------------------------------------------
// the three in-headset calibration modes share the controller inputs, so
// exactly one runs per frame: aligner > center tune > band tuner. a mode
// being superseded is deactivated with a log line so precedence is visible.

void DirectModeComponentShim::UpdateInteractiveModes(FrameProcessSettings &settings){
	bool alignOn;
	{
		std::lock_guard<std::mutex> configGuard(driverConfigLock);
		alignOn = driverConfig.controllers.aligner.enable;
	}
	bool centerOn = settings.config.distortion.centerTune.enable;
	bool bandOn = settings.config.distortion.tune.enable;
	deviceProvider.SetTunerInputActive(alignOn || centerOn || bandOn);
	if(alignOn){
		if(tuner.active){ tuner.active = false; DriverLog("Tuner: suspended (controller aligner active)"); }
		if(centerTune.active){ centerTune.active = false; DriverLog("CenterTune: suspended (controller aligner active)"); }
		UpdateAligner(settings);
		return;
	}
	if(aligner.active){
		aligner.active = false;
		deviceProvider.SetAlignerOffsets(false, aligner.rotDeg, aligner.posCm);
		deviceProvider.SetAlignerGrip(false, aligner.gripCm);
		DriverLog("Aligner: disabled (configured offsets apply again; unsaved edits dropped)");
	}
	if(centerOn){
		if(tuner.active){ tuner.active = false; DriverLog("Tuner: suspended (center tune active)"); }
		UpdateCenterTune(settings);
		return;
	}
	if(centerTune.active){ centerTune.active = false; DriverLog("CenterTune: disabled (configured centers apply again; unsaved edits dropped)"); }
	UpdateTuner(settings);
}

// ---------------------------------------------------------------------------
// center-offset tuning mode
// ---------------------------------------------------------------------------
// the distortion is replaced by a small sinusoidal "breathing" k1 pulse.
// everything on screen pulses radially around the CURRENT center — the
// stationary point of the pulse IS the configured center, made visible.
// task: drag that still-point (amber cross marks it) onto the lens's true
// center, i.e. the fringe-free sharpest point of the fine grid.
// stick X/Y move the center; X cycles both-shift / both-mirrored / L / R
// (donning shifts move both eyes the SAME way, ipd error moves them
// MIRRORED — both linked variants exist for that reason); Y resets; grip
// hold saves. results are written independently of the band tuner.

void DirectModeComponentShim::UpdateCenterTune(FrameProcessSettings &settings){
	double now = NowSeconds();
	if(!centerTune.active){
		centerTune.active = true;
		centerTune.cxL = settings.config.centerOffsetXLeft;
		centerTune.cxR = settings.config.centerOffsetXRight;
		centerTune.cy = settings.config.centerOffsetY;
		centerTune.initCxL = centerTune.cxL;
		centerTune.initCxR = centerTune.cxR;
		centerTune.initCy = centerTune.cy;
		centerTune.eyeMode = 0;
		centerTune.prevEyeToggle = centerTune.prevReset = false;
		centerTune.lastTime = now;
		centerTune.gripWasHigh = false;
		centerTune.savedThisHold = false;
		DriverLog("CenterTune: ACTIVE cxL=%+.4f cxR=%+.4f cy=%+.4f. "
			"Controls: stick moves the center, X = both(shift)/both(mirrored)/L/R, Y = reset, hold grip 1.5s = save",
			centerTune.cxL, centerTune.cxR, centerTune.cy);
	}
	double dt = now - centerTune.lastTime;
	centerTune.lastTime = now;
	if(dt < 0 || dt > 0.5){ dt = 0; }
	GalaxyXRDeviceProvider::TunerInputState in;
	deviceProvider.GetTunerInput(in);
	auto edge = [](bool current, bool &previous){
		bool rising = current && !previous;
		previous = current;
		return rising;
	};
	static const char* eyeModeNames[4] = {"BOTH (shift together)", "BOTH (mirrored / ipd)", "LEFT only", "RIGHT only"};
	if(edge(in.eyeToggle, centerTune.prevEyeToggle)){
		centerTune.eyeMode = (centerTune.eyeMode + 1) % 4;
		DriverLog("CenterTune: editing %s", eyeModeNames[centerTune.eyeMode]);
	}
	if(edge(in.resetBand, centerTune.prevReset)){
		centerTune.cxL = centerTune.initCxL;
		centerTune.cxR = centerTune.initCxR;
		centerTune.cy = centerTune.initCy;
		DriverLog("CenterTune: reset to activation values");
	}
	// stick: squared response, 0.02 uv/s at full deflection. stick up moves
	// the center up on screen, i.e. v decreases.
	auto axisDelta = [&](double v){
		double magnitude = fabs(v);
		double deadzone = 0.2;
		if(magnitude <= deadzone || dt <= 0){ return 0.0; }
		double normalized = (magnitude - deadzone) / (1.0 - deadzone);
		if(normalized > 1.0){ normalized = 1.0; }
		return (v > 0 ? 1.0 : -1.0) * normalized * normalized * 0.02 * dt;
	};
	double dx = axisDelta(in.stickX);
	double dy = -axisDelta(in.stickY);
	if(dx != 0 || dy != 0){
		switch(centerTune.eyeMode){
			case 0: centerTune.cxL += dx; centerTune.cxR += dx; break;
			case 1: centerTune.cxL += dx; centerTune.cxR -= dx; break;
			case 2: centerTune.cxL += dx; break;
			case 3: centerTune.cxR += dx; break;
		}
		centerTune.cy += dy;
		auto clampC = [](double &v){ if(v < -0.3){ v = -0.3; } if(v > 0.3){ v = 0.3; } };
		clampC(centerTune.cxL); clampC(centerTune.cxR); clampC(centerTune.cy);
		if(now - centerTune.lastLogTime > 0.3){
			centerTune.lastLogTime = now;
			DriverLog("CenterTune: cxL=%+.4f cxR=%+.4f cy=%+.4f", centerTune.cxL, centerTune.cxR, centerTune.cy);
		}
	}
	if(in.grip > 0.8){
		if(!centerTune.gripWasHigh){
			centerTune.gripWasHigh = true;
			centerTune.gripHoldStart = now;
			centerTune.savedThisHold = false;
		}else if(!centerTune.savedThisHold && now - centerTune.gripHoldStart > 1.5){
			centerTune.savedThisHold = true;
			SaveCenterProfile(settings);
		}
	}else if(in.grip < 0.5){
		centerTune.gripWasHigh = false;
	}
	// take over the frame: breathing k1 pulse + working centers + fine grid
	double amp = settings.config.distortion.centerTune.breatheAmp;
	if(amp < 0.005){ amp = 0.005; }
	if(amp > 0.2){ amp = 0.2; }
	StreamFrameDistortionConfig &d = settings.config.distortion;
	d.mode = "k1k2";
	d.perEye = false;
	d.perAxis = false;
	d.gain = 1.0;
	d.points.clear();
	d.curves.clear();
	d.annulus.enable = false;
	settings.config.k1 = amp * sin(now * 2.0 * 3.14159265358979 * 0.7);
	settings.config.k2 = 0;
	settings.config.centerOffsetXLeft = centerTune.cxL;
	settings.config.centerOffsetXRight = centerTune.cxR;
	settings.config.centerOffsetY = centerTune.cy;
	settings.config.eyeGaze.debugGrid = true;
	settings.config.eyeGaze.overlayWarped = true;
	settings.auxMarkerMode = 2;
}

void DirectModeComponentShim::SaveCenterProfile(const FrameProcessSettings &settings){
	using nlohmann::json;
	// combine the CONFIGURED curves (fresh from driverConfig, not this
	// frame's breathing override) with the tuned centers: profile = curves
	// + centers, so the artifact is complete and importable on its own
	StreamFrameDistortionConfig distortion;
	double baseK1, baseK2;
	{
		std::lock_guard<std::mutex> configGuard(driverConfigLock);
		distortion = driverConfig.streamFrame.distortion;
		baseK1 = driverConfig.streamFrame.k1;
		baseK2 = driverConfig.streamFrame.k2;
	}
	json curves = json::object();
	for(const auto &pair : distortion.curves){
		json points = json::array();
		for(const auto &point : pair.second.points){
			points.push_back({{"r", point.r}, {"scale", point.scale}});
		}
		curves[pair.first] = {{"k1", pair.second.k1}, {"k2", pair.second.k2}, {"points", points}};
	}
	json rootPoints = json::array();
	for(const auto &point : distortion.points){
		rootPoints.push_back({{"r", point.r}, {"scale", point.scale}});
	}
	char stamp[32];
	time_t rawTime = time(nullptr);
	struct tm timeInfo;
#ifdef _WIN32
	localtime_s(&timeInfo, &rawTime);
#else
	localtime_r(&rawTime, &timeInfo);
#endif
	strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", &timeInfo);
	json profile = {
		{"type", "streamFrameDistortionProfile"},
		{"version", 1},
		// the GUI applies centersOnly files to the center offsets alone,
		// leaving the configured curves untouched; the embedded curves are
		// a snapshot for standalone/manual use only
		{"centersOnly", true},
		{"name", std::string("Centers ") + stamp},
		{"distortion", {
			{"mode", distortion.mode},
			{"points", rootPoints},
			{"perEye", distortion.perEye},
			{"perAxis", distortion.perAxis},
			{"curves", curves},
		}},
		{"k1", baseK1},
		{"k2", baseK2},
		{"centerOffsetXLeft", centerTune.cxL},
		{"centerOffsetXRight", centerTune.cxR},
		{"centerOffsetY", centerTune.cy},
	};
	std::string folder = driverConfigLoader.GetConfigFolder() + "Distortion/";
	std::error_code ec;
	std::filesystem::create_directories(folder, ec);
	std::string path = folder + "centers-" + stamp + ".json";
	std::ofstream out(path);
	bool ok = false;
	if(out){
		out << profile.dump(2);
		ok = out.good();
	}
	DriverLog("CenterTune: %s %s", ok ? "SAVED" : "FAILED to write", path.c_str());
	DriverLog("CenterTune: settings block: \"centerOffsetXLeft\": %.4f, \"centerOffsetXRight\": %.4f, \"centerOffsetY\": %.4f",
		centerTune.cxL, centerTune.cxR, centerTune.cy);
}

// ---------------------------------------------------------------------------
// controller offset aligner
// ---------------------------------------------------------------------------
// manual: X switches hand, Y switches position<->rotation, A/B cycle the
// axis, stick Y adjusts the selected axis (both live: the working offsets
// override the configured ones in the pose path). the magenta marker draws
// at the driver's belief of the selected controller's TIP.
// automatic: plant the tip on any solid surface (armrest, desk edge —
// chest/waist height, away from the body), HOLD THE TRIGGER and slowly
// swirl a wide cone around the planted tip for a few seconds, release. a
// least-squares pivot solve (verified against synthetic ground truth:
// ~1-2mm at realistic tracking noise with a 15-40 degree cone) recovers
// where the physical tip actually is and updates the position offset so
// the marker freezes. rotation stays a manual aim task.
// NOTE: offsets are currently a single shared config for both hands; hand
// selection chooses which controller is visualized/solved. per-hand solved
// results are logged individually — persistent differences between hands
// are the data that decides whether per-hand config is worth adding.

void DirectModeComponentShim::UpdateAligner(FrameProcessSettings &settings){
	double now = NowSeconds();
	if(!aligner.active){
		aligner.active = true;
		ControllersConfig controllers;
		double gripL[3], gripR[3];
		{
			std::lock_guard<std::mutex> configGuard(driverConfigLock);
			controllers = driverConfig.controllers;
			for(int i = 0; i < 3; i++){
				gripL[i] = driverConfig.streamFrame.kalmanGripLeftCm[i];
				gripR[i] = driverConfig.streamFrame.kalmanGripRightCm[i];
			}
		}
		for(int i = 0; i < 3; i++){
			aligner.rotDeg[i] = controllers.rotationOffsetDeg[i];
			aligner.posCm[i] = controllers.positionOffsetCm[i];
			aligner.initRot[i] = aligner.rotDeg[i];
			aligner.initPos[i] = aligner.posCm[i];
			aligner.gripCm[0][i] = gripL[i];
			aligner.gripCm[1][i] = gripR[i];
		}
		aligner.hand = 1;
		aligner.group = 0;
		aligner.axis = 0;
		aligner.prevHandToggle = aligner.prevGroupToggle = false;
		aligner.prevAxisUp = aligner.prevAxisDown = false;
		aligner.lastTime = now;
		aligner.gripWasHigh = false;
		aligner.savedThisHold = false;
		aligner.capturing = false;
		aligner.sampleQ.clear();
		aligner.sampleP.clear();
		DriverLog("Aligner: ACTIVE rot=(%.1f, %.1f, %.1f)deg pos=(%.2f, %.2f, %.2f)cm "
			"gripL=(%.2f, %.2f, %.2f)cm gripR=(%.2f, %.2f, %.2f)cm. "
			"Controls: X = hand, Y = position/rotation/GRIP, A/B = axis, stick = adjust, "
			"TRIGGER HELD + swirl = auto solve (pos: tip planted on a surface; "
			"grip: palm held still, pure wrist swirl), hold grip 1.5s = save",
			aligner.rotDeg[0], aligner.rotDeg[1], aligner.rotDeg[2],
			aligner.posCm[0], aligner.posCm[1], aligner.posCm[2],
			aligner.gripCm[0][0], aligner.gripCm[0][1], aligner.gripCm[0][2],
			aligner.gripCm[1][0], aligner.gripCm[1][1], aligner.gripCm[1][2]);
		GalaxyXRDeviceProvider::AlignControllerState stateL, stateR;
		deviceProvider.GetAlignController(0, stateL);
		deviceProvider.GetAlignController(1, stateR);
		DriverLog("Aligner: availability L pose=%d tip=%d, R pose=%d tip=%d "
			"(no tip = no magenta marker and no auto-solve apply for that hand; move the controllers once if poses are 0)",
			stateL.poseValid ? 1 : 0, stateL.tipValid ? 1 : 0,
			stateR.poseValid ? 1 : 0, stateR.tipValid ? 1 : 0);
	}
	double dt = now - aligner.lastTime;
	aligner.lastTime = now;
	if(dt < 0 || dt > 0.5){ dt = 0; }
	GalaxyXRDeviceProvider::TunerInputState in;
	deviceProvider.GetTunerInput(in);
	auto edge = [](bool current, bool &previous){
		bool rising = current && !previous;
		previous = current;
		return rising;
	};
	static const char* axisNames[3] = {"x", "y", "z"};
	auto groupName = [](int group){
		return group == 0 ? "POSITION (cm)" : (group == 1 ? "ROTATION (deg)" : "GRIP r (cm, per hand)");
	};
	if(edge(in.eyeToggle, aligner.prevHandToggle)){
		aligner.hand = 1 - aligner.hand;
		DriverLog("Aligner: %s controller selected", aligner.hand == 0 ? "LEFT" : "RIGHT");
	}
	if(edge(in.resetBand, aligner.prevGroupToggle)){
		aligner.group = (aligner.group + 1) % 3;
		DriverLog("Aligner: adjusting %s, axis %s", groupName(aligner.group), axisNames[aligner.axis]);
	}
	if(edge(in.bandOut, aligner.prevAxisUp)){
		aligner.axis = (aligner.axis + 1) % 3;
		DriverLog("Aligner: axis %s (%s)", axisNames[aligner.axis], groupName(aligner.group));
	}
	if(edge(in.bandIn, aligner.prevAxisDown)){
		aligner.axis = (aligner.axis + 2) % 3;
		DriverLog("Aligner: axis %s (%s)", axisNames[aligner.axis], groupName(aligner.group));
	}
	// stick Y adjusts the selected axis: position 2 cm/s, rotation 10 deg/s
	// at full deflection, squared response
	double magnitude = fabs(in.stickY);
	double deadzone = 0.2;
	if(magnitude > deadzone && dt > 0){
		double normalized = (magnitude - deadzone) / (1.0 - deadzone);
		if(normalized > 1.0){ normalized = 1.0; }
		double rate = aligner.group == 1 ? 10.0 : 2.0;
		double delta = (in.stickY > 0 ? 1.0 : -1.0) * normalized * normalized * rate * dt;
		double* target = aligner.group == 0 ? aligner.posCm
			: (aligner.group == 1 ? aligner.rotDeg : aligner.gripCm[aligner.hand]);
		target[aligner.axis] += delta;
		double limit = aligner.group == 1 ? 90.0 : 20.0;
		if(target[aligner.axis] < -limit){ target[aligner.axis] = -limit; }
		if(target[aligner.axis] > limit){ target[aligner.axis] = limit; }
		if(now - aligner.lastLogTime > 0.3){
			aligner.lastLogTime = now;
			if(aligner.group == 2){
				DriverLog("Aligner: grip %s r=(%.2f, %.2f, %.2f)cm",
					aligner.hand == 0 ? "LEFT" : "RIGHT",
					aligner.gripCm[aligner.hand][0], aligner.gripCm[aligner.hand][1],
					aligner.gripCm[aligner.hand][2]);
			}else{
				DriverLog("Aligner: rot=(%.1f, %.1f, %.1f)deg pos=(%.2f, %.2f, %.2f)cm",
					aligner.rotDeg[0], aligner.rotDeg[1], aligner.rotDeg[2],
					aligner.posCm[0], aligner.posCm[1], aligner.posCm[2]);
			}
		}
	}
	// pivot capture on the trigger
	GalaxyXRDeviceProvider::AlignControllerState controller;
	deviceProvider.GetAlignController(aligner.hand, controller);
	bool poseFresh = controller.poseValid && now - controller.poseTime < 0.1;
	if(in.trigger > 0.6){
		if(!aligner.capturing){
			aligner.capturing = true;
			aligner.sampleQ.clear();
			aligner.sampleP.clear();
			if(aligner.group == 2){
				DriverLog("Aligner: GRIP capture STARTED (%s hand) - brace the forearm on an armrest or grip your wrist with the other hand, then swirl a wide slow cone with the controller (pure wrist rotation, no arm travel). hold ~4s",
					aligner.hand == 0 ? "left" : "right");
			}else{
				DriverLog("Aligner: pivot capture STARTED (%s hand) - keep the tip planted, swirl a wide slow cone",
					aligner.hand == 0 ? "left" : "right");
			}
		}
		if(poseFresh && now - aligner.lastSampleTime > 0.02 && aligner.sampleQ.size() < 4 * 600){
			aligner.lastSampleTime = now;
			aligner.sampleQ.push_back(controller.rot.w);
			aligner.sampleQ.push_back(controller.rot.x);
			aligner.sampleQ.push_back(controller.rot.y);
			aligner.sampleQ.push_back(controller.rot.z);
			aligner.sampleP.push_back(controller.pos[0]);
			aligner.sampleP.push_back(controller.pos[1]);
			aligner.sampleP.push_back(controller.pos[2]);
		}
	}else if(aligner.capturing && in.trigger < 0.4){
		aligner.capturing = false;
		size_t count = aligner.sampleQ.size() / 4;
		// rotation spread: max angular distance from the first sample. the
		// residual alone cannot catch a too-narrow swirl (synthetic test:
		// a 3 degree cone fits with low residual but ~7mm offset error)
		double maxSpreadDeg = 0;
		if(count > 1){
			double w0 = aligner.sampleQ[0], x0 = aligner.sampleQ[1], y0 = aligner.sampleQ[2], z0 = aligner.sampleQ[3];
			for(size_t sample = 1; sample < count; sample++){
				double dot = fabs(w0 * aligner.sampleQ[sample * 4] + x0 * aligner.sampleQ[sample * 4 + 1]
					+ y0 * aligner.sampleQ[sample * 4 + 2] + z0 * aligner.sampleQ[sample * 4 + 3]);
				if(dot > 1.0){ dot = 1.0; }
				double angle = 2.0 * acos(dot) * 180.0 / 3.14159265358979;
				if(angle > maxSpreadDeg){ maxSpreadDeg = angle; }
			}
		}
		// residual gate for the TIP solve (desk-planted, near rigid). the
		// grip solve no longer uses a whole-capture gate: field 2026-08-14
		// showed a free-space "hold the palm still" gesture fails a global
		// solve at 34mm residual — the wrist center DRIFTS slowly (arm sway,
		// carpal translation) even when deliberately held. drift is slow,
		// so short windows are still locally rigid: solve per-window and
		// take the median r. each window gets its own world pivot c, so
		// inter-window drift costs nothing.
		bool gripSolve = aligner.group == 2;
		double pivot[3], residual;
		if(count < 60){
			DriverLog("Aligner: pivot capture too short (%zu samples, need 60+ / ~2s) - discarded", count);
		}else if(gripSolve){
			const size_t win = 40;   // ~0.8s at capture cadence
			const size_t stride = 20;
			int tried = 0, accepted = 0;
			double rAcc[64][3];
			double worstRes = 0, bestRes = 1e9;
			for(size_t start = 0; start + win <= count && accepted < 64; start += stride){
				tried++;
				std::vector<double> wq(aligner.sampleQ.begin() + start * 4,
					aligner.sampleQ.begin() + (start + win) * 4);
				std::vector<double> wp(aligner.sampleP.begin() + start * 3,
					aligner.sampleP.begin() + (start + win) * 3);
				// per-window spread: 8 deg (windows are short; the 12 deg
				// whole-capture bar would reject honest slow swirls)
				double spread = 0;
				double w0 = wq[0], x0 = wq[1], y0 = wq[2], z0 = wq[3];
				for(size_t s = 1; s < win; s++){
					double dot = fabs(w0 * wq[s * 4] + x0 * wq[s * 4 + 1]
						+ y0 * wq[s * 4 + 2] + z0 * wq[s * 4 + 3]);
					if(dot > 1.0){ dot = 1.0; }
					double ang = 2.0 * acos(dot) * 180.0 / 3.14159265358979;
					if(ang > spread){ spread = ang; }
				}
				if(spread < 8.0){ continue; }
				double wPivot[3], wRes;
				if(!SolvePivot(wq, wp, wPivot, wRes)){ continue; }
				if(wRes > 0.008){
					if(wRes < bestRes){ bestRes = wRes; }
					continue;
				}
				if(wRes < bestRes){ bestRes = wRes; }
				if(wRes > worstRes){ worstRes = wRes; }
				for(int i = 0; i < 3; i++){ rAcc[accepted][i] = wPivot[i]; }
				accepted++;
			}
			double rSolved[3];
			bool haveR = false;
			const char* how = "";
			if(accepted >= 3){
				// per-component median (robust to a stray window)
				for(int i = 0; i < 3; i++){
					double vals[64];
					for(int k = 0; k < accepted; k++){ vals[k] = rAcc[k][i]; }
					for(int a = 1; a < accepted; a++){
						double key = vals[a]; int b = a - 1;
						while(b >= 0 && vals[b] > key){ vals[b + 1] = vals[b]; b--; }
						vals[b + 1] = key;
					}
					rSolved[i] = (accepted & 1) ? vals[accepted / 2]
						: 0.5 * (vals[accepted / 2 - 1] + vals[accepted / 2]);
				}
				// window consistency: rms deviation from the median. wide
				// scatter = the windows saw different pivots = arm travel,
				// not wrist rotation — the median would be meaningless
				double devSum = 0;
				for(int k = 0; k < accepted; k++){
					for(int i = 0; i < 3; i++){
						double d = rAcc[k][i] - rSolved[i];
						devSum += d * d;
					}
				}
				double scatter = sqrt(devSum / accepted);
				if(scatter <= 0.015){
					haveR = true;
					how = "windowed";
					residual = worstRes;
					DriverLog("Aligner: grip windows %d/%d accepted, scatter %.1fmm, window residuals %.1f-%.1fmm",
						accepted, tried, scatter * 1000.0, bestRes * 1000.0, worstRes * 1000.0);
				}else{
					DriverLog("Aligner: grip windows inconsistent (%d/%d accepted but r scatter %.1fmm > 15mm) - arm travelled during the swirl. brace the forearm and retry",
						accepted, tried, scatter * 1000.0);
				}
			}else if(SolvePivot(aligner.sampleQ, aligner.sampleP, pivot, residual)
					&& residual <= 0.015 && maxSpreadDeg >= 12.0){
				// full-capture fallback: a genuinely still palm can pass
				// the old gate outright even when windows were data-starved
				for(int i = 0; i < 3; i++){ rSolved[i] = pivot[i]; }
				haveR = true;
				how = "full-capture";
			}else{
				DriverLog("Aligner: grip solve FAILED (%d/%d windows accepted, best window residual %.1fmm, spread %.0fdeg) - hold the wrist stiller: brace the forearm on an armrest or grip your wrist with the other hand",
					accepted, tried, bestRes < 1e8 ? bestRes * 1000.0 : -1.0, maxSpreadDeg);
			}
			if(haveR){
				double rCm[3];
				double rMagCm = 0;
				for(int i = 0; i < 3; i++){
					rCm[i] = rSolved[i] * 100.0;
					rMagCm += rCm[i] * rCm[i];
				}
				rMagCm = sqrt(rMagCm);
				if(rMagCm > 20.0){
					DriverLog("Aligner: grip solve REJECTED - |r|=%.1fcm implausible for origin->hand (arm travel leaked in?). solve logged only: r=(%.2f, %.2f, %.2f)cm",
						rMagCm, rCm[0], rCm[1], rCm[2]);
				}else{
					for(int i = 0; i < 3; i++){ aligner.gripCm[aligner.hand][i] = rCm[i]; }
					DriverLog("Aligner: GRIP SOLVED (%s hand, %s, %zu samples): r = (%.2f, %.2f, %.2f)cm |r|=%.1fcm - live now, hold grip 1.5s to save",
						aligner.hand == 0 ? "left" : "right", how, count,
						rCm[0], rCm[1], rCm[2], rMagCm);
					DriverLog("Aligner: verify with PEAKDIAG flick unit test - a pure wrist snap should now log gOut near zero (shadow) and dirOff collapse when the compensator is enabled");
				}
			}
		}else if(maxSpreadDeg < 12.0){
			DriverLog("Aligner: swirl cone too narrow (%.0f deg spread, need 12+) - tilt the controller further around the planted tip and retry", maxSpreadDeg);
		}else if(!SolvePivot(aligner.sampleQ, aligner.sampleP, pivot, residual)){
			DriverLog("Aligner: pivot solve DEGENERATE - swirl a wider cone (more rotation spread) and retry");
		}else if(residual > 0.010){
			DriverLog("Aligner: pivot residual %.1fmm too high (tip slid or tracking glitched) - discarded", residual * 1000.0);
		}else if(!controller.tipValid){
			DriverLog("Aligner: no /pose/tip component seen for this hand - cannot relate pivot to tip, solve logged only: pivotLocal=(%.4f, %.4f, %.4f)m", pivot[0], pivot[1], pivot[2]);
		}else{
			// marker freeze condition: tipLocal + posOffset == pivot. the
			// solve ran on post-offset poses, so the correction is additive.
			double deltaCm[3];
			for(int i = 0; i < 3; i++){
				deltaCm[i] = (pivot[i] - controller.tipLocal[i]) * 100.0;
				aligner.posCm[i] += deltaCm[i];
			}
			DriverLog("Aligner: pivot SOLVED (%s hand, %zu samples, residual %.1fmm): position offset += (%.2f, %.2f, %.2f)cm -> (%.2f, %.2f, %.2f)cm",
				aligner.hand == 0 ? "left" : "right", count, residual * 1000.0,
				deltaCm[0], deltaCm[1], deltaCm[2],
				aligner.posCm[0], aligner.posCm[1], aligner.posCm[2]);
			DriverLog("Aligner: verify by swirling again WITHOUT the trigger - the magenta marker should now stay frozen");
		}
	}
	// save
	if(in.grip > 0.8){
		if(!aligner.gripWasHigh){
			aligner.gripWasHigh = true;
			aligner.gripHoldStart = now;
			aligner.savedThisHold = false;
		}else if(!aligner.savedThisHold && now - aligner.gripHoldStart > 1.5){
			aligner.savedThisHold = true;
			SaveControllerOffsets();
		}
	}else if(in.grip < 0.5){
		aligner.gripWasHigh = false;
	}
	// push the working offsets into the pose path (live) - grip too, so a
	// fresh solve is scoreable by the very next PEAKDIAG gesture
	deviceProvider.SetAlignerOffsets(true, aligner.rotDeg, aligner.posCm);
	deviceProvider.SetAlignerGrip(true, aligner.gripCm);
	// tip marker for the selected hand, in head space (y up, -z forward)
	if(poseFresh && controller.tipValid && headBasisValid){
		double tipWorld[3];
		double tipLocal[3] = {controller.tipLocal[0], controller.tipLocal[1], controller.tipLocal[2]};
		double rotated[3];
		ShimQuatRotate(controller.rot, tipLocal, rotated);
		for(int i = 0; i < 3; i++){
			tipWorld[i] = controller.pos[i] + rotated[i];
		}
		double rel[3] = {tipWorld[0] - headPosW[0], tipWorld[1] - headPosW[1], tipWorld[2] - headPosW[2]};
		settings.auxHeadX = rel[0] * headBasisW[0][0] + rel[1] * headBasisW[0][1] + rel[2] * headBasisW[0][2];
		settings.auxHeadY = rel[0] * headBasisW[1][0] + rel[1] * headBasisW[1][1] + rel[2] * headBasisW[1][2];
		settings.auxHeadZ = rel[0] * headBasisW[2][0] + rel[1] * headBasisW[2][1] + rel[2] * headBasisW[2][2];
		settings.auxMarkerMode = 3;
	}
}

void DirectModeComponentShim::SaveControllerOffsets(){
	using nlohmann::json;
	json block = {
		{"controllers", {
			{"rotationOffsetDeg", {{"x", aligner.rotDeg[0]}, {"y", aligner.rotDeg[1]}, {"z", aligner.rotDeg[2]}}},
			{"positionOffsetCm", {{"x", aligner.posCm[0]}, {"y", aligner.posCm[1]}, {"z", aligner.posCm[2]}}},
		}},
		{"streamFrame", {
			{"kalmanGripLeftCm", {{"x", aligner.gripCm[0][0]}, {"y", aligner.gripCm[0][1]}, {"z", aligner.gripCm[0][2]}}},
			{"kalmanGripRightCm", {{"x", aligner.gripCm[1][0]}, {"y", aligner.gripCm[1][1]}, {"z", aligner.gripCm[1][2]}}},
		}},
	};
	char stamp[32];
	time_t rawTime = time(nullptr);
	struct tm timeInfo;
#ifdef _WIN32
	localtime_s(&timeInfo, &rawTime);
#else
	localtime_r(&rawTime, &timeInfo);
#endif
	strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", &timeInfo);
	std::string folder = driverConfigLoader.GetConfigFolder();
	std::string path = folder + "controllers-" + stamp + ".json";
	std::ofstream out(path);
	bool ok = false;
	if(out){
		out << block.dump(2);
		ok = out.good();
	}
	DriverLog("Aligner: %s %s", ok ? "SAVED" : "FAILED to write", path.c_str());
	DriverLog("Aligner: settings block: %s", block.dump().c_str());
}

bool DirectModeComponentShim::SolvePivot(const std::vector<double> &sampleQ, const std::vector<double> &sampleP,
		double pivotLocal[3], double &residualM){
	// equations R_i o - c = -p_i; normal equations, 6 unknowns [o; c].
	// rotations are orthonormal so the top-left block is N*I exactly.
	size_t count = sampleQ.size() / 4;
	if(count < 10 || sampleP.size() / 3 != count){
		return false;
	}
	double SR[3][3] = {}; double SRt[3][3] = {};
	double SRtp[3] = {}; double Sp[3] = {};
	auto rotColumns = [](const double q[4], double columns[3][3]){
		// columns[j] = R * e_j from the quaternion (w, x, y, z)
		double w = q[0], x = q[1], y = q[2], z = q[3];
		columns[0][0] = 1 - 2 * (y * y + z * z);
		columns[0][1] = 2 * (x * y + w * z);
		columns[0][2] = 2 * (x * z - w * y);
		columns[1][0] = 2 * (x * y - w * z);
		columns[1][1] = 1 - 2 * (x * x + z * z);
		columns[1][2] = 2 * (y * z + w * x);
		columns[2][0] = 2 * (x * z + w * y);
		columns[2][1] = 2 * (y * z - w * x);
		columns[2][2] = 1 - 2 * (x * x + y * y);
	};
	for(size_t sample = 0; sample < count; sample++){
		double q[4] = {sampleQ[sample * 4], sampleQ[sample * 4 + 1], sampleQ[sample * 4 + 2], sampleQ[sample * 4 + 3]};
		const double* p = &sampleP[sample * 3];
		double columns[3][3];
		rotColumns(q, columns);
		for(int i = 0; i < 3; i++){
			for(int j = 0; j < 3; j++){
				SR[i][j] += columns[j][i];   // R_ij
				SRt[i][j] += columns[i][j];  // (R^T)_ij = R_ji
			}
		}
		for(int i = 0; i < 3; i++){
			double rtp = columns[i][0] * p[0] + columns[i][1] * p[1] + columns[i][2] * p[2]; // (R^T p)_i
			SRtp[i] += rtp;
			Sp[i] += p[i];
		}
	}
	double matrix[6][7] = {};
	double n = (double)count;
	for(int i = 0; i < 3; i++){
		matrix[i][i] = n;
		for(int j = 0; j < 3; j++){ matrix[i][3 + j] = -SRt[i][j]; }
		matrix[i][6] = -SRtp[i];
	}
	for(int i = 0; i < 3; i++){
		for(int j = 0; j < 3; j++){ matrix[3 + i][j] = -SR[i][j]; }
		matrix[3 + i][3 + i] = n;
		matrix[3 + i][6] = Sp[i];
	}
	// gauss-jordan with partial pivoting; a tiny pivot means the rotations
	// had no spread (pure translation swirl) and the system is degenerate
	for(int col = 0; col < 6; col++){
		int best = col;
		for(int row = col + 1; row < 6; row++){
			if(fabs(matrix[row][col]) > fabs(matrix[best][col])){ best = row; }
		}
		if(fabs(matrix[best][col]) < 1e-6 * n){
			return false;
		}
		if(best != col){
			for(int cc = 0; cc < 7; cc++){
				double tmp = matrix[col][cc];
				matrix[col][cc] = matrix[best][cc];
				matrix[best][cc] = tmp;
			}
		}
		for(int row = 0; row < 6; row++){
			if(row == col){ continue; }
			double factor = matrix[row][col] / matrix[col][col];
			for(int cc = col; cc < 7; cc++){
				matrix[row][cc] -= factor * matrix[col][cc];
			}
		}
	}
	double solution[6];
	for(int i = 0; i < 6; i++){
		solution[i] = matrix[i][6] / matrix[i][i];
	}
	pivotLocal[0] = solution[0];
	pivotLocal[1] = solution[1];
	pivotLocal[2] = solution[2];
	// residual: rms of |R o + p - c|
	double sum = 0;
	for(size_t sample = 0; sample < count; sample++){
		double q[4] = {sampleQ[sample * 4], sampleQ[sample * 4 + 1], sampleQ[sample * 4 + 2], sampleQ[sample * 4 + 3]};
		const double* p = &sampleP[sample * 3];
		double columns[3][3];
		rotColumns(q, columns);
		for(int i = 0; i < 3; i++){
			double world = columns[0][i] * pivotLocal[0] + columns[1][i] * pivotLocal[1] + columns[2][i] * pivotLocal[2];
			double diff = world + p[i] - solution[3 + i];
			sum += diff * diff;
		}
	}
	residualM = sqrt(sum / (double)count);
	return true;
}

// ---------------------------------------------------------------------------
// interactive distortion tuner
// ---------------------------------------------------------------------------
// the eye-tracked VOR probe failed as a fitter: eye-tracker error grows with
// eccentricity at the same magnitude as the lens residual, the published gaze
// is a single cyclopean ray (per-eye fits are illusory), and ET coverage dies
// around r~0.36 while the swim lives out to the corners. the human visual
// system has none of these limits: motion/vernier sensitivity is arcminute
// level across the whole lens. so the human becomes the null detector: while
// tuning, the frame's distortion is replaced by a per-band working curve
// edited live from the controllers, against the warped angular grid, until
// each highlighted band stops swimming during slow head rotation.
//
// controls (confirmed vrlink surface): joystick y nudges the active band's
// scale (squared response for fine work near center), A steps the band
// outward, B inward, X cycles linked/left/right eye editing (the ring only
// draws in the eyes being edited), Y resets the band to its activation
// value, holding either grip ~1.5s saves an importable profile json.

// cosine periodic interpolation of per-segment values (authored at segment
// centers) evaluated at `turns` in [0,1). same math as the shader's
// SampleLutSegmented, kept in lockstep so flattening is exact at row centers.
static double InterpSegmented(const std::vector<double> &vals, double turns){
	int n = (int)vals.size();
	if(n <= 1){
		return vals.empty() ? 0.0 : vals[0];
	}
	double f = turns * n - 0.5;
	double s0 = floor(f);
	double w = f - s0;
	w = 0.5 - 0.5 * cos(w * 3.14159265358979323846);
	int a = ((int)s0 % n + n) % n;
	int b = (a + 1) % n;
	return vals[a] * (1.0 - w) + vals[b] * w;
}

void DirectModeComponentShim::UpdateTuner(FrameProcessSettings &settings){
	bool enable = settings.config.distortion.tune.enable;
	deviceProvider.SetTunerInputActive(enable);
	if(!enable){
		if(tuner.active){
			tuner.active = false;
			DriverLog("Tuner: disabled (working curve dropped; the saved/configured profile applies again)");
		}
		return;
	}
	double now = NowSeconds();
	if(!tuner.active){
		// sanitize band radii from config
		tuner.bandR.clear();
		for(double r : settings.config.distortion.tune.bands){
			if(r > 0.02 && r < 1.2){ tuner.bandR.push_back(r); }
		}
		std::sort(tuner.bandR.begin(), tuner.bandR.end());
		if(tuner.bandR.empty()){
			tuner.bandR = {0.15, 0.22, 0.30, 0.38, 0.46, 0.55, 0.65};
		}
		int n = (int)tuner.bandR.size();
		tuner.scaleL.assign(n, 1.0);
		tuner.scaleR.assign(n, 1.0);
		// initialize each band from the CURRENT effective curve (gain
		// applied), so tuning refines whatever profile is loaded instead
		// of discarding it. missing per-eye keys fall back to the base
		// curve, matching the lut bake's ResolveCurve semantics.
		const StreamFrameDistortionConfig &d = settings.config.distortion;
		bool spline = d.mode == "spline";
		for(int eye = 0; eye < 2; eye++){
			double baseK1 = settings.config.k1;
			double baseK2 = settings.config.k2;
			const std::vector<StreamFrameDistortionPoint>* pts = &d.points;
			if(d.perEye){
				auto found = d.curves.find(eye == 0 ? "left" : "right");
				if(found != d.curves.end()){
					baseK1 = found->second.k1;
					baseK2 = found->second.k2;
					pts = &found->second.points;
				}
			}
			std::vector<StreamFrameDistortionPoint> sorted = *pts;
			std::sort(sorted.begin(), sorted.end(),
				[](const StreamFrameDistortionPoint &a, const StreamFrameDistortionPoint &b){ return a.r < b.r; });
			for(int i = 0; i < n; i++){
				double r = tuner.bandR[i];
				double scale;
				if(spline){
					scale = EvaluateDistortionCurve(sorted, r);
				}else{
					double r2 = r * r;
					scale = 1.0 + baseK1 * r2 + baseK2 * r2 * r2;
				}
				scale = 1.0 + d.gain * (scale - 1.0);
				if(scale < 0.85){ scale = 0.85; }
				if(scale > 1.15){ scale = 1.15; }
				(eye == 0 ? tuner.scaleL : tuner.scaleR)[i] = scale;
			}
		}
		tuner.initL = tuner.scaleL;
		tuner.initR = tuner.scaleR;
		// band segments: deltas on top of the base band values, initialized
		// from any existing segment curves ("left#s") so a segmented
		// profile can be refined instead of restarted. missing keys = 0.
		// per-band segment layout: explicit list wins; empty = uniform
		// `segments` (legacy select). counts clamp 1..32; a shorter list
		// repeats its last entry across the remaining (outer) bands.
		{
			const auto &layout = settings.config.distortion.tune.segmentLayout;
			int uniform = settings.config.distortion.tune.segments;
			if(uniform < 1){ uniform = 1; }
			if(uniform > 32){ uniform = 32; }
			tuner.segCounts.assign(n, uniform);
			if(!layout.empty()){
				for(int i = 0; i < n; i++){
					int c = layout[i < (int)layout.size() ? i : (int)layout.size() - 1];
					if(c < 1){ c = 1; }
					if(c > 32){ c = 32; }
					tuner.segCounts[i] = c;
				}
			}
			tuner.segCount = 1;
			for(int c : tuner.segCounts){
				if(c > tuner.segCount){ tuner.segCount = c; }
			}
		}
		tuner.seg = -1;
		tuner.segDeltaL.assign(n, std::vector<double>());
		tuner.segDeltaR.assign(n, std::vector<double>());
		for(int i = 0; i < n; i++){
			tuner.segDeltaL[i].assign(tuner.segCounts[i], 0.0);
			tuner.segDeltaR[i].assign(tuner.segCounts[i], 0.0);
		}
		if(tuner.segCount > 1){
			// re-tune continuation: recover per-band deltas by evaluating
			// the existing (uniform-count) segment curves angularly at THIS
			// band's own segment centers. exact when the counts match,
			// gently smoothed when the layout changed between sessions.
			const StreamFrameDistortionConfig &dd = settings.config.distortion;
			int prevRows = dd.segments;
			if(prevRows > 1){
				for(int eye = 0; eye < 2; eye++){
					std::vector<std::vector<StreamFrameDistortionPoint>> rowPts(prevRows);
					bool any = false;
					for(int sg = 0; sg < prevRows; sg++){
						auto found = dd.curves.find(std::string(eye == 0 ? "left" : "right") + "#" + std::to_string(sg));
						if(found == dd.curves.end() || found->second.points.empty()){
							continue;
						}
						rowPts[sg] = found->second.points;
						std::sort(rowPts[sg].begin(), rowPts[sg].end(),
							[](const StreamFrameDistortionPoint &a, const StreamFrameDistortionPoint &b){ return a.r < b.r; });
						any = true;
					}
					if(!any){
						continue;
					}
					for(int i = 0; i < n; i++){
						std::vector<double> rowVals(prevRows);
						for(int sg = 0; sg < prevRows; sg++){
							if(rowPts[sg].empty()){
								rowVals[sg] = (eye == 0 ? tuner.scaleL : tuner.scaleR)[i];
							}else{
								double v = EvaluateDistortionCurve(rowPts[sg], tuner.bandR[i]);
								rowVals[sg] = 1.0 + dd.gain * (v - 1.0);
							}
						}
						for(int k = 0; k < tuner.segCounts[i]; k++){
							double turns = (k + 0.5) / tuner.segCounts[i];
							double delta = InterpSegmented(rowVals, turns)
								- (eye == 0 ? tuner.scaleL : tuner.scaleR)[i];
							if(delta < -0.3){ delta = -0.3; }
							if(delta > 0.3){ delta = 0.3; }
							(eye == 0 ? tuner.segDeltaL : tuner.segDeltaR)[i][k] = delta;
						}
					}
				}
			}
		}
		tuner.initSegL = tuner.segDeltaL;
		tuner.initSegR = tuner.segDeltaR;
		tuner.band = 0;
		tuner.eyeMode = 0;
		tuner.prevBandOut = tuner.prevBandIn = tuner.prevEyeToggle = tuner.prevReset = false;
		tuner.prevSegToggle = false;
		tuner.lastTime = now;
		tuner.gripWasHigh = false;
		tuner.savedThisHold = false;
		tuner.lastNudgeLogTime = 0;
		tuner.active = true;
		if(tuner.segCount > 1){
			std::string layoutStr;
			for(int i = 0; i < n; i++){
				layoutStr += (i ? "," : "") + std::to_string(tuner.segCounts[i]);
			}
			DriverLog("Tuner: ACTIVE bands=%d (r %.2f..%.2f) SEGMENTS per band: %s, initialized from the current curve. "
				"Controls: stick Y = adjust, A/B = band out/in, X = walk ALL -> segments of the current band "
				"(0 deg = screen right, increasing toward screen down), stick CLICK = eye linked/L/R, "
				"Y = reset, hold grip 1.5s = save",
				n, tuner.bandR.front(), tuner.bandR.back(), layoutStr.c_str());
		}else{
			DriverLog("Tuner: ACTIVE bands=%d (r %.2f..%.2f), initialized from the current curve. "
				"Controls: stick Y = adjust band, A/B = band out/in, X = eye linked/L/R, Y = reset band, hold grip 1.5s = save profile",
				n, tuner.bandR.front(), tuner.bandR.back());
		}
	}
	int n = (int)tuner.bandR.size();
	double dt = now - tuner.lastTime;
	tuner.lastTime = now;
	if(dt < 0 || dt > 0.5){ dt = 0; }
	GalaxyXRDeviceProvider::TunerInputState in;
	deviceProvider.GetTunerInput(in);
	// discrete actions on rising edges
	auto edge = [](bool current, bool &previous){
		bool rising = current && !previous;
		previous = current;
		return rising;
	};
	if(edge(in.bandOut, tuner.prevBandOut) && tuner.band < n - 1){
		tuner.band++;
		tuner.seg = -1; // counts differ per band: the walk restarts at ALL
		DriverLog("Tuner: band %d/%d r=%.2f (L=%.4f R=%.4f)%s", tuner.band + 1, n,
			tuner.bandR[tuner.band], tuner.scaleL[tuner.band], tuner.scaleR[tuner.band],
			tuner.segCount > 1 ? (" segments=" + std::to_string(tuner.segCounts[tuner.band])).c_str() : "");
	}
	if(edge(in.bandIn, tuner.prevBandIn) && tuner.band > 0){
		tuner.band--;
		tuner.seg = -1;
		DriverLog("Tuner: band %d/%d r=%.2f (L=%.4f R=%.4f)%s", tuner.band + 1, n,
			tuner.bandR[tuner.band], tuner.scaleL[tuner.band], tuner.scaleR[tuner.band],
			tuner.segCount > 1 ? (" segments=" + std::to_string(tuner.segCounts[tuner.band])).c_str() : "");
	}
	// control map: classic sessions keep X = eye cycle. segmented sessions
	// SWAP the pair — segment walking is the frequent action, so it gets
	// the easy button: X walks segments, stick click cycles eyes.
	bool xEdge = edge(in.eyeToggle, tuner.prevEyeToggle);
	bool stickEdge = edge(in.segToggle, tuner.prevSegToggle);
	bool eyeCyclePressed = tuner.segCount > 1 ? stickEdge : xEdge;
	bool segWalkPressed = tuner.segCount > 1 ? xEdge : false;
	if(eyeCyclePressed){
		tuner.eyeMode = (tuner.eyeMode + 1) % 3;
		DriverLog("Tuner: editing %s", tuner.eyeMode == 0 ? "BOTH eyes (linked)" : (tuner.eyeMode == 1 ? "LEFT eye" : "RIGHT eye"));
	}
	if(segWalkPressed){
		// walk ALL(-1) -> 0 -> .. -> count-1 -> ALL within the CURRENT band
		int bandCount = tuner.segCounts[tuner.band];
		if(bandCount <= 1){
			tuner.seg = -1;
			DriverLog("Tuner: band %d has 1 segment (radial only here)", tuner.band + 1);
		}else{
			tuner.seg = tuner.seg + 1 >= bandCount ? -1 : tuner.seg + 1;
			if(tuner.seg < 0){
				DriverLog("Tuner: segment ALL (base band editing, deltas stay)");
			}else{
				double a0 = 360.0 * tuner.seg / bandCount;
				double a1 = 360.0 * (tuner.seg + 1) / bandCount;
				DriverLog("Tuner: segment %d/%d (%.0f-%.0f deg; 0 = screen right, increasing toward screen down) "
					"band %d delta L=%+.4f R=%+.4f",
					tuner.seg + 1, bandCount, a0, a1, tuner.band + 1,
					tuner.segDeltaL[tuner.band][tuner.seg], tuner.segDeltaR[tuner.band][tuner.seg]);
			}
		}
	}
	if(edge(in.resetBand, tuner.prevReset)){
		if(tuner.seg < 0){
			if(tuner.eyeMode != 2){ tuner.scaleL[tuner.band] = tuner.initL[tuner.band]; }
			if(tuner.eyeMode != 1){ tuner.scaleR[tuner.band] = tuner.initR[tuner.band]; }
			DriverLog("Tuner: band %d reset to activation value (L=%.4f R=%.4f)",
				tuner.band + 1, tuner.scaleL[tuner.band], tuner.scaleR[tuner.band]);
		}else{
			if(tuner.eyeMode != 2){ tuner.segDeltaL[tuner.band][tuner.seg] = tuner.initSegL[tuner.band][tuner.seg]; }
			if(tuner.eyeMode != 1){ tuner.segDeltaR[tuner.band][tuner.seg] = tuner.initSegR[tuner.band][tuner.seg]; }
			DriverLog("Tuner: band %d segment %d reset to activation delta (L=%+.4f R=%+.4f)",
				tuner.band + 1, tuner.seg + 1,
				tuner.segDeltaL[tuner.band][tuner.seg], tuner.segDeltaR[tuner.band][tuner.seg]);
		}
	}
	// stick nudge. analog by default (deadzone + squared response); when
	// stepSize > 0, deterministic fixed steps every 100ms while deflected
	// past halfway ("one click at a time" fine nulling)
	double y = in.stickY;
	double magnitude = fabs(y);
	double delta = 0;
	double stepSize = settings.config.distortion.tune.stepSize;
	if(stepSize > 0){
		if(stepSize > 0.05){ stepSize = 0.05; }
		if(magnitude > 0.5){
			if(now - tuner.lastStepTime >= 0.1){
				tuner.lastStepTime = now;
				delta = (y > 0 ? 1.0 : -1.0) * stepSize;
			}
		}else{
			// re-arm so the first step after a fresh deflection is immediate
			tuner.lastStepTime = now - 0.1;
		}
	}else{
		double deadzone = 0.2;
		if(magnitude > deadzone && dt > 0){
			double normalized = (magnitude - deadzone) / (1.0 - deadzone);
			if(normalized > 1.0){ normalized = 1.0; }
			double rate = settings.config.distortion.tune.rate;
			if(rate < 0.005){ rate = 0.005; }
			if(rate > 0.5){ rate = 0.5; }
			delta = (y > 0 ? 1.0 : -1.0) * normalized * normalized * rate * dt;
		}
	}
	if(delta != 0){
		if(tuner.seg < 0){
			auto apply = [&](std::vector<double> &scales){
				scales[tuner.band] += delta;
				if(scales[tuner.band] < 0.85){ scales[tuner.band] = 0.85; }
				if(scales[tuner.band] > 1.15){ scales[tuner.band] = 1.15; }
			};
			if(tuner.eyeMode != 2){ apply(tuner.scaleL); }
			if(tuner.eyeMode != 1){ apply(tuner.scaleR); }
			if(stepSize > 0 || now - tuner.lastNudgeLogTime > 0.3){
				tuner.lastNudgeLogTime = now;
				DriverLog("Tuner: band %d/%d r=%.2f L=%.4f R=%.4f", tuner.band + 1, n,
					tuner.bandR[tuner.band], tuner.scaleL[tuner.band], tuner.scaleR[tuner.band]);
			}
		}else{
			// segment delta editing: the combined value (base + delta) obeys
			// the same [0.85, 1.15] clamp as base editing
			auto applySeg = [&](std::vector<double> &scales, std::vector<std::vector<double>> &deltas){
				double &dref = deltas[tuner.band][tuner.seg];
				dref += delta;
				double lo = 0.85 - scales[tuner.band];
				double hi = 1.15 - scales[tuner.band];
				if(dref < lo){ dref = lo; }
				if(dref > hi){ dref = hi; }
			};
			if(tuner.eyeMode != 2){ applySeg(tuner.scaleL, tuner.segDeltaL); }
			if(tuner.eyeMode != 1){ applySeg(tuner.scaleR, tuner.segDeltaR); }
			if(stepSize > 0 || now - tuner.lastNudgeLogTime > 0.3){
				tuner.lastNudgeLogTime = now;
				DriverLog("Tuner: band %d/%d seg %d/%d r=%.2f delta L=%+.4f R=%+.4f", tuner.band + 1, n,
					tuner.seg + 1, tuner.segCount, tuner.bandR[tuner.band],
					tuner.segDeltaL[tuner.band][tuner.seg], tuner.segDeltaR[tuner.band][tuner.seg]);
			}
		}
	}
	// hold either grip to save; latch so one hold saves exactly once
	if(in.grip > 0.8){
		if(!tuner.gripWasHigh){
			tuner.gripWasHigh = true;
			tuner.gripHoldStart = now;
			tuner.savedThisHold = false;
		}else if(!tuner.savedThisHold && now - tuner.gripHoldStart > 1.5){
			tuner.savedThisHold = true;
			SaveTunedProfile(settings);
		}
	}else if(in.grip < 0.5){
		tuner.gripWasHigh = false;
	}
	// ---- take over this frame's distortion with the working curves ----
	StreamFrameDistortionConfig &d = settings.config.distortion;
	auto buildPoints = [&](const std::vector<double> &scales){
		std::vector<StreamFrameDistortionPoint> points;
		// inner identity guard, built to mirror the OUTER taper exactly: the
		// guard is the FIRST knot, so everything inside it is the
		// evaluator's front-clamp — mathematically flat 1.0. an extra r=0
		// anchor knot here was WRONG: between two knots the catmull-rom
		// tangent at the guard (fed by the first band's value) made the
		// "flat" span dip below identity (session 25 exaggerated-curve
		// demo). flat regions must live OUTSIDE the knot range, never
		// between knots.
		StreamFrameDistortionPoint inner;
		inner.scale = 1.0;
		if(n > 0 && tuner.bandR[0] > 0.08){
			inner.r = tuner.bandR[0] - 0.06;
		}else{
			inner.r = 0.0;
		}
		points.push_back(inner);
		for(int i = 0; i < n; i++){
			StreamFrameDistortionPoint point;
			point.r = tuner.bandR[i];
			point.scale = scales[i];
			points.push_back(point);
		}
		// past the last band the curve returns to identity (short blend to
		// avoid a visible crease) instead of freezing the last value over
		// the whole unmeasured periphery
		if(n > 0){
			StreamFrameDistortionPoint taper;
			taper.r = tuner.bandR[n - 1] + 0.08;
			taper.scale = 1.0;
			points.push_back(taper);
		}
		return points;
	};
	d.mode = "spline";
	d.perEye = true;
	d.perAxis = false;
	d.gain = 1.0;
	d.points.clear();
	d.annulus.enable = false;
	d.curves["left"].k1 = 0;
	d.curves["left"].k2 = 0;
	d.curves["left"].points = buildPoints(tuner.scaleL);
	d.curves["right"].k1 = 0;
	d.curves["right"].k2 = 0;
	d.curves["right"].points = buildPoints(tuner.scaleR);
	// band segments: one working curve per angular segment (base + delta),
	// same guard/taper law as the base curve
	d.segments = tuner.segCount;
	if(tuner.segCount > 1){
		// flatten the per-band layout into uniform max-count rows: each
		// row's band-i knot is the band's OWN angular function evaluated
		// at the row center. exact for bands whose count == the row count.
		std::vector<double> combined(n);
		for(int eye = 0; eye < 2; eye++){
			for(int sg = 0; sg < tuner.segCount; sg++){
				double turns = (sg + 0.5) / tuner.segCount;
				const auto &base = eye == 0 ? tuner.scaleL : tuner.scaleR;
				const auto &deltas = eye == 0 ? tuner.segDeltaL : tuner.segDeltaR;
				for(int i = 0; i < n; i++){
					combined[i] = base[i] + InterpSegmented(deltas[i], turns);
				}
				std::string segKey = std::string(eye == 0 ? "left" : "right") + "#" + std::to_string(sg);
				d.curves[segKey].k1 = 0;
				d.curves[segKey].k2 = 0;
				d.curves[segKey].points = buildPoints(combined);
			}
		}
	}
	// force the calibration view on (warped angular grid + warped overlays)
	// unless the user opted to bring their own overlays (forceGrid off:
	// tune against game content, or the world-locked grid variant)
	if(settings.config.distortion.tune.forceGrid){
		settings.config.eyeGaze.debugGrid = true;
		// force ANGULAR mode: the nulling stimulus, and the only mode the
		// world-locked option exists in — with the configured 'uv' default
		// the forced grid silently ignored World-Locked (session 25 report)
		settings.config.eyeGaze.gridMode = "angular";
		settings.config.eyeGaze.overlayWarped = true;
	}
	// band highlight for the shader (per-eye gating in ProcessEye)
	settings.tuneActive = true;
	settings.tuneRingR = tuner.bandR[tuner.band];
	settings.tuneEyeMode = tuner.eyeMode;
	settings.tuneSegIndex = tuner.segCount > 1 ? tuner.seg : -1;
	settings.tuneSegCount = tuner.segCount > 1 ? tuner.segCounts[tuner.band] : 0;
}

void DirectModeComponentShim::SaveTunedProfile(const FrameProcessSettings &settings){
	using nlohmann::json;
	int n = (int)tuner.bandR.size();
	auto pointsJson = [&](const std::vector<double> &scales){
		json points = json::array();
		// inner guard as the FIRST knot (front-clamp flat inside it),
		// matching the live curve — no r=0 anchor, see buildPoints
		if(n > 0 && tuner.bandR[0] > 0.08){
			points.push_back({{"r", tuner.bandR[0] - 0.06}, {"scale", 1.0}});
		}else{
			points.push_back({{"r", 0.0}, {"scale", 1.0}});
		}
		for(int i = 0; i < n; i++){
			// round through text once so the file matches what the log shows
			points.push_back({{"r", tuner.bandR[i]}, {"scale", (double)((long long)(scales[i] * 100000.0 + (scales[i] >= 0 ? 0.5 : -0.5))) / 100000.0}});
		}
		// identity taper past the last band, matching the live curve
		if(n > 0){
			points.push_back({{"r", tuner.bandR[n - 1] + 0.08}, {"scale", 1.0}});
		}
		return points;
	};
	char stamp[32];
	time_t rawTime = time(nullptr);
	struct tm timeInfo;
#ifdef _WIN32
	localtime_s(&timeInfo, &rawTime);
#else
	localtime_r(&rawTime, &timeInfo);
#endif
	strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", &timeInfo);
	json curves = {
		{"left", {{"k1", 0}, {"k2", 0}, {"points", pointsJson(tuner.scaleL)}}},
		{"right", {{"k1", 0}, {"k2", 0}, {"points", pointsJson(tuner.scaleR)}}},
	};
	if(tuner.segCount > 1){
		std::vector<double> combined(n);
		for(int eye = 0; eye < 2; eye++){
			for(int sg = 0; sg < tuner.segCount; sg++){
				double turns = (sg + 0.5) / tuner.segCount;
				const auto &base = eye == 0 ? tuner.scaleL : tuner.scaleR;
				const auto &deltas = eye == 0 ? tuner.segDeltaL : tuner.segDeltaR;
				for(int i = 0; i < n; i++){
					combined[i] = base[i] + InterpSegmented(deltas[i], turns);
				}
				curves[std::string(eye == 0 ? "left" : "right") + "#" + std::to_string(sg)] =
					{{"k1", 0}, {"k2", 0}, {"points", pointsJson(combined)}};
			}
		}
	}
	json profile = {
		{"type", "streamFrameDistortionProfile"},
		{"version", 1},
		{"name", std::string("Tuned ") + stamp},
		{"distortion", {
			{"mode", "spline"},
			{"points", json::array()},
			{"perEye", true},
			{"perAxis", false},
			{"segments", tuner.segCount},
			{"curves", curves},
		}},
		{"tuneSegmentLayout", tuner.segCounts},
		{"k1", 0},
		{"k2", 0},
		{"centerOffsetXLeft", settings.config.centerOffsetXLeft},
		{"centerOffsetXRight", settings.config.centerOffsetXRight},
		{"centerOffsetY", settings.config.centerOffsetY},
	};
	std::string folder = driverConfigLoader.GetConfigFolder() + "Distortion/";
	std::error_code ec;
	std::filesystem::create_directories(folder, ec);
	std::string path = folder + "tuned-" + stamp + ".json";
	std::ofstream out(path);
	bool ok = false;
	if(out){
		out << profile.dump(2);
		ok = out.good();
	}
	if(ok){
		DriverLog("Tuner: SAVED profile to %s (import it from the GUI, or paste the block below into streamFrame)", path.c_str());
	}else{
		DriverLog("Tuner: FAILED to write %s, paste block below instead", path.c_str());
	}
	// paste-ready single-line block so a lost file never loses a tune
	json paste = {{"distortion", {{"mode", "spline"}, {"perEye", true}, {"gain", 1.0}, {"segments", tuner.segCount}, {"curves", curves}}}};
	DriverLog("Tuner: settings block: %s", paste.dump().c_str());
}

bool DirectModeComponentShim::GetActiveSettings(FrameProcessSettings &settings, bool &processAtSubmit){
	{
		std::lock_guard<std::mutex> configGuard(driverConfigLock);
		// 2026-09-25: gaze prediction must read the saved settings, not the
		// default-constructed frame snapshot. Resolve every consumer first.
		settings.config = driverConfig.streamFrame;
		processAtSubmit = driverConfig.streamFrame.processAtSubmitLayer;
		// 2026-09-19 SDR10 baseline: resolve the effective color policy from
		// the SAME snapshot under the SAME lock so eye and encoder settings
		// cannot mix stored settings with a different baseline policy.
		settings.policy = gxr::ResolveSdr10Policy(driverConfig);
		// 2026-09-25: require explicit SDR10 enhancement consent for old/external files too.
		settings.config.enable = gxr::ImageEnhancementsEnabled(settings.config, settings.policy);
		if(driverConfigLoader.info.isDashboardOpen && driverConfig.streamFrame.skipColorWhileDashboardOpen){
			settings.applyColor = false;
		}
		// Publish before releasing the config lock so an older scene snapshot
		// cannot undo a newer provider OFF/consent update. Post-pack CAS has
		// no eye-texture work of its own, so this precedes the activity gate.
		FrameProcessor::UpdateEncoderSettings(settings);
	}
	// live gaze for the frame about to be processed (dynamic pupil swim /
	// gaze debug). 100ms staleness guard: a brief hiccup degrades to the
	// static behavior instead of consuming stale gaze.
	EyeTrackingTap::Sample gaze;
	if(eyeTrackingTap.GetLatestSample(gaze, 0.1) && gaze.valid){
		settings.gazeValid = true;
		// raw gaze as published, for the swim probe (fitting must see the
		// unsmoothed signal; the adaptive smoothing lags during VOR)
		settings.gazeRawDirX = gaze.targetX;
		settings.gazeRawDirY = gaze.targetY;
		settings.gazeRawDirZ = gaze.targetZ;
		settings.gazeAgeMs = (NowSeconds() - gaze.receivedTime) * 1000.0;
		double dir[3] = { gaze.targetX, gaze.targetY, gaze.targetZ };
		// latency compensation: extrapolate along the recent gaze motion.
		// smoothed delta keeps saccade overshoot bounded; lead is clamped.
		double leadMs = settings.config.eyeGaze.predictionMs;
		if(leadMs < 0){ leadMs = 0; }
		if(leadMs > 100){ leadMs = 100; }
		if(leadMs > 0 && gazePrevValid && gaze.receivedTime > gazePrevTime){
			double dt = gaze.receivedTime - gazePrevTime;
			if(dt > 0.0005 && dt < 0.1){
				for(int i = 0; i < 3; i++){
					double instant = (dir[i] - gazePrevDir[i]) / dt;
					gazeVelEma[i] = gazeVelEma[i] * 0.6 + instant * 0.4;
					dir[i] += gazeVelEma[i] * leadMs / 1000.0;
				}
				double n = sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]);
				if(n > 0.001){
					dir[0] /= n; dir[1] /= n; dir[2] /= n;
				}
			}
		}
		if(!gazePrevValid || gaze.receivedTime != gazePrevTime){
			gazePrevDir[0] = gaze.targetX;
			gazePrevDir[1] = gaze.targetY;
			gazePrevDir[2] = gaze.targetZ;
			gazePrevTime = gaze.receivedTime;
			gazePrevValid = true;
		}
		// speed-adaptive smoothing: the correction must follow FIXATIONS,
		// not sensor noise. large deltas pass almost unfiltered (the snap
		// lands inside the saccade, where vision is suppressed anyway);
		// sub-degree jitter is heavily damped so the corrected world is
		// rock solid while fixating.
		if(!gazeSmoothValid){
			gazeSmoothValid = true;
			gazeSmoothEma[0] = dir[0]; gazeSmoothEma[1] = dir[1]; gazeSmoothEma[2] = dir[2];
		}else{
			double d = gazeSmoothEma[0] * dir[0] + gazeSmoothEma[1] * dir[1] + gazeSmoothEma[2] * dir[2];
			if(d > 1.0){ d = 1.0; } if(d < -1.0){ d = -1.0; }
			double angle = acos(d);
			// full snap beyond ~3 degrees, 6% floor at fixation
			double alpha = 0.06 + angle / 0.05;
			if(alpha > 1.0){ alpha = 1.0; }
			for(int i = 0; i < 3; i++){
				gazeSmoothEma[i] = gazeSmoothEma[i] * (1.0 - alpha) + dir[i] * alpha;
			}
			double n = sqrt(gazeSmoothEma[0] * gazeSmoothEma[0] + gazeSmoothEma[1] * gazeSmoothEma[1] + gazeSmoothEma[2] * gazeSmoothEma[2]);
			if(n > 0.001){
				gazeSmoothEma[0] /= n; gazeSmoothEma[1] /= n; gazeSmoothEma[2] /= n;
			}
			dir[0] = gazeSmoothEma[0]; dir[1] = gazeSmoothEma[1]; dir[2] = gazeSmoothEma[2];
		}
		settings.gazeDirX = dir[0];
		settings.gazeDirY = dir[1];
		settings.gazeDirZ = dir[2];
	}
	// real per-eye frusta for the mapping (cached after the first query)
	for(int e = 0; e < 2; e++){
		float l, r, t, b;
		if(deviceProvider.GetHmdProjectionRaw(e, l, r, t, b)){
			settings.gazeProjValid = true;
			settings.gazeProj[e][0] = l; settings.gazeProj[e][1] = r;
			settings.gazeProj[e][2] = t; settings.gazeProj[e][3] = b;
			// one-shot: the camera distortion fit script
			// (tools/gxr_distortion_fit.py) needs these exact tangents;
			// logging them here means the calibration guide is just
			// "copy this line from vrserver.txt"
			if(!projLogged[e]){
				projLogged[e] = true;
				DriverLog("FrameProcessor: proj eye=%d l=%.6f r=%.6f t=%.6f b=%.6f",
					e, l, r, t, b);
			}
		}
	}
	// fixation dot direction for this frame's render pose and the head
	// angular velocity, both maintained in SubmitLayer
	settings.dotValid = dotHeadValid;
	settings.dotDirX = dotHeadDir[0];
	settings.dotDirY = dotHeadDir[1];
	settings.dotDirZ = dotHeadDir[2];
	settings.headVelDegS = headVelDegS;
	settings.headBasisValid = headBasisValid;
	for(int bi = 0; bi < 3; bi++){
		for(int bj = 0; bj < 3; bj++){
			settings.headBasis[bi][bj] = headBasisW[bi][bj];
		}
	}
	// interactive calibration modes (aligner > center tune > band tuner):
	// they may replace settings.config.distortion / overlays / controller
	// offsets, so they must run before the activity checks read the config
	UpdateInteractiveModes(settings);
	const StreamFrameConfig &config = settings.config;
	const gxr::Sdr10BaselinePolicy &policy = settings.policy;
	// skip the whole pass when it would be an identity transform.
	// 2026-09-19 SDR10 baseline: identity is judged on the EFFECTIVE
	// values — with the baseline active the neutral color chain IS the
	// identity, so the pass is skipped (cas / overlays / dimming below can
	// still force it on); with it off the policy passes the stored config
	// through exactly and this is unchanged
	bool colorActive = settings.applyColor && (
		policy.saturation != 50 ||
		policy.vibrance != 0 ||
		policy.contrast != 50 ||
		policy.gamma != 2.2 ||
		policy.colorMultiplier.r != 1.0 || policy.colorMultiplier.g != 1.0 || policy.colorMultiplier.b != 1.0 ||
		policy.srgbMatrix.size() == 9);
	// cas and dither are not affected by the dashboard gating. cas is NOT
	// baseline-owned (stays a user control); dither is judged on the
	// effective value (baseline forces it off)
	colorActive |= config.cas.enable || policy.dither;
	// 2026-09-25: these passes also change pixels with otherwise neutral
	// controls; do not make them depend on unrelated color/distortion work.
	colorActive |= config.fxaaMode == 1 || config.fxaaMode == 2;
	colorActive |= config.blackFloor.rampBar || policy.blackFloorRangeMode != 0
		|| policy.blackFloorShadowLift || policy.blackFloorBlackPointCode > 0.01;
	// debug/calibration overlays draw in the shader, so they must force
	// the pass on even when everything else is an identity transform
	// (previously the grid/ring only rendered when something else
	// happened to keep the pass active)
	colorActive |= config.eyeGaze.debugRing || config.eyeGaze.debugGrid
		|| config.eyeGaze.calibDot || config.eyeGaze.probeCapture;
	// the pass must also run while any dimming is applied
	settings.dimAmount = dimFactor;
	// calibration needs stable brightness: the Gray-code decode compares
	// captures taken tens of seconds apart, and a dim ramp between them
	// corrupts the thresholds (observed as brightness ratio << 1 in the
	// sweep's stability line). blackout, not dimming, is the panel
	// protection story while a camera rig is mounted.
	if(config.calib.pattern >= 0 || config.calib.captureMode){
		settings.dimAmount = 0;
	}
	colorActive |= settings.dimAmount > 0.0001;
	// general brightness, and every camera calibration output (blackout,
	// sweep pattern, capture-mode grid) is shader work. brightness is
	// judged on the effective value (baseline forces it to 1)
	colorActive |= policy.brightness != 1.0;
	colorActive |= config.calib.blackout || config.calib.pattern >= 0 || config.calib.captureMode;
	// the dense displacement map is a remap even when every curve is flat
	const StreamFrameDisplacementMap &dmap = config.distortion.map;
	bool mapActive = dmap.enable && dmap.cols >= 2 && dmap.rows >= 2
		&& (dmap.left.size() == (size_t)dmap.cols * dmap.rows * 2 || dmap.right.size() == (size_t)dmap.cols * dmap.rows * 2);
	colorActive |= mapActive;
	bool spline = config.distortion.mode == "spline";
	auto curveActive = [spline](double k1, double k2, const std::vector<StreamFrameDistortionPoint> &points){
		if(spline){
			for(const auto &point : points){
				if(point.scale != 1.0){
					return true;
				}
			}
			return false;
		}
		return k1 != 0 || k2 != 0;
	};
	bool remapActive = curveActive(config.k1, config.k2, config.distortion.points);
	if(config.distortion.perEye || config.distortion.perAxis){
		for(const auto &pair : config.distortion.curves){
			if(curveActive(pair.second.k1, pair.second.k2, pair.second.points)){
				remapActive = true;
				break;
			}
		}
	}
	remapActive |= config.alignment.leftH != 0 || config.alignment.leftV != 0
		|| config.alignment.rightH != 0 || config.alignment.rightV != 0;
	return config.enable && (colorActive || remapActive);
}

void DirectModeComponentShim::Present(vr::SharedTextureHandle_t syncTexture){
	if(VerboseFrame()){
		DriverLog("FrameComponentShim: Present frame=%llu sync=%llx layersThisFrame=%d",
			(unsigned long long)frameCount, (unsigned long long)syncTexture, layersThisFrame);
	}else if(frameCount % 1000 == 0){
		// heartbeat so we can confirm the path is still active and see the
		// steady-state layer count (e.g. does the dashboard add a layer?)
		DriverLog("FrameComponentShim: Present heartbeat frame=%llu layersThisFrame=%d",
			(unsigned long long)frameCount, layersThisFrame);
		// gaze tap read on the Present thread: this is the exact consumption
		// path the dynamic pupil-swim pass will use, so exercising it in the
		// heartbeat proves the plumbing end to end during recon. accept
		// samples up to 250ms old so a brief hiccup doesn't read as "no ET".
		EyeTrackingTap::Sample gaze;
		if(eyeTrackingTap.GetLatestSample(gaze, 0.25)){
			DriverLog("FrameComponentShim: gaze tap sample=%llu valid=%d tracked=%d target=(%.4f, %.4f, %.4f) rate=%.1fHz",
				(unsigned long long)gaze.sampleIndex, (int)gaze.valid, (int)gaze.tracked,
				gaze.targetX, gaze.targetY, gaze.targetZ, eyeTrackingTap.GetSampleRate());
		}
	}
	lastSyncTexture = syncTexture;
	// process the scene layer before the driver consumes it
	if(haveSceneLayer){
		FrameProcessSettings settings;
		bool processAtSubmit = false;
		if(GetActiveSettings(settings, processAtSubmit) && !processAtSubmit){
			MaybeLogSwimProbe(settings);
			processor.ProcessSceneLayer(sceneLeft, sceneRight, sceneLeftBounds, sceneRightBounds, syncTexture, settings);
		}
		haveSceneLayer = false;
	}
	layersThisFrame = 0;
	frameCount++;
	original->Present(syncTexture);
}

void DirectModeComponentShim::PostPresent(const Throttling_t* pThrottling){
	original->PostPresent(pThrottling);
}

void DirectModeComponentShim::GetFrameTiming(vr::DriverDirectMode_FrameTiming* pFrameTiming){
	original->GetFrameTiming(pFrameTiming);
}

// ---------------------------------------------------------------------------
// VirtualDisplayShim
// ---------------------------------------------------------------------------

VirtualDisplayShim::VirtualDisplayShim(vr::IVRVirtualDisplay* original){
	this->original = original;
	DriverLog("FrameComponentShim: wrapping IVRVirtualDisplay %p", (void*)original);
}

void VirtualDisplayShim::Present(const vr::PresentInfo_t* pPresentInfo, uint32_t unPresentInfoSize){
	if(frameCount < 20 || frameCount % 1000 == 0){
		DriverLog("FrameComponentShim: VirtualDisplay Present frame=%llu backbuffer=%llx frameId=%llu",
			(unsigned long long)frameCount,
			pPresentInfo ? (unsigned long long)pPresentInfo->backbufferTextureHandle : 0ull,
			pPresentInfo ? (unsigned long long)pPresentInfo->nFrameId : 0ull);
	}
	frameCount++;
	// PHASE 2 (virtual display variant) GOES HERE: process the backbuffer
	// before the driver encodes it.
	original->Present(pPresentInfo, unPresentInfoSize);
}

void VirtualDisplayShim::WaitForPresent(){
	original->WaitForPresent();
}

bool VirtualDisplayShim::GetTimeSinceLastVsync(float* pfSecondsSinceLastVsync, uint64_t* pulFrameCounter){
	return original->GetTimeSinceLastVsync(pfSecondsSinceLastVsync, pulFrameCounter);
}
