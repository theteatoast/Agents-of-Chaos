import config from '../config/index.js';
import { startSimulation, stopSimulation, getSimulationStatus } from '../simulation/tickEngine.js';

let schedulerIntervalId = null;

function parseOptionalIsoDate(value) {
    if (!value || typeof value !== 'string') return null;
    const d = new Date(value.trim());
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

/**
 * Public: schedule info for API / logs (same parsing as config).
 */
export function getSimulationScheduleInfo() {
    const start = parseOptionalIsoDate(process.env.SIMULATION_AUTO_START_AT);
    const stop = parseOptionalIsoDate(process.env.SIMULATION_AUTO_STOP_AT);
    return {
        auto_start_at: start?.toISOString() ?? null,
        auto_stop_at: stop?.toISOString() ?? null,
        auto_start_at_local_hint: process.env.SIMULATION_AUTO_START_AT || null,
        auto_stop_at_local_hint: process.env.SIMULATION_AUTO_STOP_AT || null,
        note: 'Use ISO 8601 with timezone offset, e.g. 2026-03-22T01:00:00+05:30 for 1:00 IST.',
    };
}

/**
 * If SIMULATION_AUTO_START_AT / SIMULATION_AUTO_STOP_AT are set, periodically start/stop the tick loop.
 * Does not require ADMIN_API_KEY (runs inside the server process).
 */
export function startSimulationScheduler() {
    const start = parseOptionalIsoDate(process.env.SIMULATION_AUTO_START_AT);
    const stop = parseOptionalIsoDate(process.env.SIMULATION_AUTO_STOP_AT);

    if (!start && !stop) {
        return;
    }

    if (start && stop && stop.getTime() <= start.getTime()) {
        console.warn(
            '⚠️  SIMULATION_AUTO_STOP_AT must be after SIMULATION_AUTO_START_AT — scheduler disabled.'
        );
        return;
    }

    console.log('📅 Simulation schedule:', {
        auto_start_at: start?.toISOString() ?? '(not set)',
        auto_stop_at: stop?.toISOString() ?? '(not set)',
    });

    const tick = () => {
        const now = Date.now();
        const started = start != null;
        const stopped = stop != null;
        const { running } = getSimulationStatus();

        // In [start, stop): ensure running
        if (started && stopped) {
            if (now >= start.getTime() && now < stop.getTime()) {
                if (!running) {
                    const r = startSimulation();
                    console.log('⏰ Scheduled simulation start:', r);
                }
            }
            if (now >= stop.getTime() && running) {
                const r = stopSimulation();
                console.log('⏰ Scheduled simulation stop:', r);
            }
        } else if (started && !stopped) {
            if (now >= start.getTime() && !running) {
                const r = startSimulation();
                console.log('⏰ Scheduled simulation start:', r);
            }
        } else if (!started && stopped) {
            if (now >= stop.getTime() && running) {
                const r = stopSimulation();
                console.log('⏰ Scheduled simulation stop:', r);
            }
        }
    };

    tick();
    schedulerIntervalId = setInterval(tick, 30_000);
}

export function stopSimulationScheduler() {
    if (schedulerIntervalId) {
        clearInterval(schedulerIntervalId);
        schedulerIntervalId = null;
    }
}
