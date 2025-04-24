const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const readline = require('readline');

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const clients = new Map(); // username => ws

const dbPath = path.join(__dirname, 'NubNub.db');
const isFirstRun = !fs.existsSync(dbPath);
let whitelistEnabled = true;

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Could not connect to database', err);
    } else {
        console.log('Connected to NubNub database');
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            sender TEXT,
            receiver TEXT,
            message TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            is_admin INTEGER DEFAULT 0,
            is_owner INTEGER DEFAULT 0,
            is_banned INTEGER DEFAULT 0,
            is_muted INTEGER DEFAULT 0,
            is_whitelisted INTEGER DEFAULT 0
        )`, () => {
            if (isFirstRun) {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl.question('Set owner username: ', username => {
                    rl.question('Set owner password: ', password => {
                        bcrypt.hash(password, 10, (err, hash) => {
                            if (!err) {
                                db.run(`INSERT INTO users (username, password, is_admin, is_owner, is_whitelisted) VALUES (?, ?, 1, 1, 1)`, [username, hash], () => {
                                    console.log('Owner account created.');
                                    rl.close();
                                });
                            }
                        });
                    });
                });
            }
        });
    }
});

function usernameToNumbers(username) {
    return username.split('').map(char => char.charCodeAt(0)).join('');
}

wss.on('connection', (ws) => {
    let user = null;
    let isAdmin = false;
    let isOwner = false;
    let isMuted = false;

    ws.on('message', (message) => {
        let data = JSON.parse(message);

        if (data.type === 'register') {
            const { username, password } = data;
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Error hashing password' }));
                } else {
                    db.run(`INSERT INTO users (username, password, is_whitelisted) VALUES (?, ?, 1)`, [username, hash], function(err) {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Username already taken' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'register-success', username }));
                        }
                    });
                }
            });
        }

        else if (data.type === 'login') {
            const { username, password } = data;
            db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
                } else if (row.is_banned) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are banned.' }));
                } else if (whitelistEnabled && row.is_whitelisted !== 1) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are not whitelisted.' }));
                } else {
                    bcrypt.compare(password, row.password, (err, result) => {
                        if (result) {
                            user = username;
                            isAdmin = row.is_admin === 1;
                            isOwner = row.is_owner === 1;
                            isMuted = row.is_muted === 1;
                            clients.set(user, ws);
                            const id = `Nubert-${usernameToNumbers(user)}-nuberT`;
                            ws.send(JSON.stringify({ type: 'login-success', id, isAdmin, isOwner }));
                            broadcastUserList();
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
                        }
                    });
                }
            });
        }

        else if (data.type === 'toggle-whitelist' && isOwner) {
            whitelistEnabled = !whitelistEnabled;
            ws.send(JSON.stringify({ type: 'admin-update', message: `Whitelist is now ${whitelistEnabled ? 'enabled' : 'disabled'}.` }));
        }

        else if (data.type === 'chat') {
            if (isMuted) {
                ws.send(JSON.stringify({ type: 'error', message: 'You are muted and cannot chat.' }));
                return;
            }
            db.run(`INSERT INTO messages (type, sender, message) VALUES (?, ?, ?)`, ['chat', user, data.message]);
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'chat', username: user, message: data.message }));
                }
            });
        }

        else if (data.type === 'dm') {
            const target = clients.get(data.to);
            db.run(`INSERT INTO messages (type, sender, receiver, message) VALUES (?, ?, ?, ?)`, ['dm', user, data.to, data.message]);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'dm', from: user, message: data.message }));
            }
        }

        else if (data.type === 'kick' && (isAdmin || isOwner)) {
            const target = clients.get(data.target);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'kicked', message: 'You have been kicked by a moderator.' }));
                target.close();
            }
        }

        else if (data.type === 'ban' && (isAdmin || isOwner)) {
            db.run(`UPDATE users SET is_banned = 1 WHERE username = ?`, [data.target]);
            const target = clients.get(data.target);
            if (target) target.close();
        }

        else if (data.type === 'unban' && (isAdmin || isOwner)) {
            db.run(`UPDATE users SET is_banned = 0 WHERE username = ?`, [data.target]);
        }

        else if (data.type === 'mute' && (isAdmin || isOwner)) {
            db.run(`UPDATE users SET is_muted = 1 WHERE username = ?`, [data.target]);
        }

        else if (data.type === 'unmute' && (isAdmin || isOwner)) {
            db.run(`UPDATE users SET is_muted = 0 WHERE username = ?`, [data.target]);
        }

        else if (data.type === 'set-admin' && isOwner) {
            db.get(`SELECT * FROM users WHERE username = ?`, [data.target], (err, row) => {
                if (err || !row || row.is_owner === 1) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Cannot promote this user.' }));
                } else {
                    db.run(`UPDATE users SET is_admin = 1 WHERE username = ?`, [data.target], function(err) {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Could not promote user.' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'admin-update', message: `${data.target} is now an admin.` }));
                        }
                    });
                }
            });
        }

        else if (data.type === 'remove-admin' && isOwner) {
            db.get(`SELECT * FROM users WHERE username = ?`, [data.target], (err, row) => {
                if (err || !row || row.is_owner === 1) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Cannot demote this user.' }));
                } else {
                    db.run(`UPDATE users SET is_admin = 0 WHERE username = ?`, [data.target], function(err) {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Could not demote user.' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'admin-update', message: `${data.target} is no longer an admin.` }));
                        }
                    });
                }
            });
        }
    });

    ws.on('close', () => {
        clients.delete(user);
        broadcastUserList();
    });
});

function broadcastUserList() {
    const userList = Array.from(clients.keys());
    const msg = JSON.stringify({ type: 'userlist', users: userList });
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

server.listen(3000, () => console.log('Server running on port 3000'));
