#include "DeviceShim.h"
#include "DriverLog.h"
#include "FrameComponentShim.h"
#include "GalaxyLinkEpoch.h"
#include <cstring>

ShimTrackedDeviceDriver::ShimTrackedDeviceDriver(ShimDefinition* shimDefinition, vr::ITrackedDeviceServerDriver* original){
	DriverLog("Creating ShimTrackedDeviceDriver");
	this->shimDefinition = shimDefinition;
	if(!shimDefinition->trackedDevice){
		shimDefinition->trackedDevice = original;
	}
}

ShimDisplayComponent::ShimDisplayComponent(ShimDefinition* shimDefinition, vr::IVRDisplayComponent* original){
	DriverLog("Creating ShimDisplayComponent");
	this->shimDefinition = shimDefinition;
	if(!shimDefinition->displayComponent){
		shimDefinition->displayComponent = original;
	}
}

// shim the component function to also apply shims to components
void *ShimTrackedDeviceDriver::GetComponent(const char *pchComponentNameAndVersion){
	void* returnValue = nullptr;
	if(shimDefinition->shimActive){
		if(!shimDefinition->PreTrackedDeviceGetComponent(pchComponentNameAndVersion, returnValue)){
			return returnValue;
		}
	}
	// this may at some point need to load different shims depending on what the original returns
	// derived shims may overwrite these methods as needed
	if(strcmp(pchComponentNameAndVersion, vr::IVRDisplayComponent_Version) == 0 && shimDefinition->shimActive && shimDefinition->shimDisplayComponent){
		vr::IVRDisplayComponent* displayComponent = nullptr;
		if(shimDefinition->trackedDevice){
			displayComponent = (vr::IVRDisplayComponent*)shimDefinition->trackedDevice->GetComponent(pchComponentNameAndVersion);
		}
		returnValue = new ShimDisplayComponent(shimDefinition, displayComponent);
	}else if(shimDefinition->trackedDevice){
		returnValue = shimDefinition->trackedDevice->GetComponent(pchComponentNameAndVersion);
	}
	// log which components are fetched from this device so the frame path can be identified
	DriverLog("ShimTrackedDeviceDriver::GetComponent %s -> %p", pchComponentNameAndVersion, returnValue);
	// wrap the frame delivery components so frames can be observed (and later processed)
	// before the headset driver (e.g. vrlink) consumes them.
	// only wrap on an exact version match with the interface this was compiled against,
	// otherwise pass through unwrapped to avoid a mismatched vtable.
	// The wrappers act only while their lineage is ADMITTED and re-check per
	// call, so they are transparent after a disconnect while still forwarding
	// every call (including cleanup).
	const uint64_t frameGate = shimDefinition->galaxyLinkLineage;
	// Shims carrying a lineage exist ONLY for a proven target HMD object (created
	// at HandleDeviceAdded after BeginHmd), so the wrappers attach even if the
	// target is momentarily closed (reconnect, early fetch): otherwise a cached
	// unwrapped component would never enable later. The per-call lineage gate
	// below keeps closed / foreign states a byte-for-byte passthrough.
	const bool frameWrapAllowed = true;
	if(returnValue && shimDefinition->shimFrameComponent && frameWrapAllowed){
		if(strcmp(pchComponentNameAndVersion, vr::IVRDriverDirectModeComponent_Version) == 0){
			auto* wrapped = new DirectModeComponentShim((vr::IVRDriverDirectModeComponent*)returnValue);
			wrapped->galaxyLinkLineage = frameGate;
			returnValue = wrapped;
		}else if(strcmp(pchComponentNameAndVersion, vr::IVRVirtualDisplay_Version) == 0){
			auto* wrapped = new VirtualDisplayShim((vr::IVRVirtualDisplay*)returnValue);
			wrapped->galaxyLinkLineage = frameGate;
			returnValue = wrapped;
		}
	}
	if(shimDefinition->shimActive){
		shimDefinition->PosTrackedDeviceGetComponent(pchComponentNameAndVersion, returnValue);
	}
	return returnValue;
}


// vr::EVRInitError ShimTrackedDeviceDriver::Activate( uint32_t unObjectId ){
// 	vr::EVRInitError returnValue;
// 	if(shimDefinition->shimActive){
// 		if(!shimDefinition->PreTrackedDeviceActivate(unObjectId, returnValue)){
// 			return returnValue;
// 		}
// 	}
// 	returnValue = shimDefinition->trackedDevice->Activate(unObjectId);
// 	if(shimDefinition->shimActive){
// 		shimDefinition->PosTrackedDeviceActivate(unObjectId, returnValue);
// 	}
// 	return returnValue;
// }





#define COMMA ,

// DriverLog("Shim call: " #shimClass "::" #functionName "(" #argumentList ")" "\n");
#define SHIM_CALL_RETURNS(shimClass, functionName, shimClassFunctionName, shimObject, parameters, argumentList, returnType) \
returnType shimClass::functionName(parameters){ \
	 \
	returnType returnValue; \
	if(shimDefinition->shimActive){ \
		if(!shimDefinition->Pre##shimClassFunctionName##functionName(argumentList, returnValue)){ \
			return returnValue; \
		} \
	} \
	if(shimDefinition->shimObject){ \
		returnValue = shimDefinition->shimObject->functionName(argumentList); \
	} \
	if(shimDefinition->shimActive){ \
		shimDefinition->Pos##shimClassFunctionName##functionName(argumentList, returnValue); \
	} \
	return returnValue; \
}

