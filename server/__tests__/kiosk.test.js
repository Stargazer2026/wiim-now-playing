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

    it('reconciles mismatch by switching display off immediately during polling', () => {
        const settings = createSettings();

        kiosk.handleTransportState('PLAYING', 'STOPPED', settings, {});
        expect(http.get.mock.calls.some((call) => call[0].includes('cmd=screenOn'))).toBe(true);

        kiosk.handleTransportState('STOPPED', 'STOPPED', settings, {});

        expect(http.get.mock.calls.some((call) => call[0].includes('cmd=screenOff'))).toBe(true);
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
