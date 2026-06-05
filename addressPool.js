const addressPools = {};

function getNextAddress(method, wallets) {
    const list = wallets[method];
    if (!list || list.length === 0) return null;

    if (!addressPools[method]) {
        addressPools[method] = { lastIndex: -1, reserved: {}, queue: [] };
    }
    const pool = addressPools[method];
    const now = Date.now();

    // Les reservations expirees retournent dans la file d'attente (queue)
    for (const addr in pool.reserved) {
        if (pool.reserved[addr] <= now) {
            delete pool.reserved[addr];
            if (!pool.queue.includes(addr)) pool.queue.push(addr);
        }
    }

    // Prendre la premiere adresse disponible dans la queue
    while (pool.queue.length > 0) {
        const addr = pool.queue.shift();
        if (!pool.reserved[addr]) return addr;
    }

    // Chercher la prochaine adresse libre dans la liste
    let attempts = 0;
    while (attempts < list.length) {
        pool.lastIndex = (pool.lastIndex + 1) % list.length;
        const addr = list[pool.lastIndex];
        if (!pool.reserved[addr]) {
            return addr;
        }
        attempts++;
    }

    // Toutes les adresses sont actuellement reservees
    return null;
}

function reserveAddress(method, address, expiresAt) {
    if (!addressPools[method]) {
        addressPools[method] = { lastIndex: -1, reserved: {}, queue: [] };
    }
    addressPools[method].reserved[address] = expiresAt;
}

function releaseAddress(method, address) {
    if (!addressPools[method]) return;
    delete addressPools[method].reserved[address];
    if (!addressPools[method].queue.includes(address)) {
        addressPools[method].queue.push(address);
    }
}

module.exports = { getNextAddress, reserveAddress, releaseAddress };