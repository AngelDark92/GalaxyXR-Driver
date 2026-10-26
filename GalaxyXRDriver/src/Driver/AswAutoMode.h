#pragma once
// ============================================================================
// AswAutoMode — host-side application-cadence sampler and half-rate decision.
//
// 2026-10-26 (owner directive): Async Spacewarp's saved mode is reinterpreted
// without rewriting any stored value:
//   spacewarpEnable = false            -> Off (carrier 0)
//   enable + spacewarpMode == 0        -> Automatic. Normal late-frame recovery
//                                         (carrier 1) until the measured game
//                                         cadence stays below 90% of refresh,
//                                         then half rate (carrier 2).
//   enable + spacewarpMode == 1        -> Forced half rate (carrier 2).
//
// Measurement contract (implementation plan 2026-10-26):
//   - application cadence only, through IVRServerDriverHost::GetFrameTimings;
//   - at most ten samples per second (SampleDue/MarkSampled);
//   - a fixed 128-entry history covering one second, deduplicated by frame
//     index and required to advance in submission time;
//   - automatic entry after 500 ms continuously below 0.90 x refresh and exit
//     after 2 s continuously at or above 0.97 x refresh, with one second of
//     valid history before the first decision;
//   - stale data (>500 ms), application changes, reconnects and refresh
//     changes reset the decision to normal late-frame recovery.
//
// The tracker is deliberately free of OpenVR types so the threshold,
// hysteresis, stale, reconnect and refresh-change vectors run as pure native
// tests. DeviceProvider converts Compositor_FrameTiming records into
// AswTimingFrame and owns the singleton accessor.
// ============================================================================

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <mutex>

namespace gxr {

struct AswTimingFrame {
	uint32_t frameIndex = 0;
	double systemTimeSeconds = 0.0;
};

class AswCadenceTracker {
public:
	static constexpr double kEnterRatio = 0.90;
	static constexpr double kExitRatio = 0.97;
	static constexpr double kEnterHoldSeconds = 0.50;
	static constexpr double kExitHoldSeconds = 2.00;
	static constexpr double kHistorySeconds = 1.00;
	static constexpr double kStaleSeconds = 0.50;
	static constexpr double kSampleIntervalSeconds = 0.10;
	static constexpr double kRefreshChangeHz = 0.50;
	static constexpr double kAppRestartJumpSeconds = 0.25;
	static constexpr std::size_t kHistoryCap = 128;
	static constexpr double kDefaultRefreshHz = 90.0;

	enum EffectiveMode : int { kOff = 0, kLateFrames = 1, kHalfRate = 2 };

	void SetRequested(bool enabled, int requestedMode){
		const bool forced = requestedMode == 1;
		if(enabled != requestedEnabled || forced != requestedForced){
			if(enabled && !requestedEnabled){
				// Fresh enablement: start in normal late-frame recovery and
				// require a fresh one-second history before entering half rate.
				ClearHistory();
				effectiveMode = kLateFrames;
				reason = "enabled";
			}else if(!enabled){
				effectiveMode = kOff;
				reason = "off";
				ClearHistory();
			}else if(forced != requestedForced){
				ClearHistory();
				ClearDecisionHolds();
				effectiveMode = forced ? kHalfRate : kLateFrames;
				reason = forced ? "forced" : "automatic";
			}
			requestedEnabled = enabled;
			requestedForced = forced;
		}
		if(!enabled){
			effectiveMode = kOff;
		}else if(forced){
			effectiveMode = kHalfRate;
			ClearDecisionHolds();
		}else if(effectiveMode == kOff){
			effectiveMode = kLateFrames;
		}
	}

	// Refresh in Hz. A missing/invalid property keeps the previous value; a
	// change larger than kRefreshChangeHz resets the decision and history.
	void SetRefreshHz(double hz){
		if(!std::isfinite(hz) || hz <= 1.0 || hz > 1000.0){
			return;
		}
		if(refreshHz > 0.0 && std::fabs(hz - refreshHz) > kRefreshChangeHz){
			ClearHistory();
			ClearDecisionHolds();
			effectiveMode = requestedEnabled ? (requestedForced ? kHalfRate : kLateFrames) : kOff;
			reason = "refresh-changed";
			++generation;
		}
		refreshHz = hz;
	}

	bool SampleDue(double now) const {
		if(!haveSample) return true;
		if(now < lastSampleTime) return true;  // clock reset (session boundary)
		return (now - lastSampleTime) >= kSampleIntervalSeconds;
	}

