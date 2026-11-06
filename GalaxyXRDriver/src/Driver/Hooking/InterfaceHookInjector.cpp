#include "../DriverLog.h"
#include "Hooking.h"
#include "InterfaceHookInjector.h"
#include "ControllerPoseDispatch.h"
#include "../DeviceProvider.h"
#include "../EyeTrackingTap.h"
#include "../GalaxyLinkEpoch.h"
#include "../NvencTap.h"
#include "VrlinkSettingsHook.h"
#include <atomic>
#include <cstddef>
#include <cstring>
#include <memory>
#include <mutex>
#ifdef _WIN32
#include <intrin.h>
#endif

static GalaxyXRDeviceProvider *Driver = nullptr;

#ifdef VENDOR_GALAXYXR
// Steam Link target eye component: handle + the HMD-object lineage it was created under.
// Updates from any other component (a foreign driver, another HMD object) never
// reach the tap; the original call and its result are always preserved.
static std::atomic<uint64_t> galaxyEyeHandle{ vr::k_ulInvalidInputComponentHandle };
static std::atomic<uint64_t> galaxyEyeLineage{ 0 };

// Logged once per key by the overlay hook (never from inside a lock).
static void ReportSettingsOverlay(const char* key, const char* type)
{
	DriverLog("VrlinkSettingsHook: driver_vrlink.%s (%s) answered from vrlink_xrvst2ue for the admitted Steam Link Galaxy XR epoch", key, type);
}
#endif

static Hook<void*(*)(vr::IVRDriverContext *, const char *, vr::EVRInitError *)> 
	GetGenericInterfaceHook("IVRDriverContext::GetGenericInterface");

static Hook<void(*)(vr::IVRServerDriverHost *, uint32_t, const vr::DriverPose_t &, uint32_t)>
	TrackedDevicePoseUpdatedHook005("IVRServerDriverHost005::TrackedDevicePoseUpdated");

static Hook<void(*)(vr::IVRServerDriverHost *, uint32_t, const vr::DriverPose_t &, uint32_t)>
	TrackedDevicePoseUpdatedHook006("IVRServerDriverHost006::TrackedDevicePoseUpdated");

static Hook<void(*)(vr::IVRServerDriverHost *_this, const char *pchDeviceSerialNumber, vr::ETrackedDeviceClass eDeviceClass, vr::ITrackedDeviceServerDriver *pDriver)>
	TrackedDeviceAddedHook006("IVRServerDriverHost006::TrackedDeviceAdded");

