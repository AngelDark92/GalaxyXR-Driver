#include "../DriverLog.h"
#include "Hooking.h"
#include "InterfaceHookInjector.h"
#include "../DeviceProvider.h"
#include "../EyeTrackingTap.h"
#include <atomic>

static GalaxyXRDeviceProvider *Driver = nullptr;

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

// 2026-09-24: publish the corrected pose for physical streamed controllers.
// The previous diagnostic-only path ran the estimator but always forwarded
// newPose, so grip, Kalman and smoothing changes never reached SteamVR.
// Other devices retain the caller's original object, including native hands.
// Upstream observed hand-role failures even when only controller copies were
// forwarded (SteamVR 2.17.9 / Steam Link 2.0.20). This restores controller
// compensation, but does not establish that controller/hand switching is fixed.
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

static void DetourTrackedDevicePoseUpdated005(vr::IVRServerDriverHost *_this, uint32_t unWhichDevice, const vr::DriverPose_t &newPose, uint32_t unPoseStructSize)
{
	PoseAbiWarn(unPoseStructSize);
	if (unPoseStructSize != sizeof(vr::DriverPose_t))
	{
		TrackedDevicePoseUpdatedHook005.originalFunc(_this, unWhichDevice, newPose, unPoseStructSize);
		return;
	}
	const bool correctController = Driver->IsStreamedController(unWhichDevice);
	auto pose = newPose;
	if (Driver->HandleDevicePoseUpdated(unWhichDevice, pose))
	{
		TrackedDevicePoseUpdatedHook005.originalFunc(_this, unWhichDevice, correctController ? pose : newPose, unPoseStructSize);
	}
}

static void DetourTrackedDevicePoseUpdated006(vr::IVRServerDriverHost *_this, uint32_t unWhichDevice, const vr::DriverPose_t &newPose, uint32_t unPoseStructSize)
{
	PoseAbiWarn(unPoseStructSize);
	if (unPoseStructSize != sizeof(vr::DriverPose_t))
	{
		TrackedDevicePoseUpdatedHook006.originalFunc(_this, unWhichDevice, newPose, unPoseStructSize);
		return;
	}
	const bool correctController = Driver->IsStreamedController(unWhichDevice);
	auto pose = newPose;
	if (Driver->HandleDevicePoseUpdated(unWhichDevice, pose))
	{
		TrackedDevicePoseUpdatedHook006.originalFunc(_this, unWhichDevice, correctController ? pose : newPose, unPoseStructSize);
	}
}

static void DetourTrackedDeviceAdded006(vr::IVRServerDriverHost *_this, const char *pchDeviceSerialNumber, vr::ETrackedDeviceClass eDeviceClass, vr::ITrackedDeviceServerDriver *pDriver)
{
	if (Driver->HandleDeviceAdded(pchDeviceSerialNumber, eDeviceClass, pDriver))  
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
	eyeTrackingTap.OnCreateComponent(ulContainer, pchName,
		pHandle ? *pHandle : vr::k_ulInvalidInputComponentHandle, error);
	return error;
}

static vr::EVRInputError DetourUpdateEyeTrackingComponent004(vr::IVRDriverInput *_this, vr::VRInputComponentHandle_t ulComponent, const vr::VREyeTrackingData_t *pEyeTrackingData, double fTimeOffset)
{
	auto error = UpdateEyeTrackingComponentHook004.originalFunc(_this, ulComponent, pEyeTrackingData, fTimeOffset);
	eyeTrackingTap.OnUpdateComponent(ulComponent, pEyeTrackingData, fTimeOffset);
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
	
	// TRACE("ServerTrackedDeviceProvider::DetourGetGenericInterface(%s)", pchInterfaceVersion);
	auto originalInterface = GetGenericInterfaceHook.originalFunc(_this, pchInterfaceVersion, peError);

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
}

void DisableHooks()
{
	IHook::DestroyAll();
	// MH_Uninitialize();
}