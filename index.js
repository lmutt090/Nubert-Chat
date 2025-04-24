const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const readline = require('readline');
const express = require('express');
const app = express();

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const clients = new Map(); // username => ws

const dbPath = path.join(__dirname, 'NubNub.db');
const isFirstRun = !fs.existsSync(dbPath);
let whitelistEnabled = true;
let localTunnelEnabled = process.env.LOCALTUNNEL === 'false'; // Enable LocalTunnel if the environment variable is set

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
            is_whitelisted INTEGER DEFAULT 0,
            is_user_able_to_access_profile_settings INTEGER DEFAULT 0,
            is_user_able_to_access_profiles INTEGER DEFAULT 0,
            is_user_able_to_access_groups INTEGER DEFAULT 0,
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

const groupsFolder = path.join(__dirname, 'groups');
if (!fs.existsSync(groupsFolder)) fs.mkdirSync(groupsFolder);

const groupDataPath = path.join(groupsFolder, 'groupdata.db'); // Updated to store groupdata.db in the groups folder
const groupDataDb = new sqlite3.Database(groupDataPath, (err) => {
    if (err) {
        console.error('Could not connect to groupdata database', err);
    } else {
        console.log('Connected to groupdata database');
        groupDataDb.run(`CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT,
            description TEXT,
            join_paused INTEGER DEFAULT 0
        )`);
    }
});

