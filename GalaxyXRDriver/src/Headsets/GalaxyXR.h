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

// Innermost wrapper of the Steam Link Galaxy XR HMD (vendor build). It binds
// the device index before the original Activate runs and admits or denies the
// epoch right after it: Activate succeeded AND Prop_ParentDriver_Uint64 is the
// valid "vrlink" driver handle AND the pre-stamp model corroborates. A
// deactivate closes the epoch synchronously. It never writes a property.
class GalaxyLinkHmdOwnershipShim : public ShimDefinition{
public:
	GalaxyXRDeviceProvider* deviceProvider = nullptr;

	virtual bool PreTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual void PosTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual bool PreTrackedDeviceDeactivate() override;
};

// Innermost wrapper of a controller added by driver_vrlink.dll (vendor build).
// Registers the device as owned by the open Steam Link epoch when its parent
// driver is "vrlink"; the registration is also retried from RunFrame and is
// dropped at deactivate or when the epoch closes. Never writes a property.
class GalaxyLinkControllerOwnershipShim : public ShimDefinition{
public:
	GalaxyXRDeviceProvider* deviceProvider = nullptr;

	virtual bool PreTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual void PosTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual bool PreTrackedDeviceDeactivate() override;
	virtual void RunFrame() override;
	// true once registered under a still-open epoch
	bool Owned() const;

private:
	bool TryRegister();
	uint32_t deviceId = vr::k_unTrackedDeviceIndexInvalid;
	uint64_t registeredLineage = 0;
	bool activated = false;
};

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
	// Stop acting (epoch closed or never admitted): release capability
	// overrides and restore ONLY the identity values this shim itself wrote.
	void ReleaseOwnership(const char* reason);
	bool EpochAdmitted() const;
	bool ownershipReleased = false;
	// same-object reconnect: this HMD object was admitted as `lastObjectId`; after
	// its epoch closed it re-arms (settings, identity, capabilities) only when the
	// SAME lineage is admitted again with fresh evidence (RebindHmd)
	uint32_t lastObjectId = vr::k_unTrackedDeviceIndexInvalid;
	uint32_t rearmObjectId = vr::k_unTrackedDeviceIndexInvalid;
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
	// ownership registrar wrapped beneath this shim (vendor build); identity,
	// icons, input profile and render model are stamped only while it says the
	// controller belongs to the open Steam Link epoch
	GalaxyLinkControllerOwnershipShim* galaxyLinkOwnership = nullptr;

	virtual void PosTrackedDeviceActivate(uint32_t &unObjectId, vr::EVRInitError &returnValue) override;
	virtual bool PreTrackedDeviceDeactivate() override;
	virtual void HandleEvent(const vr::VREvent_t &event) override;
	// live render-model swap when galaxyXr.renderModelVariant changes
	virtual void RunFrame() override;

private:
	// false (after restoring only this shim's own writes) once the controller
	// no longer belongs to the open Steam Link epoch
	bool StillAuthorized();
	void ApplyIdentity();
	// resolve the current model name from config (variant or default)
	std::string TargetModelName();


	std::string appliedModel;
	int iconPollFrames = 0;
	// activated before its epoch opened (or released when it closed): adopted
	// from RunFrame once the same ownership registration is open again
	uint32_t pendingObjectId = vr::k_unTrackedDeviceIndexInvalid;
	uint32_t lastObjectId = vr::k_unTrackedDeviceIndexInvalid;
	std::string serial;
	bool isLeft = false;
	vr::PropertyContainerHandle_t container = vr::k_ulInvalidPropertyContainer;
	bool active = false;
	bool haveBackup = false;
	std::string origRenderModel;
	std::string origInputProfile;
	std::string origControllerType;
};