	void MarkSampled(double now){
		lastSampleTime = now;
		haveSample = true;
	}

	// Accept one provider sample. Records may overlap earlier samples; only a
	// frame index newer than the newest accepted record with a strictly newer
	// submission timestamp advances the history.
	void Observe(double now, double hz, const AswTimingFrame* frames, std::size_t count){
		SetRefreshHz(hz);
		ExpireHistory(now);
		if(!frames || count == 0){
			Evaluate(now);
			return;
		}

		// Application restart/reset: a newer submission timestamp paired with a
		// frame index behind the newest accepted one is a new app/session, not an
		// out-of-order record.
		if(haveNewest){
			for(std::size_t i = 0; i < count; ++i){
				if(std::isfinite(frames[i].systemTimeSeconds)
					&& frames[i].systemTimeSeconds > newestTime + kAppRestartJumpSeconds
					&& frames[i].frameIndex < newestIndex){
					ClearHistory();
					ClearDecisionHolds();
					effectiveMode = requestedEnabled ? kLateFrames : kOff;
					reason = "application-changed";
					++generation;
					break;
				}
			}
		}

		// The provider does not guarantee record order. Sort this sample by
		// submission time before deduplicating so newest-first, oldest-first and
		// interleaved records all advance the same one-second history.
		AswTimingFrame sorted[32];
		std::size_t take = 0;
		for(std::size_t i = 0; i < std::min<std::size_t>(count, 32); ++i){
			if(std::isfinite(frames[i].systemTimeSeconds) && frames[i].systemTimeSeconds > 0.0){
				sorted[take++] = frames[i];
			}
		}
		std::sort(sorted, sorted + take, [](const AswTimingFrame& a, const AswTimingFrame& b){
			if(a.systemTimeSeconds != b.systemTimeSeconds){
				return a.systemTimeSeconds < b.systemTimeSeconds;
			}
			return a.frameIndex < b.frameIndex;
		});
		if(!haveNewest && take > 0){
			// GetFrameTimings includes pre-enable/pre-boundary records. The first
			// poll establishes only a newest-frame watermark; replayed history
			// cannot contribute to the new session's one-second warmup.
			AcceptFrame(sorted[take - 1]);
			evidenceSince = now;
			lastFrameAdvanceTime = now;
		}else{
			for(std::size_t i = 0; i < take; ++i){
				if(AcceptFrame(sorted[i])) lastFrameAdvanceTime = now;
			}
		}
		PruneHistory();
		Evaluate(now);
	}

	// Explicit session boundary: reconnect, SteamVR app change, transport
	// replacement. The saved request is untouched; the runtime decision resets.
	void NotifyBoundary(const char* why){
		ClearHistory();
		ClearDecisionHolds();
		effectiveMode = requestedEnabled ? (requestedForced ? kHalfRate : kLateFrames) : kOff;
		reason = why ? why : "session-changed";
		++generation;
	}

	int Evaluate(double now){
		if(!requestedEnabled){
			effectiveMode = kOff;
			return effectiveMode;
		}
		if(requestedForced){
			effectiveMode = kHalfRate;
			ClearDecisionHolds();
			return effectiveMode;
		}
		if(ExpireHistory(now)){
			return effectiveMode;
		}

		double fps = 0.0;
		double span = 0.0;
		if(!ValidHistory(now, &fps, &span)){
			ClearDecisionHolds();
			effectiveMode = kLateFrames;
			return effectiveMode;
		}
		const double refresh = refreshHz > 0.0 ? refreshHz : kDefaultRefreshHz;
		if(fps < kEnterRatio * refresh){
			aboveSince = 0.0;
			haveAbove = false;
			if(!haveBelow){
				belowSince = now;
				haveBelow = true;
			}
			if(now - belowSince >= kEnterHoldSeconds && effectiveMode != kHalfRate){
				effectiveMode = kHalfRate;
				reason = "auto-low-fps";
				++generation;
				++enterCount;
			}
		}else if(fps >= kExitRatio * refresh){
			belowSince = 0.0;
			haveBelow = false;
			if(!haveAbove){
				aboveSince = now;
				haveAbove = true;
			}
			if(now - aboveSince >= kExitHoldSeconds && effectiveMode != kLateFrames){
				effectiveMode = kLateFrames;
				reason = "auto-recovered";
				++generation;
				++exitCount;
			}
		}else{
			// Hysteresis band (0.90..0.97 of refresh): hold the decision and
			// restart both continuous-time windows.
			ClearDecisionHolds();
		}
		return effectiveMode;
	}

