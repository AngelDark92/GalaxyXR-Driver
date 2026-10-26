#pragma once
#include "../Driver/DeviceShim.h"
#include "../Driver/DeviceProvider.h"
#include "../Driver/DriverLog.h"
#include "VrlinkCapabilities.h"
#include <string>
#include <vector>
#include <tuple>
#include <mutex>

// Native-identity shims for the vrlink-streamed Galaxy XR (vendor build only,
// opt-in via galaxyXr.nativeIdentity).
//
// Design (see Docs: GxR identity decisions, section 2):
// - vrlink's internal HMD-type enum is decided at handshake, before these
//   devices exist in SteamVR, so rewriting the visible properties afterwards
//   cannot affect eye tracking or profile selection.
// - originals are backed up on activate and restored on deactivate.
// - vrlink re-asserts properties after activation (observed: ModelNumber set
//   three times in one session), so the shim reapplies on PropertyChanged
//   events for its container. Reapplication only writes when the current
//   value differs from the target, which also terminates the event loop that
//   our own writes would otherwise feed.

// write the vrlink stream tier + headset profile keys at provider Init,
// before vrlink reads them (see GalaxyXR.cpp)
void GalaxyXR_EarlyApplyVrlinkSettings();
// Requested stream values for the current mode (tier/custom + Advanced
// bandwidth override). No range or codec coercion: validation/the encoder
// must visibly reject unsupported input. The tile is copied into the tap
// config under driverConfigLock; hooked NVENC calls must not read live config.
// A requested tile is not proof of the device's width/height capabilities.
int GalaxyXR_EffectiveTileWidth();
int GalaxyXR_EffectiveBandwidthMbit();

class GalaxyXRHmdShim : public ShimDefinition{
public:
	GalaxyXRDeviceProvider* deviceProvider = nullptr;

	virtual void PosTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual void PosTrackedDeviceGetComponent(const char *&pchComponentNameAndVersion, void *&returnComponent) override;
	virtual void PosDisplayComponentGetRecommendedRenderTargetSize(uint32_t *&pnWidth, uint32_t *&pnHeight) override;
	virtual bool PreTrackedDeviceDeactivate() override;
	virtual void HandleEvent(const vr::VREvent_t &event) override;
	// config hot-reload for the native resolution override
	virtual void RunFrame() override;

private:
	// write identity + icon properties; only touches values that differ
	void ApplyIdentity();
	void UpdateTrackingCapabilities();
	void RestoreTrackingCapabilities();
	gxrpaths::VrlinkCapabilities trackingCapabilities;
	std::mutex trackingCapabilitiesMutex;
	double lastCapabilityPoll = -1.0;
	unsigned lastCapabilityErrors = 0;
	unsigned lastCapabilityEligibility = ~0u;
	bool capabilityInterfaceWarning = false;
	bool capabilityActive = false; // protected by trackingCapabilitiesMutex
	uint32_t capabilityDeviceId = vr::k_unTrackedDeviceIndexInvalid;
	bool identityApplied = false;
	bool appliedProfileRoute = true;
	int iconPollFrames = 0;
	bool appliedNativeResolution = false;
	int appliedRenderWidth = 0, appliedRenderHeight = 0;
	uint32_t loggedRenderWidth = 0, loggedRenderHeight = 0;
	bool appliedHeadsetProfile = false;
	int appliedProfileMaxSfw = 0;
	bool appliedProfile10bit = false;
	bool appliedDebugOverlay = false;
	bool appliedDebugMode = false;
	std::string appliedStreamQuality;
	// custom tier values as last applied, for hot-reload change detection
	int appliedCustomEncodeWidth = 0, appliedCustomStreamFormatWidth = 0, appliedCustomBandwidthMbit = 0;
	int appliedBandwidthOverride = 0;
	std::vector<std::tuple<std::string, char, double>> appliedExtraKeys;
	int appliedMaxVqLat = 0; double appliedBackoffCoef = 0.0;

	vr::PropertyContainerHandle_t container = vr::k_ulInvalidPropertyContainer;
	bool active = false;
	bool haveBackup = false;
	bool displayComponentUnrecognizedLogged = false;
	std::string origModelNumber;
	std::string origManufacturer;
	std::string origHmdInputProfile;
};

class GalaxyXRControllerShim : public ShimDefinition{
public:
	explicit GalaxyXRControllerShim(const std::string &serial);

	virtual void PosTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual bool PreTrackedDeviceDeactivate() override;
	virtual void HandleEvent(const vr::VREvent_t &event) override;
	// live render-model swap when galaxyXr.renderModelVariant changes
	virtual void RunFrame() override;

private:
	void ApplyIdentity();
	// resolve the current model name from config (variant or default)
	std::string TargetModelName();


	std::string appliedModel;
	int iconPollFrames = 0;
	std::string serial;
	bool isLeft = false;
	vr::PropertyContainerHandle_t container = vr::k_ulInvalidPropertyContainer;
	bool active = false;
	bool haveBackup = false;
	std::string origRenderModel;
	std::string origInputProfile;
	std::string origControllerType;
};
