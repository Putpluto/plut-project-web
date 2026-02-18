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

// OPTIMIZATION: WAL Mode allows concurrent reads/writes without locking
[dbWeb, dbArchive, dbWeb_batt].forEach(db => {
    db.run("PRAGMA journal_mode=WAL;");
    db.run("PRAGMA busy_timeout = 5000;"); 
});

// --- 3. TABLE INITIALIZATION ---
function initFsaeTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT,
        value TEXT, 
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

function initBatteryTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS battery_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT,
        voltage TEXT,
        raw_message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

function initEarthquakeTable(db) {
    db.run(`CREATE TABLE IF NOT EXISTS earthquake_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT,
        magnitude TEXT, 
        location TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

dbWeb.serialize(() => { initFsaeTable(dbWeb); initEarthquakeTable(dbWeb); });
dbArchive.serialize(() => { initFsaeTable(dbArchive); initEarthquakeTable(dbArchive); });
dbWeb_batt.serialize(() => { initBatteryTable(dbWeb_batt); });

// --- 4. PREPARED STATEMENTS ---
const insertFsaeWeb = dbWeb.prepare("INSERT INTO messages (topic, value, timestamp) VALUES (?, ?, ?)");
const insertEqWeb = dbWeb.prepare("INSERT INTO earthquake_logs (node_id, magnitude, timestamp) VALUES (?, ?, ?)");
const insertFsaeArchive = dbArchive.prepare("INSERT INTO messages (topic, value, timestamp) VALUES (?, ?, ?)");
const insertEqArchive = dbArchive.prepare("INSERT INTO earthquake_logs (node_id, magnitude, timestamp) VALUES (?, ?, ?)");
const insertBatt = dbWeb_batt.prepare("INSERT INTO battery_logs (node_id, voltage, raw_message, timestamp) VALUES (?, ?, ?, ?)");

// --- 5. MQTT SETUP ---
let brokerStatus = "Disconnected";

const mqttClient = mqtt.connect('mqtt://127.0.0.1:1883', {
    reconnectPeriod: 1000,
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    clientId: 'pluto_server_' + Math.random().toString(16).substring(2, 8) 
});

mqttClient.on('connect', (connack) => {
    if (!connack.sessionPresent) {
        console.log(`✅ MQTT Broker Connected`);
        mqttClient.subscribe(['fsae/#', 'home/earthquake/#']);
    }
    brokerStatus = "ONLINE";
    io.emit('status_update', { status: "ONLINE" });
});

mqttClient.on('message', (topic, message) => {
    const value = message.toString();
    const now = new Date().toISOString();
    
    // 1. Always emit to frontend so it shows up in the Main Log Table
    io.emit('mqtt_message', { topic, value, timestamp: now });

    // 2. Ignore heartbeats for database saving
    if (value.toLowerCase().includes("main node:")) return; 

    if (topic.startsWith('home/earthquake/')) {
        const nodeName = topic.split('/').pop(); 
        
        // 3. Save to Earthquake Logs (Seismic Data) - "confirmed" stays here!
        insertEqWeb.run(nodeName, value, now);
        insertEqArchive.run(nodeName, value, now);

        // 4. Filter for Battery DB - "confirmed" is BLOCKED here
        const voltageMatch = value.match(/(\d+\.\d+)v/i);
        if (voltageMatch && !value.toLowerCase().includes("confirmed")) {
            const voltage = voltageMatch[1];
            insertBatt.run(nodeName, voltage, value, now);
        }
    }
});

// --- 6. API ENDPOINTS ---
app.get('/api/history', (req, res) => {
    dbWeb.all("SELECT * FROM messages ORDER BY id DESC LIMIT 500", (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows);    });
});

app.get('/api/earthquake', (req, res) => {
    dbWeb.all("SELECT * FROM earthquake_logs ORDER BY id DESC LIMIT 100", (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows);
    });
});

app.get('/api/battery', (req, res) => {
    dbWeb_batt.all("SELECT * FROM battery_logs ORDER BY id DESC LIMIT 2500", (err, rows) => {
        if (err) res.status(500).json({ error: err.message }); else res.json(rows);
    });
});

app.delete('/api/history', (req, res) => {
    const clientKey = req.headers['x-admin-key'];
    if (!clientKey || clientKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ error: "Unauthorized" });
    }
    
    const cleanWeb = new Promise((resolve, reject) => {
        dbWeb.serialize(() => {
            dbWeb.run("DELETE FROM messages");
            dbWeb.run("DELETE FROM earthquake_logs");
            dbWeb.run("VACUUM", (err) => err ? reject(err) : resolve());
        });
    });

    const cleanBatt = new Promise((resolve, reject) => {
        dbWeb_batt.serialize(() => {
            dbWeb_batt.run("DELETE FROM battery_logs");
            dbWeb_batt.run("VACUUM", (err) => err ? reject(err) : resolve());
        });
    });

    Promise.all([cleanWeb, cleanBatt])
        .then(() => {
            io.emit('history_cleared');
            res.json({ message: "All history deleted" });
        })
        .catch(err => res.status(500).json({ error: err.message }));
});

io.on('connection', (socket) => {
    socket.emit('status_update', { status: brokerStatus });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Control Panel Server: http://localhost:${PORT}`);
});