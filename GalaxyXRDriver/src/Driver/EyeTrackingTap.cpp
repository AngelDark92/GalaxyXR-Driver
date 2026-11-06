#include "EyeTrackingTap.h"
#include "DriverLog.h"
#include "../Helpers/EyeTrackingOutput.h"

#include <chrono>
#include <cstring>
#include <cstdio>

EyeTrackingTap eyeTrackingTap = {};

static double SteadyNowSeconds(){
	return std::chrono::duration_cast<std::chrono::microseconds>(
		std::chrono::steady_clock::now().time_since_epoch()).count() / 1000000.0;
}

void EyeTrackingTap::OnCreateComponent(vr::PropertyContainerHandle_t container, const char* name,
		vr::VRInputComponentHandle_t handle, vr::EVRInputError error){
	// the recon headline: does vrlink create an eye tracking component at all,
	// and under which identity / on which container and path. always log.
	DriverLog("EyeTrackingTap: CreateEyeTrackingComponent container=%llu path=%s -> handle=%llu error=%d",
		(unsigned long long)container, name ? name : "(null)",
		(unsigned long long)handle, (int)error);
	if(handle != vr::k_ulInvalidInputComponentHandle
			&& handle == eyeTrackingOutput.eyeTrackingComponentHandle){
		// this component belongs to our own EyeTrackingOutput, not a foreign driver
		DriverLog("EyeTrackingTap: (component belongs to our own EyeTrackingOutput, samples will be ignored)");
	}
}

void EyeTrackingTap::OnUpdateComponent(vr::VRInputComponentHandle_t component,
		const vr::VREyeTrackingData_t* data, double timeOffset){
	if(!data){
		return;
	}
	// skip samples our own EyeTrackingOutput publishes; the tap only wants foreign (vrlink) gaze
	if(component != vr::k_ulInvalidInputComponentHandle
			&& component == eyeTrackingOutput.eyeTrackingComponentHandle){
		return;
	}

	double now = SteadyNowSeconds();

	// raw payload watch, before any interpretation. hex-log the first payload
	// and every change (throttled), so "the stream is empty" is a statement
	// about vrlink's bytes rather than about our struct reading.
	{
		const uint8_t* raw = (const uint8_t*)data;
		char hex[sizeof(vr::VREyeTrackingData_t) * 2 + 1] = {};
		bool changed = !haveRaw || memcmp(lastRaw, raw, sizeof(lastRaw)) != 0;
		if(changed){
			for(size_t i = 0; i < sizeof(lastRaw); i++){
				snprintf(hex + i * 2, 3, "%02x", raw[i]);
			}
			memcpy(lastRaw, raw, sizeof(lastRaw));
			bool first = !haveRaw;
			haveRaw = true;
			distinctPayloads++;
			if(first){
				DriverLog("EyeTrackingTap: first raw payload (%zu bytes): %s", sizeof(lastRaw), hex);
			}else if(now - lastChangeLogTime >= 1.0){
				lastChangeLogTime = now;
				DriverLog("EyeTrackingTap: raw payload changed (%llu distinct so far): %s",
					(unsigned long long)distinctPayloads, hex);
			}
		}
	}

	Sample sample;
	sample.active = data->bActive;
	sample.valid = data->bValid;
	sample.tracked = data->bTracked;
	sample.originX = data->vGazeOrigin.v[0];
	sample.originY = data->vGazeOrigin.v[1];
	sample.originZ = data->vGazeOrigin.v[2];
	sample.targetX = data->vGazeTarget.v[0];
	sample.targetY = data->vGazeTarget.v[1];
	sample.targetZ = data->vGazeTarget.v[2];
	sample.timeOffset = timeOffset;
	sample.receivedTime = now;
	sample.component = component;

	bool logFull = false;
	bool logSummary = false;
	bool logFlags = false;
	double rateForLog = 0;
	uint64_t indexForLog = 0;

	{
		std::lock_guard<std::mutex> guard(lock);
		sampleCount++;
		sample.sampleIndex = sampleCount;
		latest = sample;
		indexForLog = sampleCount;

		// rate estimation over ~1s windows
		if(rateWindowStart == 0){
			rateWindowStart = now;
		}
		rateWindowCount++;
		double windowLength = now - rateWindowStart;
		if(windowLength >= 1.0){
			measuredRate = rateWindowCount / windowLength;
			rateWindowStart = now;
			rateWindowCount = 0;
		}
		rateForLog = measuredRate;

		// logging decisions inside the lock, DriverLog calls outside it
		if(sampleCount <= fullDetailSamples){
			logFull = true;
		}else if(now - lastSummaryLogTime >= 1.0){
			lastSummaryLogTime = now;
			logSummary = true;
		}
		if(!haveFlagBaseline){
			haveFlagBaseline = true;
			lastValid = sample.valid;
			lastTracked = sample.tracked;
		}else if((sample.valid != lastValid || sample.tracked != lastTracked)
				&& now - lastFlagLogTime >= 1.0){
			lastFlagLogTime = now;
			lastValid = sample.valid;
			lastTracked = sample.tracked;
			logFlags = true;
		}else{
			lastValid = sample.valid;
			lastTracked = sample.tracked;
		}
	}

	if(logFull){
		DriverLog("EyeTrackingTap: sample %llu component=%llu active=%d valid=%d tracked=%d "
			"origin=(%.4f, %.4f, %.4f) target=(%.4f, %.4f, %.4f) timeOffset=%.4f",
			(unsigned long long)indexForLog, (unsigned long long)component,
			(int)sample.active, (int)sample.valid, (int)sample.tracked,
			sample.originX, sample.originY, sample.originZ,
			sample.targetX, sample.targetY, sample.targetZ,
			sample.timeOffset);
	}else if(logSummary){
		DriverLog("EyeTrackingTap: %llu samples rate=%.1fHz distinctRaw=%llu valid=%d tracked=%d "
			"target=(%.4f, %.4f, %.4f) timeOffset=%.4f",
			(unsigned long long)indexForLog, rateForLog,
			(unsigned long long)distinctPayloads,
			(int)sample.valid, (int)sample.tracked,
			sample.targetX, sample.targetY, sample.targetZ,
			sample.timeOffset);
	}
	if(logFlags){
		DriverLog("EyeTrackingTap: flags changed at sample %llu: valid=%d tracked=%d",
			(unsigned long long)indexForLog, (int)sample.valid, (int)sample.tracked);
	}
}

bool EyeTrackingTap::GetLatestSample(Sample &out, double maxAgeSeconds){
	std::lock_guard<std::mutex> guard(lock);
	if(sampleCount == 0){
		return false;
	}
	if(maxAgeSeconds > 0 && SteadyNowSeconds() - latest.receivedTime > maxAgeSeconds){
		return false;
	}
	out = latest;
	return true;
}

void EyeTrackingTap::Clear(){
	std::lock_guard<std::mutex> guard(lock);
	latest = Sample();
	sampleCount = 0;
	haveFlagBaseline = false;
	rateWindowStart = 0;
	rateWindowCount = 0;
	measuredRate = 0;
	haveRaw = false;
}

double EyeTrackingTap::GetSampleRate(){
	std::lock_guard<std::mutex> guard(lock);
	return measuredRate;
}
