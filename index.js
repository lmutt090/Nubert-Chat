const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const readline = require('readline');
const express = require('express');
const app = express();
const fetch = require('node-fetch'); // Make sure to install node-fetch if not already
const crypto = require('crypto'); // Add this at the top of the file

const webhookURL = 'https://your.webhook.url/here'; // Replace with your webhook URL

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const clients = new Map(); // username => ws

const dbPath = path.join(__dirname, 'NubNub.db');
const isFirstRun = !fs.existsSync(dbPath);
let whitelistEnabled = true;
let localTunnelEnabled = 'true'; // Enable LocalTunnel if the environment variable is set

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
        // Update the users table to remove AUTOINCREMENT from the id column
        const updateUsersTableQuery = `
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                bio TEXT DEFAULT '',
                avatar_url TEXT DEFAULT 'images/stock/OIP (3).jpeg',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                password TEXT,
                is_admin INTEGER DEFAULT 0,
                is_owner INTEGER DEFAULT 0,
                is_banned INTEGER DEFAULT 0,
                is_muted INTEGER DEFAULT 0,
                is_whitelisted INTEGER DEFAULT 0,
                is_user_bannable INTEGER DEFAULT 1
            )
        `;

        db.serialize(() => {
            db.exec(updateUsersTableQuery, (err) => {
                if (err) {
                    console.error('Error updating users table schema:', err);
                } else {
                    console.log('Users table schema updated successfully.');
                }
            });
        });

        if (isFirstRun) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question('Set owner username: ', username => {
                rl.question('Set owner password: ', password => {
                    // Replace the random ID generation logic with hashing
                    bcrypt.hash(password, 10, (err, hash) => {
                        if (!err) {
                            db.run(`INSERT INTO users (username, password, is_admin, is_owner, is_whitelisted) VALUES (?, ?, 1, 1, 1)`, [username, hash], () => {
                                console.log('Owner account created with username:', username);
                                db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, row) => {
                                    if (err) {
                                        console.error('Error fetching owner ID:', err);
                                        rl.close();
                                        return;
                                    }
                                    const Id = row.id; // Use the fetched ID
                                    console.log('Owner account created with ID:', Id);
                                    rl.close();
                                },);
                                rl.close();
                            });
                        }
                    });
                });
            });
        }
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

            if (!username || !password) {
                return ws.send(JSON.stringify({ type: 'error', message: 'Username and password are required' }));
            }

            // Replace the random ID generation logic with hashing

            bcrypt.hash(password, 10, (err, hash) => {
                if (err) {
                    console.error('Error hashing password:', err);
                    return ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
                }

                db.run(`INSERT INTO users (id, username, password, is_whitelisted) VALUES (?, ?, ?, 1)`, [randomId, username, hash], function(err) {
                    if (err) {
                        console.error('Error inserting user:', err);
                        return ws.send(JSON.stringify({ type: 'error', message: 'Username may already be taken' }));
                    }
                    db.get(`SELECT id FROM users WHERE username = ?`, [username], (err, row) => {
                        if (err) {
                            console.error('Error fetching user ID:', err);
                            rl.close();
                            return;
                        }
                        const Id = row.id; // Use the fetched ID
                        console.log('User account created with ID:', Id);
                        rl.close();
                    },);
                    ws.send(JSON.stringify({ message: 'User registered successfully', id: Id })); // Send response to WebSocket client
                });
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
                            id = row.id
                            ws.send(JSON.stringify({ type: 'login-success', id, isAdmin, isOwner }));
                            broadcastUserList();
                        } else {
                            ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
                        }
                    });
                }
            });
        }

        else if (data.type === 'auto-login') {
            const token = data.token;

            db.get(`SELECT * FROM users WHERE id = ?`, [username], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token or user not found.' }));
                } else if (row.is_banned) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are banned.' }));
                } else if (whitelistEnabled && row.is_whitelisted !== 1) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are not whitelisted.' }));
                } else {
                    user = username;
                    isAdmin = row.is_admin === 1;
                    isOwner = row.is_owner === 1;
                    isMuted = row.is_muted === 1;
                    clients.set(user, ws);
                    ws.send(JSON.stringify({ type: 'login-success', id: token, isAdmin, isOwner }));
                    broadcastUserList();
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
        
                // Broadcast to WebSocket clients
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'chat', username: user, message: data.message }));
                    }
                });
        
                // Send to webhook
                if (webhookURL.includes('discord.com/api/webhooks')) {
                    // Discord webhook with embed
                    fetch(webhookURL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            embeds: [{
                                title: 'New Chat Message',
                                fields: [
                                    { name: 'User', value: user, inline: true },
                                    { name: 'Message', value: data.message, inline: false }
                                ],
                                timestamp: new Date().toISOString()
                            }]
                        })
                    }).catch(err => console.error('Error sending to Discord webhook:', err));
                } else {
                    // Generic webhook
                    fetch(webhookURL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: 'chat',
                            user: user,
                            message: data.message,
                            timestamp: new Date().toISOString()
                        })
                    }).catch(err => console.error('Error sending to webhook:', err));
                }
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

        // Handle profile-related WebSocket messages
        if (data.type === 'get-profile') {
            db.get(`SELECT username, bio, avatar_url FROM users WHERE username = ?`, [user], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch profile.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile-data', profile: row }));
                }
            });
        } else if (data.type === 'update-profile') {
            const { bio, avatar_url } = data;
            db.run(`UPDATE users SET bio = ?, avatar_url = ? WHERE username = ?`, [bio, avatar_url, user], (err) => {
                if (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to update profile.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'success', message: 'Profile updated successfully.' }));
                }
            });
        }
    }); // Fixed closing braces and parentheses

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