function getGroupDb(groupId) {
    const groupDbPath = path.join(groupsFolder, `${groupId}.db`);
    const groupDb = new sqlite3.Database(groupDbPath, (err) => {
        if (err) {
            console.error(`Could not connect to group database for group ${groupId}`, err);
        } else {
            groupDb.run(`CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender TEXT,
                message TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            groupDb.run(`CREATE TABLE IF NOT EXISTS members (
                username TEXT PRIMARY KEY,
                is_moderator INTEGER DEFAULT 0
            )`);
        }
    });
    return groupDb;
}

// Add support for listing DM history
function getDMHistory(username, callback) {
    db.all(`SELECT DISTINCT sender, receiver FROM messages WHERE sender = ? OR receiver = ?`, [username, username], (err, rows) => {
        if (err) {
            console.error('Error fetching DM history:', err);
            callback([]);
        } else {
            const users = new Set();
            rows.forEach(row => {
                if (row.sender !== username) users.add(row.sender);
                if (row.receiver !== username) users.add(row.receiver);
            });
            callback(Array.from(users));
        }
    });
}

// Add support for listing group memberships
function getUserGroups(username, callback) {
    groupDataDb.all(`SELECT id, name FROM groups WHERE id IN (SELECT DISTINCT group_id FROM members WHERE username = ?)`, [username], (err, rows) => {
        if (err) {
            console.error('Error fetching user groups:', err);
            callback([]);
        } else {
            callback(rows);
        }
    });
}

wss.on('connection', (ws) => {
    let user = null;
    let isAdmin = false;
    let isOwner = false;
    let isMuted = false;

    ws.on('message', (message) => {
        let data = JSON.parse(message);

        if (data.type === 'get-dm-history') {
            if (user) {
                getDMHistory(user, (users) => {
                    ws.send(JSON.stringify({ type: 'dm-history', users }));
                });
            }
        }

        else if (data.type === 'get-user-groups') {
            if (user) {
                getUserGroups(user, (groups) => {
                    ws.send(JSON.stringify({ type: 'user-groups', groups }));
                });
            }
        }

        else if (data.type === 'register') {
            const { username, password } = data;
            bcrypt.hash(password, 10, (err, hash) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Error hashing password' }));
                } else {
                    db.run(`INSERT INTO users (username, password, is_whitelisted) VALUES (?, ?, 1)`, [username, hash], function(err) {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Username (possibly) already taken' }));
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

            if (data.message.startsWith('/')) {
                handleCommand(data.message, user, ws);
            } else {
                db.run(`INSERT INTO messages (type, sender, message) VALUES (?, ?, ?)`, ['chat', user, data.message]);
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'chat', username: user, message: data.message }));
                    }
                });
            }
        }

        else if (data.type === 'dm') {
            const target = clients.get(data.to);
            db.run(`INSERT INTO messages (type, sender, receiver, message) VALUES (?, ?, ?, ?)`, ['dm', user, data.to, data.message]);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'dm', from: user, message: data.message }));
            }
        }

        else if (data.type === 'fetch-dm-messages') {
            const { targetUser } = data;
            if (user) {
                db.all(
                    `SELECT sender, receiver, message, timestamp FROM messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?) ORDER BY timestamp ASC`,
                    [user, targetUser, targetUser, user],
                    (err, rows) => {
                        if (err) {
                            console.error('Error fetching DM messages:', err);
                            ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch messages.' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'dm-messages', targetUser, messages: rows }));
                        }
                    }
                );
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

        else if (data.type === 'create-group' && isOwner) {
            const { groupId, name, description } = data;
            groupDataDb.run(`INSERT INTO groups (id, name, description) VALUES (?, ?, ?)`, [groupId, name, description], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Group creation failed.' }));
                } else {
                    getGroupDb(groupId); // Initialize the group database
                    ws.send(JSON.stringify({ type: 'group-created', groupId }));
                }
            });
        }

        else if (data.type === 'send-group-message') {
            const { groupId, message } = data;
            const groupDb = getGroupDb(groupId);
            groupDb.run(`INSERT INTO messages (sender, message) VALUES (?, ?)`, [user, message]);
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'group-message', groupId, sender: user, message }));
                }
            });
        }

        else if (data.type === 'toggle-join-pause' && isOwner) {
            const { groupId, pause } = data;
            groupDataDb.run(`UPDATE groups SET join_paused = ? WHERE id = ?`, [pause ? 1 : 0, groupId], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to toggle join pause.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'join-pause-toggled', groupId, paused: pause }));
                }
            });
        }

        else if (data.type === 'add-moderator' && isOwner) {
            const { groupId, target } = data;
            const groupDb = getGroupDb(groupId);
            groupDb.run(`UPDATE members SET is_moderator = 1 WHERE username = ?`, [target], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to add moderator.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'moderator-added', groupId, target }));
                }
            });
        }

        else if (data.type === 'kick-from-group' && isOwner) {
            const { groupId, target } = data;
            const groupDb = getGroupDb(groupId);
            groupDb.run(`DELETE FROM members WHERE username = ?`, [target], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to kick user.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'user-kicked', groupId, target }));
                }
            });
        }

        else if (data.type === 'ban-from-group' && isOwner) {
            const { groupId, target } = data;
            const groupDb = getGroupDb(groupId);
            groupDb.run(`INSERT OR REPLACE INTO members (username, is_moderator) VALUES (?, 0)`, [target], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to ban user.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'user-banned', groupId, target }));
                }
            });
        }

        else if (data.type === 'mute-in-group' && isOwner) {
            const { groupId, target } = data;
            const groupDb = getGroupDb(groupId);
            groupDb.run(`INSERT OR REPLACE INTO members (username, is_moderator) VALUES (?, 0)`, [target], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to mute user.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'user-muted', groupId, target }));
                }
            });
        }

        else if (data.type === 'block') {
            const { targetUser } = data;
            if (user && targetUser) {
                db.run(`INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)`, [user, targetUser], (err) => {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to block user.' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'success', message: `${targetUser} has been blocked.` }));
                    }
                });
            }
        }

        else if (data.type === 'unblock') {
            const { targetUser } = data;
            if (user && targetUser) {
                db.run(`DELETE FROM blocks WHERE blocker = ? AND blocked = ?`, [user, targetUser], (err) => {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to unblock user.' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'success', message: `${targetUser} has been unblocked.` }));
                    }
                });
            }
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

// Serve static files from the current directory
app.use(express.static(__dirname));

// Use the Express app to handle HTTP requests
server.on('request', app);

server.listen(3000, () => console.log('Server running on port 3000'));

if (localTunnelEnabled) {
    const localtunnel = require('localtunnel');

    (async () => {
        const tunnel = await localtunnel({ port: 3000 });

        console.log(`Server is publicly accessible at ${tunnel.url}`);

        // Update the environment variable with the tunnel URL
        process.env.LOCALTUNNEL_URL = tunnel.url;

        tunnel.on('close', () => {
            console.log('Tunnel closed');
        });
    })();
}

function handleCommand(command, user, ws) {
    const [cmd, ...args] = command.slice(1).split(' ');

    switch (cmd.toLowerCase()) {
        case 'help':
            ws.send(JSON.stringify({ type: 'chat', username: 'System', message: 'Available commands: /help, /whisper <user> <message>, /me <action>, /block <user>, /unblock, <user>' }));
            break;
        case 'whisper':
            const targetUser = args.shift();
            const privateMessage = args.join(' ');
            const targetWs = clients.get(targetUser);

            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(JSON.stringify({ type: 'chat', username: `(whisper) ${user}`, message: privateMessage }));
                ws.send(JSON.stringify({ type: 'chat', username: `(whisper to ${targetUser})`, message: privateMessage }));
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'User not found or offline.' }));
            }
            break;
        case 'me':
            const actionMessage = args.join(' ');
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'chat', username: 'Action', message: `${user} ${actionMessage}` }));
                }
            });
            break;
        case 'block':
            const blockTarget = args[0];
            if (!blockTarget) {
                ws.send(JSON.stringify({ type: 'error', message: 'Please specify a user to block.' }));
                return;
            }
            db.run(`INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)`, [user, blockTarget], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to block user.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `You have blocked ${blockTarget}.` }));
                }
            });
            break;
        case 'unblock':
            const unblockTarget = args[0];
            if (!unblockTarget) {
                ws.send(JSON.stringify({ type: 'error', message: 'Please specify a user to unblock.' }));
                return;
            }
            db.run(`DELETE FROM blocks WHERE blocker = ? AND blocked = ?`, [user, unblockTarget], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to unblock user.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `You have unblocked ${unblockTarget}.` }));
                }
            });
            case 'profile-access':
                const setting = args[1];
                const toggle = args[2] === 'on' ? 1 : 0;

                if (!targetUser || !setting || (toggle !== 1 && toggle !== 0)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Usage: /profile-access <user> <setting> <on|off>' }));
                    return;
                }

                const column = setting === 'view' ? 'is_user_able_to_access_profiles' : setting === 'edit' ? 'is_user_able_to_access_profile_settings' : null;

                if (!column) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid setting. Use "view" or "edit".' }));
                    return;
                }

                db.run(`UPDATE users SET ${column} = ? WHERE username = ?`, [toggle, targetUser], (err) => {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to update profile access.' }));
                    } else {
                        ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `Profile access for ${targetUser} (${setting}) set to ${toggle ? 'on' : 'off'}.` }));
                    }
                });
            break;
        default:
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown command. Type /help for a list of commands.' }));
    }
}
