// ─── Shared state (consumed by chart.js and socket.js) ────────────────────────
const nodeLastSeen    = { node1: null, node2: null, node3: null };
const nodeHistoryLogs = { node1: [],   node2: [],   node3: []   };

// ─── Formatters ───────────────────────────────────────────────────────────────
function formatDateTime(isoString) {
    if (!isoString) return "Never";
    return new Date(isoString).toLocaleString('en-GB', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });
}

function formatTimeOnly(isoString) {
    if (!isoString) return "Never";
    return new Date(isoString).toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
}

// ─── Payload parser ────────────────────────────────────────────────────────────
function parsePayload(rawVal) {
    if (!rawVal) return { magnitude: '-', message: '' };
    const parts     = rawVal.split(',');
    const firstPart = parts[0].trim();
    const isNumeric = !isNaN(parseFloat(firstPart)) && isFinite(firstPart);

    if (parts.length > 1) {
        return {
            magnitude: isNumeric ? firstPart : '-',
            message:   isNumeric ? parts.slice(1).join(', ').trim() : rawVal
        };
    }
    return { magnitude: isNumeric ? rawVal : '-', message: isNumeric ? '' : rawVal };
}

// ─── Table row factory ─────────────────────────────────────────────────────────
function createRow(timeStr, magnitude, message) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td class="col-time">${timeStr}</td>
        <td class="col-mag">${magnitude}</td>
        <td class="col-msg">${message}</td>
    `;
    return tr;
}

function scrollToBottom() {
    const logListDiv = document.getElementById('log-list');
    logListDiv.scrollTop = logListDiv.scrollHeight;
}

// ─── Main-node status badge ────────────────────────────────────────────────────
function setMainNodeBadge(status) {
    const badge = document.getElementById('main-node-badge');
    if (status === "ONLINE") {
        badge.innerText  = "MAIN NODE ONLINE";
        badge.className  = "status-online";
    } else {
        badge.innerText  = "MAIN NODE OFFLINE";
        badge.className  = "status-offline";
    }
}

// ─── Battery bar ──────────────────────────────────────────────────────────────
function updateBatteryUI(card, voltage) {
    const battWrapper = card.querySelector('.batt-wrapper');
    const battFill    = card.querySelector('.batt-bar-fill');
    const battText    = card.querySelector('.batt-text');
    const valText     = card.querySelector('.node-val');

    if (!voltage) {
        battWrapper.style.opacity = "0.3";
        battFill.style.width      = "0%";
        battText.innerText        = "--%";
        return;
    }

    valText.innerText = voltage;

    const v   = parseFloat(voltage);
    let pct   = ((v - 3.0) / (4.2 - 3.0)) * 100;
    pct       = Math.max(0, Math.min(100, pct));

    battWrapper.style.opacity = "1";
    battText.innerText        = Math.round(pct) + "%";
    battFill.style.width      = pct + "%";

    if      (pct > 50) battFill.style.backgroundColor = "var(--batt-high)";
    else if (pct > 20) battFill.style.backgroundColor = "var(--batt-med)";
    else               battFill.style.backgroundColor = "var(--batt-low)";
}

// ─── Node history log ──────────────────────────────────────────────────────────
function addToNodeHistory(nodeId, timestamp, msg, value) {
    if (!nodeHistoryLogs[nodeId]) return;
    nodeHistoryLogs[nodeId].unshift({
        time:  formatDateTime(timestamp),
        msg,
        value
    });
    if (nodeHistoryLogs[nodeId].length > 100) nodeHistoryLogs[nodeId].pop();

    // Refresh chart if this node's modal is currently open
    if (typeof currentChartNode !== 'undefined' && currentChartNode === nodeId) {
        drawHistoryChart(nodeId);
    }
}

// ─── Node card updater ─────────────────────────────────────────────────────────
// FIX: Voltage is now parsed from whichever comma-separated part matches the
// pattern X.XXV, rather than blindly taking parts[index+1]. This makes the
// function resilient to payload field reordering.
function updateNodeUI(topic, rawValue, timestamp) {
    if (!topic.includes('earthquake/main_node')) return;
    if (!rawValue) return;

    // Skip status-only messages — those are handled by the LWT badge separately
    const lv = rawValue.toLowerCase();
    if (lv === "online" || lv === "offline" || lv.includes("confirmed")) return;

    const parts        = rawValue.split(',');
    const isoTimestamp = (timestamp instanceof Date)
        ? timestamp.toISOString()
        : timestamp;

    parts.forEach(part => {
        const match = part.match(/node\s*(\d+)\s*:\s*(alive|false)/i);
        if (!match) return;

        const nodeId = `node${match[1]}`;
        const status = match[2].toLowerCase();
        const card   = document.getElementById(`card-${nodeId}`);
        if (!card) return;

        const badge    = card.querySelector('.node-badge');
        const timeText = card.querySelector('.node-time');

        nodeLastSeen[nodeId]  = new Date(isoTimestamp).getTime();
        badge.innerText       = "ONLINE";
        badge.className       = "node-badge badge-online";
        timeText.innerText    = formatTimeOnly(isoTimestamp);

        // FIX: Find voltage by matching the X.XXV pattern anywhere in parts
        let voltageStr  = null;
        let graphValue  = null;

        for (const p of parts) {
            const vMatch = p.trim().match(/^(\d+\.\d+)\s*[Vv]$/i);
            if (vMatch) { voltageStr = vMatch[1]; break; }
        }

        if (voltageStr) {
            updateBatteryUI(card, voltageStr);
            graphValue = parseFloat(voltageStr);
        }

        const extraInfo = voltageStr ? ` | Batt: ${voltageStr}V` : '';
        addToNodeHistory(nodeId, isoTimestamp, `Status: ${status}${extraInfo}`, graphValue);
    });
}

// ─── Offline timeout watchdog ──────────────────────────────────────────────────
// Only flips individual node cards offline — the main-node badge is driven
// purely by LWT events and must NOT be touched here.
setInterval(() => {
    const now              = Date.now();
    const TIMEOUT_MS       = 90 * 60 * 1000; // 90 minutes

    Object.keys(nodeLastSeen).forEach(nodeId => {
        if (nodeLastSeen[nodeId] && (now - nodeLastSeen[nodeId] > TIMEOUT_MS)) {
            const card = document.getElementById(`card-${nodeId}`);
            if (!card) return;
            const badge = card.querySelector('.node-badge');
            badge.innerText     = "OFFLINE";
            badge.className     = "node-badge badge-offline";
            nodeLastSeen[nodeId] = null;
            updateBatteryUI(card, null);
        }
    });
}, 1000);
