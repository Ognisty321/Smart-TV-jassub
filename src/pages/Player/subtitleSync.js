// AVPlay reports the media position before Samsung's display pipeline has finished processing
// the frame. That latency depends on the TV and its picture settings, so it cannot be queried;
// a device-local setting supplies it and positive milliseconds hold app-drawn subtitles back.
export const subtitleDelayWithLatency = (delaySeconds, latencyMs, usesAvplay) => {
	const latencySeconds = usesAvplay ? Math.max(0, Number(latencyMs) || 0) / 1000 : 0;
	return (Number(delaySeconds) || 0) + latencySeconds;
};

export const subtitleMediaTime = (seconds, delaySeconds, latencyMs, usesAvplay) =>
	(Math.max(0, Number(seconds) || 0) - subtitleDelayWithLatency(delaySeconds, latencyMs, usesAvplay));
