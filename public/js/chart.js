// Tracks which node's modal is open (read by addToNodeHistory in ui.js)
let currentChartNode = null;

// ─── Modal ────────────────────────────────────────────────────────────────────
function openNodeHistory(nodeId) {
    currentChartNode = nodeId;

    const modal = document.getElementById('history-modal');
    const title = document.getElementById('modal-title');
    const list  = document.getElementById('modal-log-list');

    title.innerText = nodeId.toUpperCase() + " HISTORY";
    list.innerHTML  = "";

    const logs = nodeHistoryLogs[nodeId] || [];
    if (logs.length === 0) {
        list.innerHTML = `<div class="history-item" style="justify-content:center; color:#8b949e;">
            No history available
        </div>`;
    } else {
        logs.forEach(log => {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <span class="history-time">${log.time}</span>
                <span class="history-msg">${log.msg}</span>
            `;
            list.appendChild(div);
        });
    }

    modal.style.display = "flex";
    // Small delay lets the browser paint the modal before measuring canvas size
    setTimeout(() => drawHistoryChart(nodeId), 50);
}

function closeModal(e) {
    // If called from the overlay's onclick, only close when clicking the backdrop
    if (e && e.target !== document.getElementById('history-modal')) return;
    document.getElementById('history-modal').style.display = "none";
    currentChartNode = null;
}

// ─── Voltage history chart ────────────────────────────────────────────────────
function drawHistoryChart(nodeId) {
    const canvas = document.getElementById('historyChart');
    const ctx    = canvas.getContext('2d');
    const logs   = nodeHistoryLogs[nodeId] || [];
    const rect   = canvas.parentNode.getBoundingClientRect();

    canvas.width  = rect.width;
    canvas.height = rect.height;
    const w = canvas.width;
    const h = canvas.height;

    const dataPoints = [...logs]
        .reverse()
        .filter(l => l.value !== null && !isNaN(l.value));

    ctx.clearRect(0, 0, w, h);

    const Y_MIN   = 3.0;
    const Y_MAX   = 5.0;
    const Y_RANGE = Y_MAX - Y_MIN;

    // Grid lines + labels
    ctx.lineWidth   = 1;
    ctx.strokeStyle = "#21262d";
    ctx.font        = "10px Consolas";
    ctx.fillStyle   = "#8b949e";
    ctx.textAlign   = "left";

    for (let val = Y_MIN; val <= Y_MAX; val += 0.5) {
        const yPos  = h - ((val - Y_MIN) / Y_RANGE * h);
        const drawY = Math.min(Math.max(yPos, 10), h - 5);
        ctx.beginPath();
        ctx.moveTo(0, drawY);
        ctx.lineTo(w, drawY);
        ctx.stroke();
        ctx.fillText(val.toFixed(1) + "V", 5, drawY - 2);
    }

    if (dataPoints.length === 0) {
        ctx.textAlign = "center";
        ctx.fillText("Waiting for data...", w / 2, h / 2);
        return;
    }

    // Voltage line
    ctx.beginPath();
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth   = 2;

    dataPoints.forEach((pt, i) => {
        const x  = dataPoints.length === 1 ? w / 2 : (i / (dataPoints.length - 1)) * w;
        const ny = Math.max(0, Math.min(1, (pt.value - Y_MIN) / Y_RANGE));
        const y  = h - ny * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Data-point dots
    ctx.fillStyle = "#fff";
    dataPoints.forEach((pt, i) => {
        const x  = dataPoints.length === 1 ? w / 2 : (i / (dataPoints.length - 1)) * w;
        const ny = Math.max(0, Math.min(1, (pt.value - Y_MIN) / Y_RANGE));
        const y  = h - ny * h;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    });

    // Latest value label
    const lastPt = dataPoints[dataPoints.length - 1];
    ctx.textAlign  = "right";
    ctx.fillStyle  = "#58a6ff";
    ctx.font       = "bold 12px Consolas";
    ctx.fillText(lastPt.value.toFixed(2) + "V", w - 10, 15);
}
