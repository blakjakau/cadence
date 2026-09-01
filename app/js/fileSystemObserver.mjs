import conduitClient from './conduit-client.mjs';

const observers = new Map();
let globalListenerAttached = false;

const handleConduitNotify = (message) => {
    const { path, data } = message;
    if (observers.has(path) && (data === 'WRITE' || data === 'CREATE' || data === 'REMOVE' || data === 'RENAME' || data === 'CHMOD')) {
        const callback = observers.get(path);
        callback(path);
    }
};

export const observeFile = async (path, callback) => {
    if (!path || typeof path !== 'string') return;

    if (observers.has(path)) return;

    if (!globalListenerAttached) {
        conduitClient.on('notify', handleConduitNotify);
        globalListenerAttached = true;
    }

    try {
        await conduitClient.wsWatch(path);
        observers.set(path, callback);
    } catch (error) {
        console.error(`Error observing file ${path}:`, error);
    }
};

export const unobserveFile = (path) => {
    if (!path || typeof path !== 'string') return;

    if (observers.has(path)) {
        observers.delete(path);
    }
};

conduitClient.on('connect', () => {
    for (const path of observers.keys()) {
        conduitClient.wsWatch(path).catch(error => {
            console.error(`Error re-registering watch for file ${path}:`, error);
        });
    }
});