	bool Enabled() const { return requestedEnabled; }
	bool Forced() const { return requestedForced; }
	int EffectiveMode() const { return requestedEnabled ? effectiveMode : kOff; }
	int RequestedMode() const { return requestedForced ? 1 : 0; }
	const char* Reason() const { return reason; }
	double MeasuredFps() const { return measuredFps; }
	double HistorySpanSeconds() const { return historySpan; }
	double RefreshHz() const { return refreshHz; }
	bool HaveValidHistory() const { return historyValid; }
	uint64_t Generation() const { return generation; }
	uint32_t EnterCount() const { return enterCount; }
	uint32_t ExitCount() const { return exitCount; }
	std::size_t HistoryCount() const { return historyCount; }

	int EffectiveForRequest(bool enabled, int requestedMode) const {
		if(!enabled) return kOff;
		if(requestedMode == 1) return kHalfRate;
		return effectiveMode == kHalfRate ? kHalfRate : kLateFrames;
	}

private:
	struct Entry {
		uint32_t frameIndex = 0;
		double time = 0.0;
	};

	bool AcceptFrame(const AswTimingFrame& frame){
		if(!std::isfinite(frame.systemTimeSeconds) || frame.systemTimeSeconds <= 0.0){
			return false;
		}
		if(haveNewest){
			// Deduplicate overlapping records: only a newer index with a
			// strictly advancing submission timestamp is a new application frame.
			if(frame.frameIndex <= newestIndex){
				return false;
			}
			if(frame.systemTimeSeconds <= newestTime){
				return false;
			}
		}
		Entry& slot = history[historyHead];
		slot.frameIndex = frame.frameIndex;
		slot.time = frame.systemTimeSeconds;
		historyHead = (historyHead + 1) % kHistoryCap;
		if(historyCount < kHistoryCap){
			++historyCount;
		}
		newestIndex = frame.frameIndex;
		newestTime = frame.systemTimeSeconds;
		haveNewest = true;
		return true;
	}

	void PruneHistory(){
		if(!haveNewest) return;
		const double cutoff = newestTime - kHistorySeconds;
		// Accepted timestamps are strictly increasing. Keep the last record at
		// or before the cutoff as well as every newer one: fractional cadences
		// such as 20.5 FPS need that bracketing interval to cover a full second.
		while(historyCount > 2){
			const std::size_t oldest = (historyHead + kHistoryCap - historyCount) % kHistoryCap;
			const std::size_t next = (oldest + 1) % kHistoryCap;
			if(history[next].time > cutoff) break;
			--historyCount;
		}
	}

	bool ValidHistory(double now, double* fps, double* span) {
		if(fps) *fps = 0.0;
		if(span) *span = 0.0;
		if(!haveNewest || historyCount < 2 || now - evidenceSince + 1e-9 < kHistorySeconds){
			historyValid = false;
			measuredFps = 0.0;
			historySpan = 0.0;
			return false;
		}
		const std::size_t oldest = (historyHead + kHistoryCap - historyCount) % kHistoryCap;
		const double window = newestTime - history[oldest].time;
		if(!(window > 0.0) || window + 1e-9 < kHistorySeconds){
			historyValid = false;
			measuredFps = 0.0;
			historySpan = 0.0;
			return false;
		}
		const double value = static_cast<double>(historyCount - 1) / window;
		if(!std::isfinite(value) || value <= 0.0){
			historyValid = false;
			return false;
		}
		measuredFps = value;
		historySpan = window;
		historyValid = true;
		if(fps) *fps = value;
		if(span) *span = window;
		return true;
	}

	bool ExpireHistory(double now){
		if(!haveNewest) return false;
		const bool clockReset = now < lastFrameAdvanceTime || now < evidenceSince;
		if(!clockReset && now - lastFrameAdvanceTime <= kStaleSeconds) return false;
		// OpenVR submission timestamps and the provider's steady clock need not
		// share an epoch. Freshness uses only the local time of frame advancement.
		NotifyBoundary(clockReset ? "clock-reset" : "stale-timing");
		return true;
	}

