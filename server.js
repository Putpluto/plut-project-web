// --- 1. LOAD SECRETS ---
require('dotenv').config();

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mqtt = require('mqtt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. DUAL DATABASE SETUP ---
const dbWeb_batt = new sqlite3.Database('./plutobattery.db');
const dbWeb = new sqlite3.Database('./pluto.db');
const dbArchive = new sqlite3.Database('./pluto_archive.db');

[dbWeb, dbArchive, dbWeb_batt].forEach(db => {
    db.run("PRAGMA journal_mode=WAL;");
    db.run("PRAGMA busy_timeout = 5000;"); 
});

// --- 3. TABLE INITIALIZATION ---
function initFsaeTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT, value TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
}
function initBatteryTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS battery_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, voltage TEXT, raw_message TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
}
function initEarthquakeTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS earthquake_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, magnitude TEXT, location TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
}

dbWeb.serialize(() => { initFsaeTable(dbWeb); initEarthquakeTable(dbWeb); });
dbArchive.serialize(() => { initFsaeTable(dbArchive); initEarthquakeTable(dbArchive); });
dbWeb_batt.serialize(() => { initBatteryTable(dbWeb_batt); });

// --- 4. PREPARED STATEMENTS ---
const insertFsaeWeb     = dbWeb.prepare("INSERT INTO messages (topic, value, timestamp) VALUES (?, ?, ?)");
const insertEqWeb       = dbWeb.prepare("INSERT INTO earthquake_logs (node_id, magnitude, timestamp) VALUES (?, ?, ?)");
const insertFsaeArchive = dbArchive.prepare("INSERT INTO messages (topic, value, timestamp) VALUES (?, ?, ?)");
const insertEqArchive   = dbArchive.prepare("INSERT INTO earthquake_logs (node_id, magnitude, timestamp) VALUES (?, ?, ?)");
const insertBatt        = dbWeb_batt.prepare("INSERT INTO battery_logs (node_id, voltage, raw_message, timestamp) VALUES (?, ?, ?, ?)");

// --- 5. MQTT SETUP ---
// brokerStatus   = is THIS SERVER connected to the MQTT broker?
// mainNodeStatus = is the ESP32 main node online? (tracked from LWT messages)
// These are kept in memory so any new browser tab that connects later
// gets the correct state immediately — not just tabs open at the moment of change.
let brokerStatus   = "Disconnected";
let mainNodeStatus = "OFFLINE"; // Assume offline until the broker delivers the retained "ONLINE"

const mqttClient = mqtt.connect('mqtt://127.0.0.1:1883', {
    reconnectPeriod: 1000,
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    clientId: 'pluto_server_' + Math.random().toString(16).substring(2, 8) 
});

mqttClient.on('connect', () => {
    console.log(`✅ MQTT Broker Connected`);
    mqttClient.subscribe(['fsae/#', 'home/earthquake/#']);
    brokerStatus = "ONLINE";
    io.emit('status_update', { status: "ONLINE" });
});

mqttClient.on('message', (topic, message) => {
    const value = message.toString();
    const now = new Date().toISOString();

    // --- LWT STATUS TRACKING ---
    // The ESP32 publishes "ONLINE" (retained) on connect, and the broker
    // auto-publishes "OFFLINE" (retained) if the ESP32 dies.
    // We cache this in mainNodeStatus so new browser connections get it immediately.
    if (topic === 'home/earthquake/status') {
        if (value === "ONLINE" || value === "OFFLINE") {
            mainNodeStatus = value;
            console.log(`📡 Main Node Status changed: ${value}`);
            // Also broadcast immediately to all currently connected browsers
            io.emit('main_node_status', { status: mainNodeStatus });
        }
    }

    // 1. EMIT TO FRONTEND — always emit with topic so frontend can filter correctly
    io.emit('mqtt_message', { topic, value, timestamp: now });

    // 2. Ignore pure heartbeats for DB saving
    if (value.toLowerCase().includes("main node:")) return; 

    // 3. ROUTING
    if (topic.startsWith('fsae/')) {
        insertFsaeWeb.run(topic, value, now);
        insertFsaeArchive.run(topic, value, now);
    } else if (topic.startsWith('home/earthquake/')) {
        const nodeName = topic.split('/').pop(); 
        
        // SAVE TO SEISMIC DB (LWT "OFFLINE" messages saved here as a record)
        insertEqWeb.run(nodeName, value, now);
        insertEqArchive.run(nodeName, value, now);

        // Save battery voltage — anchored regex, only matches clean "X.XXV" fields
        const voltageMatch = value.match(/(?:^|,)(\d+\.\d+)[Vv](?:,|$)/);
        const isStatusMsg  = value === "ONLINE" || value === "OFFLINE" || value.toLowerCase().includes("confirmed");
        
        if (voltageMatch && !isStatusMsg) {
            const voltage = voltageMatch[1];
            insertBatt.run(nodeName, voltage, value, now);
        }
    }
});

// --- 6. SOCKET.IO CONNECTION ---
// When a new browser tab opens, immediately send it both statuses.
// Without sending mainNodeStatus here, every page refresh would show
// "MAIN NODE OFFLINE" even if the ESP32 has been online for hours,
// because the retained MQTT message was already delivered to the server
// and won't be re-sent just because a new browser connected.
io.on('connection', (socket) => {
    socket.emit('status_update',    { status: brokerStatus });
    socket.emit('main_node_status', { status: mainNodeStatus });
});

// --- 7. API ENDPOINTS ---
app.get('/api/history', (req, res) => {
    dbWeb.all("SELECT * FROM messages ORDER BY id DESC LIMIT 500", (err, rows) => {
        if (err) res.status(500).json({ error: err.message }); else res.json(rows);
    });
});
app.get('/api/earthquake', (req, res) => {
    dbWeb.all("SELECT * FROM earthquake_logs ORDER BY id DESC LIMIT 100", (err, rows) => {
        if (err) res.status(500).json({ error: err.message }); else res.json(rows);
    });
});
app.get('/api/battery', (req, res) => {
    dbWeb_batt.all("SELECT * FROM battery_logs ORDER BY id DESC LIMIT 2500", (err, rows) => {
        if (err) res.status(500).json({ error: err.message }); else res.json(rows);
    });
});

app.delete('/api/history', (req, res) => {
    const clientKey = req.headers['x-admin-key'];
    if (!clientKey || clientKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: "Unauthorized" });
    
    dbWeb.serialize(() => {
        dbWeb.run("DELETE FROM messages");
        dbWeb.run("DELETE FROM earthquake_logs");
        dbWeb.run("DELETE FROM sqlite_sequence WHERE name IN ('messages', 'earthquake_logs')");
        dbWeb.run("VACUUM");
    });
    dbWeb_batt.serialize(() => {
        dbWeb_batt.run("DELETE FROM battery_logs");
        dbWeb_batt.run("DELETE FROM sqlite_sequence WHERE name='battery_logs'");
        dbWeb_batt.run("VACUUM", () => {
            io.emit('history_cleared');
            res.json({ message: "History cleared and IDs reset" });
        });
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`🚀 Control Panel Server: http://localhost:${PORT}`); });