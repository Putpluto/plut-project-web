const socket     = io();
const logTbody   = document.getElementById('log-tbody');
const statusBadge = document.getElementById('status-badge');

const MAX_TABLE_ROWS = 100;

// ─── Connection status ────────────────────────────────────────────────────────

// Server ↔ Broker status
socket.on('status_update', (data) => {
    statusBadge.innerText = data.status;
    statusBadge.className = data.status === 'ONLINE' ? 'status-online' : 'status-offline';
});

// FIX: Handle socket disconnect — don't leave the badge stuck on "ONLINE"
socket.on('disconnect', () => {
    statusBadge.innerText = "DISCONNECTED";
    statusBadge.className = "status-offline";
});

socket.on('reconnect', () => {
    statusBadge.innerText = "RECONNECTING...";
    statusBadge.className = "";
});

// ESP32 main node LWT status — the ONLY thing that should update the main-node badge.
// The server caches this and replays it on every new connection, so page refreshes
// always show the correct state even if the LWT hasn't changed recently.
socket.on('main_node_status', (data) => {
    setMainNodeBadge(data.status);
});

// ─── Live MQTT messages ────────────────────────────────────────────────────────
socket.on('mqtt_message', (data) => {
    // Always pass ISO string — never a raw Date object
    updateNodeUI(data.topic, data.value, data.timestamp);

    // Only seismic alarm events reach the main log table
    if (data.value && /^\d/.test(data.value.trim()) && /(confirmed|false)/i.test(data.value)) {
        const p = parsePayload(data.value);
        logTbody.appendChild(
            createRow(formatDateTime(data.timestamp), p.magnitude, p.message || data.topic)
        );
        // FIX: Trim table to MAX_TABLE_ROWS during live updates (was already done here,
        // but now matches the same limit enforced during the initial history load below)
        while (logTbody.children.length > MAX_TABLE_ROWS) {
            logTbody.firstChild.remove();
        }
        scrollToBottom();
    }
});

// ─── History cleared ──────────────────────────────────────────────────────────
socket.on('history_cleared', () => {
    logTbody.innerHTML = '';
    Object.keys(nodeHistoryLogs).forEach(k => { nodeHistoryLogs[k] = []; });

    document.querySelectorAll('.node-badge').forEach(b => {
        b.innerText = "OFFLINE";
        b.className = "node-badge badge-offline";
    });
    document.querySelectorAll('.node-time').forEach(t => { t.innerText = "Never"; });
    document.querySelectorAll('.node-val').forEach(v  => { v.innerText = "N/A"; });
    document.querySelectorAll('.node-card').forEach(card => updateBatteryUI(card, null));

    const systemRow = createRow(
        formatDateTime(new Date().toISOString()), "SYSTEM", "⚠️ Logs Cleared"
    );
    systemRow.classList.add('system-row');
    logTbody.appendChild(systemRow);
});

// ─── Initial data load ────────────────────────────────────────────────────────
// FIX: Battery events now use `b.node_id` to construct the correct topic, rather
// than hardcoding 'home/earthquake/main_node' for every row, which would misattribute
// data from individual node topics to the wrong card.
//
// FIX: Main log table is trimmed to MAX_TABLE_ROWS after the initial load, matching
// the live-message handler — previously it was unbounded on page load.

Promise.all([
    fetch('/api/history').then(r => r.json()),
    fetch('/api/earthquake').then(r => r.json()),
    fetch('/api/battery').then(r => r.json())
]).then(([carData, quakeData, battData]) => {

    // ── Main seismic event table ──
    const quakeEvents = quakeData.map(q => ({
        mag:      parsePayload(q.magnitude).magnitude,
        msg:      parsePayload(q.magnitude).message || `Node: ${q.node_id}`,
        timestamp: q.timestamp,
        rawTopic: 'home/earthquake/main_node',
        rawVal:   q.magnitude
    }));

    const carEvents = carData.map(c => ({
        mag:      parsePayload(c.value).magnitude,
        msg:      parsePayload(c.value).message || `Topic: ${c.topic}`,
        timestamp: c.timestamp,
        rawTopic: c.topic,
        rawVal:   c.value
    }));

    const mainTableEvents = [...quakeEvents, ...carEvents]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    mainTableEvents.forEach(item => {
        if (item.rawVal && /^\d/.test(item.rawVal.trim()) && /(confirmed|false)/i.test(item.rawVal)) {
            logTbody.appendChild(
                createRow(formatDateTime(item.timestamp), item.mag, item.msg)
            );
        }
    });

    // FIX: Trim table after history load (was previously unbounded)
    while (logTbody.children.length > MAX_TABLE_ROWS) {
        logTbody.firstChild.remove();
    }

    // ── Node card history (seismic + battery) ──
    const battEvents = battData.map(b => ({
        // FIX: Use actual node_id from the DB record to construct the correct topic
        rawTopic:  `home/earthquake/${b.node_id}`,
        rawVal:    b.raw_message,
        timestamp: b.timestamp
    }));

    const fullNodeHistory = [...quakeEvents, ...battEvents]
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    fullNodeHistory.forEach(item => {
        updateNodeUI(item.rawTopic, item.rawVal, item.timestamp);
    });

    scrollToBottom();

}).catch(err => {
    console.error("Failed to load initial data:", err);
    const errRow = createRow("ERROR", "API", "Failed to load history data");
    errRow.classList.add('system-row');
    logTbody.appendChild(errRow);
});
