#pragma once

#include "openvr_driver.h"
#include <mutex>
#include <cstdint>

// Eye tracking recon + tap (slice 3 foundation).
//
// vrlink publishes gaze into vrserver through driver-side IVRDriverInput:
// CreateEyeTrackingComponent once, then UpdateEyeTrackingComponent per sample.
// The GetGenericInterface detour vtable-hooks those two entries (see
// InterfaceHookInjector.cpp) and forwards every call here.
//
// This class has two jobs, deliberately the same code:
//  - recon: log which components get created (does vrlink create one at all,
//    under which identity, on which container/path) and throttle-log the
//    sample stream (values, rate, time offsets, valid-flag transitions).
//  - tap: stash the latest sample thread-safely so FrameComponentShim can read
//    it on the Present thread. This is the production gaze feed for the
//    dynamic pupil-swim pass later; recon just proves it live.
//
// Zero config: when nothing calls UpdateEyeTrackingComponent this does nothing
// and logs nothing (beyond component creation, which is the recon headline).

class EyeTrackingTap{
public:
	struct Sample{
		bool active = false;
		bool valid = false;
		bool tracked = false;
		// gaze ray as published (driver/head space, z forward convention is
		// part of what recon establishes; log raw, interpret later)
		float originX = 0, originY = 0, originZ = 0;
		float targetX = 0, targetY = 0, targetZ = 0;
		// fTimeOffset as passed by the publisher (seconds, usually <= 0)
		double timeOffset = 0;
		// steady-clock seconds when the detour stored this sample
		double receivedTime = 0;
		// monotonically increasing index of stored samples
		uint64_t sampleIndex = 0;
		// which component published it (distinguishes publishers)
		vr::VRInputComponentHandle_t component = vr::k_ulInvalidInputComponentHandle;
	};

	// called from the CreateEyeTrackingComponent detour, after the original
	void OnCreateComponent(vr::PropertyContainerHandle_t container, const char* name,
		vr::VRInputComponentHandle_t handle, vr::EVRInputError error);

	// called from the UpdateEyeTrackingComponent detour, after the original.
	// stores the sample and emits throttled recon logging.
	void OnUpdateComponent(vr::VRInputComponentHandle_t component,
		const vr::VREyeTrackingData_t* data, double timeOffset);

	// copy out the latest sample. returns false if none has ever arrived.
	// maxAgeSeconds guards against consuming a stale sample after the stream
	// stops (pass 0 to accept any age).
	bool GetLatestSample(Sample &out, double maxAgeSeconds = 0);

	// estimated publish rate in Hz over the last measurement window (0 if idle)
	double GetSampleRate();

	// forget every stored sample (a closed Steam Link epoch must not leave a
	// gaze sample for later consumers)
	void Clear();

private:
	std::mutex lock;
	Sample latest = {};
	uint64_t sampleCount = 0;

	// recon logging state
	// log the first few samples in full detail
	static constexpr uint64_t fullDetailSamples = 5;
	// then a 1/s summary line
	double lastSummaryLogTime = 0;
	// log valid/tracked transitions, at most 1/s to survive flicker
	bool lastValid = false;
	bool lastTracked = false;
	bool haveFlagBaseline = false;
	double lastFlagLogTime = 0;

	// rate estimation: samples counted in ~1s windows
	double rateWindowStart = 0;
	uint64_t rateWindowCount = 0;
	double measuredRate = 0;

	// raw payload watch: interpretation-free change detection on the exact
	// bytes vrlink passes. if any bit of gaze data ever flows, this catches
	// it even if our struct interpretation were somehow wrong.
	uint8_t lastRaw[sizeof(vr::VREyeTrackingData_t)] = {};
	bool haveRaw = false;
	uint64_t distinctPayloads = 0;
	double lastChangeLogTime = 0;
};

extern EyeTrackingTap eyeTrackingTap;