	void ClearHistory(){
		historyHead = 0;
		historyCount = 0;
		haveNewest = false;
		newestIndex = 0;
		newestTime = 0.0;
		evidenceSince = 0.0;
		lastFrameAdvanceTime = 0.0;
		measuredFps = 0.0;
		historySpan = 0.0;
		historyValid = false;
		ClearDecisionHolds();
	}

	void ClearDecisionHolds(){
		haveBelow = false;
		haveAbove = false;
		belowSince = 0.0;
		aboveSince = 0.0;
	}

	Entry history[kHistoryCap];
	std::size_t historyHead = 0;
	std::size_t historyCount = 0;
	bool haveNewest = false;
	uint32_t newestIndex = 0;
	double newestTime = 0.0;
	double evidenceSince = 0.0;
	double lastFrameAdvanceTime = 0.0;

	bool requestedEnabled = false;
	bool requestedForced = false;
	int effectiveMode = kOff;
	const char* reason = "off";

	double refreshHz = 0.0;
	double lastSampleTime = 0.0;
	bool haveSample = false;

	bool haveBelow = false;
	bool haveAbove = false;
	double belowSince = 0.0;
	double aboveSince = 0.0;

	double measuredFps = 0.0;
	double historySpan = 0.0;
	bool historyValid = false;
	uint64_t generation = 0;
	uint32_t enterCount = 0;
	uint32_t exitCount = 0;
};

struct AswAutoModeSnapshot {
	bool enabled = false;
	int requestedMode = 0;   // stored: 0 automatic, 1 forced
	int effectiveMode = 0;   // carrier class: 0 off, 1 late frames, 2 half rate
	double measuredFps = 0.0;
	double refreshHz = 0.0;
	double historySpanSeconds = 0.0;
	bool historyValid = false;
	const char* reason = "off";
	uint64_t generation = 0;
	uint32_t enterCount = 0;
	uint32_t exitCount = 0;
};

// Process-wide accessor used by the settings path (requested values), the
// provider frame loop (sampling) and info.json telemetry. The mutex keeps the
// settings thread and the provider thread consistent; the provider is the only
// writer of measured history.
class AswAutoMode {
public:
	static AswAutoMode& Get(){
		static AswAutoMode instance;
		return instance;
	}

	void SetRequested(bool enabled, int requestedMode){
		std::lock_guard<std::mutex> lock(mutex);
		tracker.SetRequested(enabled, requestedMode == 1 ? 1 : 0);
	}

	void SetRefreshHz(double hz){
		std::lock_guard<std::mutex> lock(mutex);
		tracker.SetRefreshHz(hz);
	}

	bool SampleDue(double now){
		std::lock_guard<std::mutex> lock(mutex);
		return tracker.SampleDue(now);
	}

	void MarkSampled(double now){
		std::lock_guard<std::mutex> lock(mutex);
		tracker.MarkSampled(now);
	}

	void Observe(double now, double hz, const AswTimingFrame* frames, std::size_t count){
		std::lock_guard<std::mutex> lock(mutex);
		tracker.Observe(now, hz, frames, count);
	}

	int Evaluate(double now){
		std::lock_guard<std::mutex> lock(mutex);
		return tracker.Evaluate(now);
	}

	void NotifyBoundary(const char* why){
		std::lock_guard<std::mutex> lock(mutex);
		tracker.NotifyBoundary(why);
	}

	int EffectiveForRequest(bool enabled, int requestedMode){
		std::lock_guard<std::mutex> lock(mutex);
		return tracker.EffectiveForRequest(enabled, requestedMode == 1 ? 1 : 0);
	}

	AswAutoModeSnapshot Snapshot(){
		std::lock_guard<std::mutex> lock(mutex);
		AswAutoModeSnapshot out;
		out.enabled = tracker.Enabled();
		out.requestedMode = tracker.RequestedMode();
		out.effectiveMode = tracker.EffectiveMode();
		out.measuredFps = tracker.MeasuredFps();
		out.refreshHz = tracker.RefreshHz();
		out.historySpanSeconds = tracker.HistorySpanSeconds();
		out.historyValid = tracker.HaveValidHistory();
		out.reason = tracker.Reason();
		out.generation = tracker.Generation();
		out.enterCount = tracker.EnterCount();
		out.exitCount = tracker.ExitCount();
		return out;
	}

private:
	AswAutoMode() = default;
	std::mutex mutex;
	AswCadenceTracker tracker;
};

}  // namespace gxr