// eye tracking tap: intercept driver-side gaze publication (vrlink publishes
// gaze into vrserver through these two IVRDriverInput_004 entries)
static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::PropertyContainerHandle_t, const char *, vr::VRInputComponentHandle_t *)>
	CreateBooleanComponentHook004("IVRDriverInput004::CreateBooleanComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::VRInputComponentHandle_t, bool, double)>
	UpdateBooleanComponentHook004("IVRDriverInput004::UpdateBooleanComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::PropertyContainerHandle_t, const char *, vr::VRInputComponentHandle_t *, vr::EVRScalarType, vr::EVRScalarUnits)>
	CreateScalarComponentHook004("IVRDriverInput004::CreateScalarComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::VRInputComponentHandle_t, float, double)>
	UpdateScalarComponentHook004("IVRDriverInput004::UpdateScalarComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::PropertyContainerHandle_t, const char *, vr::VRInputComponentHandle_t *)>
	CreatePoseComponentHook004("IVRDriverInput004::CreatePoseComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::VRInputComponentHandle_t, const vr::HmdMatrix34_t *, double)>
	UpdatePoseComponentHook004("IVRDriverInput004::UpdatePoseComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::PropertyContainerHandle_t, const char *, vr::VRInputComponentHandle_t *)>
	CreateEyeTrackingComponentHook004("IVRDriverInput004::CreateEyeTrackingComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::VRInputComponentHandle_t, const vr::VREyeTrackingData_t *, double)>
	UpdateEyeTrackingComponentHook004("IVRDriverInput004::UpdateEyeTrackingComponent");

// skeleton tap: intercept vrlink's skeletal input so the wrist bone can be
// offset in the shim (see GalaxyXRDeviceProvider::HandleSkeletonUpdate)
static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::PropertyContainerHandle_t, const char *, const char *, const char *, vr::EVRSkeletalTrackingLevel, const vr::VRBoneTransform_t *, uint32_t, vr::VRInputComponentHandle_t *)>
	CreateSkeletonComponentHook004("IVRDriverInput004::CreateSkeletonComponent");

static Hook<vr::EVRInputError(*)(vr::IVRDriverInput *, vr::VRInputComponentHandle_t, vr::EVRSkeletalMotionRange, const vr::VRBoneTransform_t *, uint32_t)>
	UpdateSkeletonComponentHook004("IVRDriverInput004::UpdateSkeletonComponent");

// 2026-09-25 controller publication regression: forwarding newPose after
// processing a copy left Kalman/CA, grip and trims diagnostic-only. Publish
// the corrected copy for healthy physical controllers; retain the caller's
// object for native hands, other devices and source loss/disconnect samples.
//
// Historical note: the previous patch reports hand-role failures on SteamVR
// 2.17.9 / Steam Link 2.0.20 with stack copies, persistent copies, in-place
// edits, and even controller-only corrected copies; raw forwarding worked.
// That report does not establish pointer identity as the cause. The handler
// can also promote invalid controller samples via forceTracking/loss coast.
// The new source-status gate avoids publishing those promotions. It still
// requires live physical -> hand -> physical/reconnect validation; restoring
// healthy controller output alone does not prove the hand-role issue fixed.
static void PoseAbiWarn(uint32_t unPoseStructSize)
{
	static std::atomic<bool> reported{ false };
	if (!reported.exchange(true, std::memory_order_relaxed))
	{
		DriverLog("PoseABI: caller struct=%u ours=%u%s", unPoseStructSize,
			(unsigned)sizeof(vr::DriverPose_t),
			unPoseStructSize == (uint32_t)sizeof(vr::DriverPose_t) ? "" : " - MISMATCH, handler skipped");
	}
}

#ifdef VENDOR_GALAXYXR
// Returns true when the pose belongs to the Steam Link target (admitted HMD or
// an owned controller) and may therefore be processed. The target HMD's
// disconnected edge closes the epoch FIRST, before any pose is mutated, so the
// very sample that carries the edge is already treated as unowned. Every other
// device is a foreign full pass-through: never edited, never dropped.
// `caller` is the pose-update call site, captured IN the detour: it is the
// module evidence for a same-object HMD reconnect (connected-up edge).
static bool GalaxyOwnsPose(uint32_t unWhichDevice, const vr::DriverPose_t &newPose, uint32_t unPoseStructSize, const void *caller)
{
	if (unPoseStructSize > offsetof(vr::DriverPose_t, deviceIsConnected))
	{
		const bool connected = newPose.deviceIsConnected;
		if (connected)
		{
			// cheap atomic precheck inside; only a retained, freshly re-identified
			// HMD object can ever be re-admitted here
			Driver->TryRebindHmd(unWhichDevice, caller, true);
		}
		gxr::galaxylink::ObservePose(unWhichDevice, connected);
	}
	return Driver->IsOwnedByTarget(unWhichDevice);
}
#endif

static void DetourTrackedDevicePoseUpdated005(vr::IVRServerDriverHost *_this, uint32_t unWhichDevice, const vr::DriverPose_t &newPose, uint32_t unPoseStructSize)
{
#ifdef VENDOR_GALAXYXR
#ifdef _WIN32
	const void *poseCaller = _ReturnAddress();
#else
	const void *poseCaller = __builtin_return_address(0);
#endif
	if (!GalaxyOwnsPose(unWhichDevice, newPose, unPoseStructSize, poseCaller))
	{
		TrackedDevicePoseUpdatedHook005.originalFunc(_this, unWhichDevice, newPose, unPoseStructSize);
		return;
	}
#endif
	PoseAbiWarn(unPoseStructSize);
	gxr::DispatchControllerPoseUpdate(*Driver, unWhichDevice, newPose, unPoseStructSize,
		[&](const vr::DriverPose_t& submittedPose, uint32_t submittedSize) {
			TrackedDevicePoseUpdatedHook005.originalFunc(_this, unWhichDevice, submittedPose, submittedSize);
		});
}

static void DetourTrackedDevicePoseUpdated006(vr::IVRServerDriverHost *_this, uint32_t unWhichDevice, const vr::DriverPose_t &newPose, uint32_t unPoseStructSize)
{
#ifdef VENDOR_GALAXYXR
#ifdef _WIN32
	const void *poseCaller = _ReturnAddress();
#else
	const void *poseCaller = __builtin_return_address(0);
#endif
	if (!GalaxyOwnsPose(unWhichDevice, newPose, unPoseStructSize, poseCaller))
	{
		TrackedDevicePoseUpdatedHook006.originalFunc(_this, unWhichDevice, newPose, unPoseStructSize);
		return;
	}
#endif
	PoseAbiWarn(unPoseStructSize);
	gxr::DispatchControllerPoseUpdate(*Driver, unWhichDevice, newPose, unPoseStructSize,
		[&](const vr::DriverPose_t& submittedPose, uint32_t submittedSize) {
			TrackedDevicePoseUpdatedHook006.originalFunc(_this, unWhichDevice, submittedPose, submittedSize);
		});
}

static void DetourTrackedDeviceAdded006(vr::IVRServerDriverHost *_this, const char *pchDeviceSerialNumber, vr::ETrackedDeviceClass eDeviceClass, vr::ITrackedDeviceServerDriver *pDriver)
{
	// The ORIGINAL caller of TrackedDeviceAdded: captured here, in the detour
	// itself (never in a helper), because it is the module-ownership evidence
	// for the Steam Link target. The vtable slot is patched directly, so this
	// is the real driver_vrlink.dll call site.
#ifdef _WIN32
	const void *caller = _ReturnAddress();
#else
	const void *caller = __builtin_return_address(0);
#endif
	// 2026-10-21: do NOT invent a serial for an empty-serial HMD add. In the
	// observed startup log only SteamVR's own "null" placeholder driver
	// publishes one, and rewriting it turned that dummy into the active HMD
	// ("Active HMD set to null.VRLINKHMDGALAXYXR"), so SteamVR reported a
	// connected Galaxy XR with no headset attached. vrlink's unknown-HMD
	// branch takes its serial from the profile section, written before vrlink
	// reads the settings (GalaxyXR.cpp ApplyGalaxyProfileSectionIdentity); an
	// empty serial there is a settings defect to fix at the source.
	if (Driver->HandleDeviceAdded(pchDeviceSerialNumber, eDeviceClass, pDriver, caller))
	{
		TrackedDeviceAddedHook006.originalFunc(_this, pchDeviceSerialNumber, eDeviceClass, pDriver);
		// // Add 19 more copies with random serial numbers
		// for (int i = 0; i < 19; i++)
		// {
		// 	char serial[32]{};
		// 	snprintf(serial, sizeof(serial), "FIM-%d-%d", i, rand());
		// 	TrackedDeviceAddedHook006.originalFunc(_this, serial, eDeviceClass, pDriver);
		// }
	}
}

static vr::EVRInputError DetourCreateBooleanComponent004(vr::IVRDriverInput *_this, vr::PropertyContainerHandle_t ulContainer, const char *pchName, vr::VRInputComponentHandle_t *pHandle)
{
	auto error = CreateBooleanComponentHook004.originalFunc(_this, ulContainer, pchName, pHandle);
	Driver->OnInputComponentCreated(ulContainer, pchName,
		pHandle ? *pHandle : vr::k_ulInvalidInputComponentHandle, error);
	return error;
}

static vr::EVRInputError DetourUpdateBooleanComponent004(vr::IVRDriverInput *_this, vr::VRInputComponentHandle_t ulComponent, bool bNewValue, double fTimeOffset)
{
	auto error = UpdateBooleanComponentHook004.originalFunc(_this, ulComponent, bNewValue, fTimeOffset);
	Driver->OnBooleanComponentUpdated(ulComponent, bNewValue, fTimeOffset, error);
	return error;
}

static vr::EVRInputError DetourCreateScalarComponent004(vr::IVRDriverInput *_this, vr::PropertyContainerHandle_t ulContainer, const char *pchName, vr::VRInputComponentHandle_t *pHandle, vr::EVRScalarType eType, vr::EVRScalarUnits eUnits)
{
	auto error = CreateScalarComponentHook004.originalFunc(_this, ulContainer, pchName, pHandle, eType, eUnits);
	Driver->OnScalarComponentCreated(ulContainer, pchName,
		pHandle ? *pHandle : vr::k_ulInvalidInputComponentHandle, error);
	return error;
}

static vr::EVRInputError DetourUpdateScalarComponent004(vr::IVRDriverInput *_this, vr::VRInputComponentHandle_t ulComponent, float fNewValue, double fTimeOffset)
{
	auto error = UpdateScalarComponentHook004.originalFunc(_this, ulComponent, fNewValue, fTimeOffset);
	Driver->OnScalarComponentUpdated(ulComponent, fNewValue, fTimeOffset, error);
	return error;
}

static vr::EVRInputError DetourCreatePoseComponent004(vr::IVRDriverInput *_this, vr::PropertyContainerHandle_t ulContainer, const char *pchName, vr::VRInputComponentHandle_t *pHandle)
{
	auto error = CreatePoseComponentHook004.originalFunc(_this, ulContainer, pchName, pHandle);
	if(pHandle){
		Driver->OnPoseComponentCreated(ulContainer, pchName, *pHandle);
	}
	return error;
}

static vr::EVRInputError DetourUpdatePoseComponent004(vr::IVRDriverInput *_this, vr::VRInputComponentHandle_t ulComponent, const vr::HmdMatrix34_t *pMatPoseOffset, double fTimeOffset)
{
	auto error = UpdatePoseComponentHook004.originalFunc(_this, ulComponent, pMatPoseOffset, fTimeOffset);
	Driver->OnPoseComponentUpdated(ulComponent, pMatPoseOffset, fTimeOffset);
	return error;
}

static vr::EVRInputError DetourCreateEyeTrackingComponent004(vr::IVRDriverInput *_this, vr::PropertyContainerHandle_t ulContainer, const char *pchName, vr::VRInputComponentHandle_t *pHandle)
{
	auto error = CreateEyeTrackingComponentHook004.originalFunc(_this, ulContainer, pchName, pHandle);
	const vr::VRInputComponentHandle_t handle = pHandle ? *pHandle : vr::k_ulInvalidInputComponentHandle;
#ifdef VENDOR_GALAXYXR
	// Only the Steam Link target's component feeds the tap. Anything else (a
	// foreign driver, an unowned container) keeps its original result untouched.
	if (error == vr::VRInputError_None && handle != vr::k_ulInvalidInputComponentHandle
		&& Driver->IsContainerOwned(ulContainer))
	{
		galaxyEyeLineage.store(gxr::galaxylink::CurrentLineage(), std::memory_order_release);
		galaxyEyeHandle.store(handle, std::memory_order_release);
		eyeTrackingTap.OnCreateComponent(ulContainer, pchName, handle, error);
	}
	return error;
#else
	eyeTrackingTap.OnCreateComponent(ulContainer, pchName, handle, error);
	return error;
#endif
}

static vr::EVRInputError DetourUpdateEyeTrackingComponent004(vr::IVRDriverInput *_this, vr::VRInputComponentHandle_t ulComponent, const vr::VREyeTrackingData_t *pEyeTrackingData, double fTimeOffset)
{
	auto error = UpdateEyeTrackingComponentHook004.originalFunc(_this, ulComponent, pEyeTrackingData, fTimeOffset);
#ifdef VENDOR_GALAXYXR
	if (error == vr::VRInputError_None
		&& ulComponent == galaxyEyeHandle.load(std::memory_order_acquire)
		&& gxr::galaxylink::IsOpenLineage(galaxyEyeLineage.load(std::memory_order_acquire)))
	{
		eyeTrackingTap.OnUpdateComponent(ulComponent, pEyeTrackingData, fTimeOffset);
	}
#else
	eyeTrackingTap.OnUpdateComponent(ulComponent, pEyeTrackingData, fTimeOffset);
#endif
	return error;
}

static vr::EVRInputError DetourCreateSkeletonComponent004(vr::IVRDriverInput *_this, vr::PropertyContainerHandle_t ulContainer, const char *pchName, const char *pchSkeletonPath, const char *pchBasePosePath, vr::EVRSkeletalTrackingLevel eSkeletalTrackingLevel, const vr::VRBoneTransform_t *pGripLimitTransforms, uint32_t unGripLimitTransformCount, vr::VRInputComponentHandle_t *pHandle)
{
	auto error = CreateSkeletonComponentHook004.originalFunc(_this, ulContainer, pchName, pchSkeletonPath, pchBasePosePath, eSkeletalTrackingLevel, pGripLimitTransforms, unGripLimitTransformCount, pHandle);
	if(pHandle){
		Driver->OnSkeletonComponentCreated(ulContainer, pchName, pchSkeletonPath, *pHandle);
	}
	return error;
}

static vr::EVRInputError DetourUpdateSkeletonComponent004(vr::IVRDriverInput *_this, vr::VRInputComponentHandle_t ulComponent, vr::EVRSkeletalMotionRange eMotionRange, const vr::VRBoneTransform_t *pTransforms, uint32_t unTransformCount)
{
	vr::VRBoneTransform_t adjusted[64];
	if(pTransforms && unTransformCount > 1 && unTransformCount <= 64
			&& Driver->HandleSkeletonUpdate(ulComponent, pTransforms, unTransformCount, adjusted)){
		return UpdateSkeletonComponentHook004.originalFunc(_this, ulComponent, eMotionRange, adjusted, unTransformCount);
	}
	return UpdateSkeletonComponentHook004.originalFunc(_this, ulComponent, eMotionRange, pTransforms, unTransformCount);
}

static void *DetourGetGenericInterface(vr::IVRDriverContext *_this, const char *pchInterfaceVersion, vr::EVRInitError *peError)
{
	Driver->driverContexts.insert(_this);  // Store the driver context for later use

	// The caller of the hooked getter, captured in the detour itself.
#ifdef _WIN32
	const void *getterCaller = _ReturnAddress();
#else
	const void *getterCaller = __builtin_return_address(0);
#endif
	// Exact driver_vrlink.dll caller only: give the NVENC lane its module-load
	// retry BEFORE the original getter runs (vrlink's NVENC imports exist once
	// the module is mapped; self-throttled and idempotent).
	const bool vrlinkCaller = gxr::galaxylink::IsVrlinkAddress(getterCaller);
	if (vrlinkCaller)
	{
		NvencTap::Get().TryInstall();
	}
	
	// TRACE("ServerTrackedDeviceProvider::DetourGetGenericInterface(%s)", pchInterfaceVersion);
	auto originalInterface = GetGenericInterfaceHook.originalFunc(_this, pchInterfaceVersion, peError);

#ifdef VENDOR_GALAXYXR
	// Scoped VRLink settings overlay: VRLink reads some tuning keys through an
	// IVRSettings pointer it cached during its own init, so the shared getters
	// are detoured (see VrlinkSettingsHook.h). The hook is armed for ANY
	// requester (the object is shared) and decides per call by call site.
	if (originalInterface && pchInterfaceVersion
		&& std::strcmp(pchInterfaceVersion, vr::IVRSettings_Version) == 0)
	{
		gxr::vrlinksettings::Install(static_cast<vr::IVRSettings *>(originalInterface));
	}
#endif

	std::string iface(pchInterfaceVersion);
	if (iface == "IVRServerDriverHost_005")
	{
		if (!IHook::Exists(TrackedDevicePoseUpdatedHook005.name))
		{
			TrackedDevicePoseUpdatedHook005.CreateHookInObjectVTable(originalInterface, 1, &DetourTrackedDevicePoseUpdated005);
			IHook::Register(&TrackedDevicePoseUpdatedHook005);
		}
	}
	else if (iface == "IVRServerDriverHost_006")
	{
		if (!IHook::Exists(TrackedDevicePoseUpdatedHook006.name))
		{
			TrackedDevicePoseUpdatedHook006.CreateHookInObjectVTable(originalInterface, 1, &DetourTrackedDevicePoseUpdated006);
			IHook::Register(&TrackedDevicePoseUpdatedHook006);
		}
		if (!IHook::Exists(TrackedDeviceAddedHook006.name))
		{
			TrackedDeviceAddedHook006.CreateHookInObjectVTable(originalInterface, 0, &DetourTrackedDeviceAdded006);
			IHook::Register(&TrackedDeviceAddedHook006);
		}
	}
	else if (iface == "IVRDriverInput_004")
	{
		// IVRDriverInput_004 vtable order (openvr_driver.h declaration order,
		// no overloads): 0 CreateBooleanComponent, 1 UpdateBooleanComponent,
		// 2 CreateScalarComponent, 3 UpdateScalarComponent,
		// 4 CreateHapticComponent, 5 CreateSkeletonComponent,
		// 6 UpdateSkeletonComponent, 7 CreatePoseComponent,
		// 8 UpdatePoseComponent, 9 CreateEyeTrackingComponent,
		// 10 UpdateEyeTrackingComponent
		if (!IHook::Exists(CreateBooleanComponentHook004.name))
		{
			CreateBooleanComponentHook004.CreateHookInObjectVTable(originalInterface, 0, &DetourCreateBooleanComponent004);
			IHook::Register(&CreateBooleanComponentHook004);
		}
		if (!IHook::Exists(UpdateBooleanComponentHook004.name))
		{
			UpdateBooleanComponentHook004.CreateHookInObjectVTable(originalInterface, 1, &DetourUpdateBooleanComponent004);
			IHook::Register(&UpdateBooleanComponentHook004);
		}
		if (!IHook::Exists(CreateScalarComponentHook004.name))
		{
			CreateScalarComponentHook004.CreateHookInObjectVTable(originalInterface, 2, &DetourCreateScalarComponent004);
			IHook::Register(&CreateScalarComponentHook004);
		}
		if (!IHook::Exists(UpdateScalarComponentHook004.name))
		{
			UpdateScalarComponentHook004.CreateHookInObjectVTable(originalInterface, 3, &DetourUpdateScalarComponent004);
			IHook::Register(&UpdateScalarComponentHook004);
		}
		if (!IHook::Exists(CreateSkeletonComponentHook004.name))
		{
			CreateSkeletonComponentHook004.CreateHookInObjectVTable(originalInterface, 5, &DetourCreateSkeletonComponent004);
			IHook::Register(&CreateSkeletonComponentHook004);
		}
		if (!IHook::Exists(UpdateSkeletonComponentHook004.name))
		{
			UpdateSkeletonComponentHook004.CreateHookInObjectVTable(originalInterface, 6, &DetourUpdateSkeletonComponent004);
			IHook::Register(&UpdateSkeletonComponentHook004);
		}
		if (!IHook::Exists(CreatePoseComponentHook004.name))
		{
			CreatePoseComponentHook004.CreateHookInObjectVTable(originalInterface, 7, &DetourCreatePoseComponent004);
			IHook::Register(&CreatePoseComponentHook004);
		}
		if (!IHook::Exists(UpdatePoseComponentHook004.name))
		{
			UpdatePoseComponentHook004.CreateHookInObjectVTable(originalInterface, 8, &DetourUpdatePoseComponent004);
			IHook::Register(&UpdatePoseComponentHook004);
		}
		if (!IHook::Exists(CreateEyeTrackingComponentHook004.name))
		{
			CreateEyeTrackingComponentHook004.CreateHookInObjectVTable(originalInterface, 9, &DetourCreateEyeTrackingComponent004);
			IHook::Register(&CreateEyeTrackingComponentHook004);
		}
		if (!IHook::Exists(UpdateEyeTrackingComponentHook004.name))
		{
			UpdateEyeTrackingComponentHook004.CreateHookInObjectVTable(originalInterface, 10, &DetourUpdateEyeTrackingComponent004);
			IHook::Register(&UpdateEyeTrackingComponentHook004);
		}
	}

	return originalInterface;
}

void InjectHooks(GalaxyXRDeviceProvider *driver, vr::IVRDriverContext *pDriverContext)
{
	Driver = driver;

	// auto err = MH_Initialize();
	// if (err == MH_OK)
	// {
	// 	GetGenericInterfaceHook.CreateHookInObjectVTable(pDriverContext, 0, &DetourGetGenericInterface);
	// 	IHook::Register(&GetGenericInterfaceHook);
	// }
	// else
	// {
	// 	DriverLog("MH_Initialize error: %s", MH_StatusToString(err));
	// }
	GetGenericInterfaceHook.CreateHookInObjectVTable(pDriverContext, 0, &DetourGetGenericInterface);
	IHook::Register(&GetGenericInterfaceHook);
#ifdef VENDOR_GALAXYXR
	gxr::vrlinksettings::S().observer = &ReportSettingsOverlay;
#endif
}

void DisableHooks()
{
#ifdef VENDOR_GALAXYXR
	gxr::vrlinksettings::Uninstall();
#endif
	IHook::DestroyAll();
	// MH_Uninitialize();
}
