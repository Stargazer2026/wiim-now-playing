jest.mock('http', () => ({
    get: jest.fn((url, callback) => {
        const { EventEmitter } = require('events');
        const request = {
            on: jest.fn().mockReturnThis()
        };

        if (callback) {
            const response = new EventEmitter();
            callback(response);
            process.nextTick(() => {
                if (url.includes('cmd=deviceInfo')) {
                    response.emit('data', JSON.stringify({
                        screenOn: false,
                        screenLocked: true,
                        displayState: 1,
                        timestamp: 1772783798427
                    }));
                } else {
                    response.emit('data', '{}');
                }
                response.emit('end');
            });
        }

        return request;
    })
}));

const createSettings = (overrides = {}) => ({
    kiosk: {
        host: '10.0.0.2',
        password: 'secret',
        screenOffDelaySec: 5,
        ...(overrides.kiosk || {})
    }
});

const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

describe('kiosk display reconciliation', () => {
    let kiosk;
    let http;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        kiosk = require('../lib/kiosk.js');
        http = require('http');
        http.get.mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('switches display on when transport changes to PLAYING', () => {
        kiosk.handleTransportState('PLAYING', 'STOPPED', createSettings(), {});

        expect(http.get).toHaveBeenCalled();
        expect(http.get.mock.calls.some((call) => call[0].includes('cmd=screenOn'))).toBe(true);
    });

    it('reconciles mismatch by scheduling display off with configured delay', () => {
        const settings = createSettings();

        kiosk.handleTransportState('PLAYING', 'STOPPED', settings, {});
        expect(http.get.mock.calls.some((call) => call[0].includes('cmd=screenOn'))).toBe(true);

        const before = http.get.mock.calls.length;
        kiosk.handleTransportState('STOPPED', 'STOPPED', settings, {});

        const duringDelay = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(duringDelay.some((url) => url.includes('cmd=screenOff'))).toBe(false);

        jest.advanceTimersByTime(5 * 1000);

        const afterDelay = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(afterDelay.some((url) => url.includes('cmd=screenOff'))).toBe(true);
    });

    it('does not force immediate display off during polling if off-delay timer is active', () => {
        const settings = createSettings();

        kiosk.handleTransportState('PLAYING', 'STOPPED', settings, {});
        expect(http.get.mock.calls.some((call) => call[0].includes('cmd=screenOn'))).toBe(true);

        kiosk.handleTransportState('PAUSED_PLAYBACK', 'PLAYING', settings, {});
        const beforePoll = http.get.mock.calls.length;

        kiosk.handleTransportState('PAUSED_PLAYBACK', 'PAUSED_PLAYBACK', settings, {});

        const duringDelay = http.get.mock.calls.slice(beforePoll).map((call) => call[0]);
        expect(duringDelay.some((url) => url.includes('cmd=screenOff'))).toBe(false);

        jest.advanceTimersByTime(5 * 1000);
        const afterDelay = http.get.mock.calls.slice(beforePoll).map((call) => call[0]);
        expect(afterDelay.some((url) => url.includes('cmd=screenOff'))).toBe(true);
    });

    it('treats NO_MEDIA_PRESENT as desired display off and respects configured delay', () => {
        const settings = createSettings();

        kiosk.handleTransportState('PLAYING', 'STOPPED', settings, {});
        expect(http.get.mock.calls.some((call) => call[0].includes('cmd=screenOn'))).toBe(true);

        const before = http.get.mock.calls.length;

        kiosk.handleTransportState('NO_MEDIA_PRESENT', 'NO_MEDIA_PRESENT', settings, {});

        const duringDelay = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(duringDelay.some((url) => url.includes('cmd=screenOff'))).toBe(false);

        jest.advanceTimersByTime(5 * 1000);
        const afterDelay = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(afterDelay.some((url) => url.includes('cmd=screenOff'))).toBe(true);
    });


    it('schedules delayed screen off for TRANSITIONING even when remembered display state is unknown', () => {
        const settings = createSettings();

        const before = http.get.mock.calls.length;
        kiosk.handleTransportState('TRANSITIONING', 'STOPPED', settings, {});

        const duringDelay = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(duringDelay.some((url) => url.includes('cmd=screenOff'))).toBe(false);

        jest.advanceTimersByTime(5 * 1000);

        const afterDelay = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(afterDelay.some((url) => url.includes('cmd=screenOff'))).toBe(true);
    });

    it('cancels a pending TRANSITIONING screen-off when transport returns to PLAYING', () => {
        const settings = createSettings();

        kiosk.handleTransportState('TRANSITIONING', 'STOPPED', settings, {});
        const beforePlaying = http.get.mock.calls.length;

        kiosk.handleTransportState('PLAYING', 'TRANSITIONING', settings, {});

        const playingCalls = http.get.mock.calls.slice(beforePlaying).map((call) => call[0]);
        expect(playingCalls.some((url) => url.includes('cmd=screenOn'))).toBe(true);

        jest.advanceTimersByTime(5 * 1000);

        const afterDelay = http.get.mock.calls.slice(beforePlaying).map((call) => call[0]);
        expect(afterDelay.some((url) => url.includes('cmd=screenOff'))).toBe(false);
    });

    it('probes actual display state every 60s and reconciles to desired state', async () => {
        const settings = createSettings();

        kiosk.applySettings(settings);
        kiosk.handleTransportState('PLAYING', 'STOPPED', settings, {});
        await flushAsync();

        const before = http.get.mock.calls.length;

        jest.advanceTimersByTime(60 * 1000);
        await flushAsync();

        const urls = http.get.mock.calls.slice(before).map((call) => call[0]);
        expect(urls.some((url) => url.includes('cmd=deviceInfo'))).toBe(true);
        expect(urls.some((url) => url.includes('cmd=screenOn'))).toBe(true);
    });
});