// DriverLog("Shim call: " #shimClass "::" #functionName "(" ")" "\n");
#define SHIM_CALL_RETURNS_NO_ARGS(shimClass, functionName, shimClassFunctionName, shimObject, returnType) \
returnType shimClass::functionName(){ \
	 \
	returnType returnValue; \
	if(shimDefinition->shimActive){ \
		if(!shimDefinition->Pre##shimClassFunctionName##functionName(returnValue)){ \
			return returnValue; \
		} \
	} \
	if(shimDefinition->shimObject){ \
		returnValue = shimDefinition->shimObject->functionName(); \
	} \
	if(shimDefinition->shimActive){ \
		shimDefinition->Pos##shimClassFunctionName##functionName(returnValue); \
	} \
	return returnValue; \
}

// DriverLog("Shim call: " #shimClass "::" #functionName "(" #argumentList ")" "\n");
#define SHIM_CALL_VOID(shimClass, functionName, shimClassFunctionName, shimObject, parameters, argumentList) \
void shimClass::functionName(parameters){ \
	 \
	if(shimDefinition->shimActive){ \
		if(!shimDefinition->Pre##shimClassFunctionName##functionName(argumentList)){ \
			return; \
		} \
	} \
	if(shimDefinition->shimObject){ \
		shimDefinition->shimObject->functionName(argumentList); \
	} \
	if(shimDefinition->shimActive){ \
		shimDefinition->Pos##shimClassFunctionName##functionName(argumentList); \
	} \
} \


SHIM_CALL_RETURNS(ShimTrackedDeviceDriver, Activate, TrackedDevice, trackedDevice, uint32_t unObjectId, unObjectId, vr::EVRInitError)
SHIM_CALL_VOID(ShimTrackedDeviceDriver, Deactivate, TrackedDevice, trackedDevice, , )
SHIM_CALL_VOID(ShimTrackedDeviceDriver, EnterStandby, TrackedDevice, trackedDevice, , )
SHIM_CALL_VOID(ShimTrackedDeviceDriver, DebugRequest, TrackedDevice, trackedDevice, const char *pchRequest COMMA char *pchResponseBuffer COMMA uint32_t unResponseBufferSize, pchRequest COMMA pchResponseBuffer COMMA unResponseBufferSize)
SHIM_CALL_RETURNS_NO_ARGS(ShimTrackedDeviceDriver, GetPose, TrackedDevice, trackedDevice, vr::DriverPose_t)
// SHIM_CALL_RETURNS(ShimTrackedDeviceDriver, GetComponent, TrackedDevice, trackedDevice, const char *pchComponentNameAndVersion, pchComponentNameAndVersion, void*)

SHIM_CALL_RETURNS_NO_ARGS(ShimDisplayComponent, IsDisplayOnDesktop, DisplayComponent, displayComponent, bool)
SHIM_CALL_RETURNS_NO_ARGS(ShimDisplayComponent, IsDisplayRealDisplay, DisplayComponent, displayComponent, bool)
SHIM_CALL_VOID(ShimDisplayComponent, GetRecommendedRenderTargetSize, DisplayComponent, displayComponent, uint32_t *pnWidth COMMA uint32_t *pnHeight, pnWidth COMMA pnHeight)
SHIM_CALL_VOID(ShimDisplayComponent, GetEyeOutputViewport, DisplayComponent, displayComponent, vr::EVREye eEye COMMA uint32_t *pnX COMMA uint32_t *pnY COMMA uint32_t *pnWidth COMMA uint32_t *pnHeight, eEye COMMA pnX COMMA pnY COMMA pnWidth COMMA pnHeight)
SHIM_CALL_VOID(ShimDisplayComponent, GetProjectionRaw, DisplayComponent, displayComponent, vr::EVREye eEye COMMA float *pfLeft COMMA float *pfRight COMMA float *pfTop COMMA float *pfBottom, eEye COMMA pfLeft COMMA pfRight COMMA pfTop COMMA pfBottom)
SHIM_CALL_RETURNS(ShimDisplayComponent, ComputeDistortion, DisplayComponent, displayComponent, vr::EVREye eEye COMMA float fU COMMA float fV, eEye COMMA fU COMMA fV, vr::DistortionCoordinates_t)
SHIM_CALL_RETURNS(ShimDisplayComponent, ComputeInverseDistortion, DisplayComponent, displayComponent, vr::HmdVector2_t *pResult COMMA vr::EVREye eEye COMMA uint32_t unChannel COMMA float fU COMMA float fV, pResult COMMA eEye COMMA unChannel COMMA fU COMMA fV, bool)
SHIM_CALL_VOID(ShimDisplayComponent, GetWindowBounds, DisplayComponent, displayComponent, int32_t *pnX COMMA int32_t *pnY COMMA uint32_t *pnWidth COMMA uint32_t *pnHeight, pnX COMMA pnY COMMA pnWidth COMMA pnHeight)

