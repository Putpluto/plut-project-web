// --- 1. LOAD SECRETS ---
require('dotenv').config();

const express  = require('express');
const app      = express();
const http     = require('http').createServer(app);
const io       = require('socket.io')(http);
const mqtt     = require('mqtt');
const sqlite3  = require('sqlite3').verbose();
const path     = require('path');
const cors     = require('cors');

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- 2. DATABASE SETUP ---
const dbWeb      = new sqlite3.Database('./pluto.db');
const dbArchive  = new sqlite3.Database('./pluto_archive.db');
const dbWeb_batt = new sqlite3.Database('./plutobattery.db');

[dbWeb, dbArchive, dbWeb_batt].forEach(db => {
    db.run("PRAGMA journal_mode=WAL;");
    db.run("PRAGMA busy_timeout = 5000;");
});

// --- 3. TABLE INITIALIZATION ---
// FIX: Tables are created first via serialize(). All subsequent db.run() calls are
// queued behind them, so there is no race condition between CREATE TABLE and INSERT.
// FIX: Removed unused `location` column from earthquake_logs to match actual inserts.

dbWeb.serialize(() => {
    dbWeb.run(`CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        topic     TEXT,
        value     TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    dbWeb.run(`CREATE TABLE IF NOT EXISTS earthquake_logs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id   TEXT,
        magnitude TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

dbArchive.serialize(() => {
    dbArchive.run(`CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        topic     TEXT,
        value     TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    dbArchive.run(`CREATE TABLE IF NOT EXISTS earthquake_logs (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id   TEXT,
        magnitude TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

dbWeb_batt.serialize(() => {
    dbWeb_batt.run(`CREATE TABLE IF NOT EXISTS battery_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id     TEXT,
        voltage     TEXT,
        raw_message TEXT,
        timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// --- 4. MQTT SETUP ---
// brokerStatus   = is THIS SERVER connected to the MQTT broker?
// mainNodeStatus = is the ESP32 main node online? (tracked via LWT messages)
// Both are cached in memory so new browser tabs get the correct state immediately.

let brokerStatus   = "Disconnected";
let mainNodeStatus = "OFFLINE";

const mqttClient = mqtt.connect('mqtt://127.0.0.1:1883', {
    reconnectPeriod: 1000,
    username:  process.env.MQTT_USER,
    password:  process.env.MQTT_PASS,
    clientId: 'pluto_server_' + Math.random().toString(16).substring(2, 8)
});

mqttClient.on('connect', () => {
    console.log('✅ MQTT Broker Connected');
    mqttClient.subscribe(['fsae/#', 'home/earthquake/#']);
    brokerStatus = "ONLINE";
    io.emit('status_update', { status: "ONLINE" });
});

mqttClient.on('error', (err) => {
    console.error('❌ MQTT Error:', err.message);
});

mqttClient.on('message', (topic, message) => {
    const value = message.toString();
    const now   = new Date().toISOString();

    // --- LWT STATUS TRACKING ---
    // The ESP32 publishes "ONLINE" (retained) on connect; the broker auto-publishes
    // "OFFLINE" (retained) if the ESP32 dies. Cache this so new browser tabs get it.
    if (topic === 'home/earthquake/status') {
        if (value === "ONLINE" || value === "OFFLINE") {
            mainNodeStatus = value;
            console.log(`📡 Main Node Status changed: ${value}`);
            io.emit('main_node_status', { status: mainNodeStatus });
        }
    }

    // Always forward to frontend (with topic so the client can filter)
    io.emit('mqtt_message', { topic, value, timestamp: now });

    // Skip pure heartbeats for DB writes
    if (value.toLowerCase().includes("main node:")) return;

    // --- ROUTING ---
    // FIX: Using inline parameterized db.run() instead of db.prepare() at module
    // level, which previously risked running before CREATE TABLE finished.
    if (topic.startsWith('fsae/')) {
        dbWeb.run(
            "INSERT INTO messages (topic, value, timestamp) VALUES (?, ?, ?)",
            [topic, value, now]
        );
        dbArchive.run(
            "INSERT INTO messages (topic, value, timestamp) VALUES (?, ?, ?)",
            [topic, value, now]
        );
    } else if (topic.startsWith('home/earthquake/')) {
        const nodeName = topic.split('/').pop();

        dbWeb.run(
            "INSERT INTO earthquake_logs (node_id, magnitude, timestamp) VALUES (?, ?, ?)",
            [nodeName, value, now]
        );
        dbArchive.run(
            "INSERT INTO earthquake_logs (node_id, magnitude, timestamp) VALUES (?, ?, ?)",
            [nodeName, value, now]
        );

        // FIX: Simplified voltage regex — matches any "X.XXV" token in the payload
        // without relying on exact surrounding delimiters.
        const voltageMatch = value.match(/\b(\d+\.\d+)\s*[Vv]\b/);
        const isStatusMsg  = value === "ONLINE" || value === "OFFLINE" ||
                             value.toLowerCase().includes("confirmed");

        if (voltageMatch && !isStatusMsg) {
            const voltage = voltageMatch[1];
            dbWeb_batt.run(
                "INSERT INTO battery_logs (node_id, voltage, raw_message, timestamp) VALUES (?, ?, ?, ?)",
                [nodeName, voltage, value, now]
            );
        }
    }
});

// --- 5. SOCKET.IO CONNECTION ---
// On every new browser connection, replay the last-known status for both indicators.
// Without this, a page refresh would show stale "OFFLINE" even if ESP32 has been
// online for hours, since the retained MQTT message won't be re-sent.
io.on('connection', (socket) => {
    socket.emit('status_update',    { status: brokerStatus });
    socket.emit('main_node_status', { status: mainNodeStatus });
});

// --- 6. API ENDPOINTS ---
app.get('/api/history', (req, res) => {
    dbWeb.all(
        "SELECT * FROM messages ORDER BY id DESC LIMIT 500",
        (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
    );
});

app.get('/api/earthquake', (req, res) => {
    dbWeb.all(
        "SELECT * FROM earthquake_logs ORDER BY id DESC LIMIT 100",
        (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
    );
});

app.get('/api/battery', (req, res) => {
    dbWeb_batt.all(
        "SELECT * FROM battery_logs ORDER BY id DESC LIMIT 2500",
        (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows)
    );
});

app.delete('/api/history', (req, res) => {
    const clientKey = req.headers['x-admin-key'];
    if (!clientKey || clientKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: "Unauthorized" });
    }

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

// --- 7. START ---
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Control Panel: http://localhost:${PORT}`);
});