// Use the Express app to handle HTTP requests
server.on('request', app);

// Update the endpoint to fetch profile by ID and serve an HTML page
app.get('/users', (req, res) => {
    const profileId = req.query.profile;

    if (!profileId) {
        return res.status(400).send('<h1>Error: Profile ID is required</h1>');
    }

    db.get(`SELECT username, bio, avatar_url FROM users WHERE id = ?`, [profileId], (err, row) => {
        if (err) {
            console.error('Error fetching profile:', err);
            return res.status(500).send('<h1>Internal Server Error</h1>');
        }

        if (!row) {
            console.log(`No profile found for ID: ${profileId}`);
            return res.status(404).send('<h1>Profile Not Found</h1>');
        }

        // Render the profile page directly
        res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${row.username}'s Profile</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        margin: 0;
                        padding: 0;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        background-color: #f4f4f4;
                    }
                    .profile-container {
                        background: white;
                        padding: 20px;
                        border-radius: 8px;
                        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                        text-align: center;
                        width: 300px;
                    }
                    .profile-container img {
                        border-radius: 50%;
                        width: 100px;
                        height: 100px;
                        object-fit: cover;
                    }
                    .profile-container h1 {
                        font-size: 24px;
                        margin: 10px 0;
                    }
                    .profile-container p {
                        color: #666;
                    }
                </style>
            </head>
            <body>
                <div class="profile-container">
                    <img src="${row.avatar_url || 'default-avatar.png'}" alt="User Avatar">
                    <h1>${row.username}</h1>
                    <p>${row.bio || 'No bio available.'}</p>
                </div>
            </body>
            </html>
        `);
    });
});

// Serve static files from the current directory
app.use(express.static(__dirname));

server.listen(3000, () => console.log('Server running on port 3000'));

if (localTunnelEnabled) {
    const localtunnel = require('localtunnel');

    (async () => {
        const tunnel = await localtunnel({ port: 3000, subdomain: 'nubnub' });

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
            break;
        case 'profile-access':
            db.get(`SELECT is_user_able_to_access_profiles FROM users WHERE username = ?`, [user], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch profile access status.' }));
                } else {
                    const newValue = row.is_user_able_to_access_profiles === 1 ? 0 : 1;
                    db.run(`UPDATE users SET is_user_able_to_access_profiles = ? WHERE username = ?`, [newValue, user], (err) => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', message: 'Failed to update profile access.' }));
                        } else {
                            ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `Your profile access is now set to ${newValue ? 'on' : 'off'}.` }));
                        }
                    });
                }
            });
            break;
        default:
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown command. Type /help for a list of commands.' }));
    }
}
