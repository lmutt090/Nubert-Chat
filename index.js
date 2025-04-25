const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const fs = require('fs');
const readline = require('readline');
const express = require('express');
const app = express();
const fetch = require('node-fetch'); // Import node-fetch for HTTP requests
const crypto = require('crypto'); // Add this at the top of the file
const url = 'http://localhost:3000'; // Fallback to localhost with default port

const webhookURL = 'https://your.webhook.url/here'; // Replace with your webhook URL

const server = http.createServer();
const wss = new WebSocket.Server({ server });
const clients = new Map(); // username => ws

const dbPath = path.join(__dirname, 'NubNub.db');
const isFirstRun = !fs.existsSync(dbPath);
let whitelistEnabled = true;
let localTunnelEnabled = false; // Enable LocalTunnel if the environment variable is set

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
                                });
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
            join_paused INTEGER DEFAULT 0,
            invite_token TEXT UNIQUE
        )`);
        groupDataDb.run(`CREATE TABLE IF NOT EXISTS members (
            username TEXT,
            group_id TEXT,
            is_moderator INTEGER DEFAULT 0,
            PRIMARY KEY (username, group_id)
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
                    // Send only group id and name for listing
                    const groupList = groups.map(g => ({ id: g.id, name: g.name }));
                    ws.send(JSON.stringify({ type: 'user-groups', groups: groupList }));
                });
            }
        }

        else if (data.type === 'create-group') {
            if (!user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
            }
            const groupName = data.name;
            if (!groupName) {
                ws.send(JSON.stringify({ type: 'error', message: 'Group name is required' }));
                return;
            }
            // Generate a unique group ID (e.g., UUID or hash)
            const groupId = crypto.randomBytes(8).toString('hex');

        // Generate a unique invite token
        const inviteToken = crypto.randomBytes(6).toString('hex');

        // Insert group into groups table with invite token
        groupDataDb.run(`INSERT INTO groups (id, name, invite_token) VALUES (?, ?, ?)`, [groupId, groupName, inviteToken], function(err) {
            if (err) {
                console.error('Error creating group:', err);
                ws.send(JSON.stringify({ type: 'error', message: 'Failed to create group' }));
                return;
            }
            // Add creator as member and owner (owner status can be managed in members table or separate)
            groupDataDb.run(`INSERT INTO members (username, group_id, is_moderator) VALUES (?, ?, 1)`, [user, groupId], function(err) {
                if (err) {
                    console.error('Error adding creator to group members:', err);
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to add creator to group' }));
                    return;
                }
                ws.send(JSON.stringify({ type: 'group-created', group: { id: groupId, name: groupName, inviteToken } }));
            });
        });
        }

        else if (data.type === 'get-group-messages') {
            if (!user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
            }
            const groupId = data.groupId;
            if (!groupId) {
                ws.send(JSON.stringify({ type: 'error', message: 'Group ID is required' }));
                return;
            }
            // Check if user is member of the group
            groupDataDb.get(`SELECT * FROM members WHERE username = ? AND group_id = ?`, [user, groupId], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Access denied or not a member of the group' }));
                    return;
                }
                // Open group DB and fetch messages
                const groupDb = getGroupDb(groupId);
                groupDb.all(`SELECT sender, message, timestamp FROM messages ORDER BY timestamp ASC LIMIT 100`, [], (err, rows) => {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch group messages' }));
                        return;
                    }
                    ws.send(JSON.stringify({ type: 'group-messages', groupId, messages: rows }));
                });
            });
        }

        else if (data.type === 'send-group-message') {
            if (!user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
            }
            const groupId = data.groupId;
            const messageText = data.message;
            if (!groupId || !messageText) {
                ws.send(JSON.stringify({ type: 'error', message: 'Group ID and message are required' }));
                return;
            }
            // Check if user is member of the group
            groupDataDb.get(`SELECT * FROM members WHERE username = ? AND group_id = ?`, [user, groupId], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Access denied or not a member of the group' }));
                    return;
                }
                // Insert message into group DB
                const groupDb = getGroupDb(groupId);
                groupDb.run(`INSERT INTO messages (sender, message) VALUES (?, ?)`, [user, messageText], function(err) {
                    if (err) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Failed to send group message' }));
                        return;
                    }
                    // Broadcast message to all group members who are connected
                    groupDataDb.all(`SELECT username FROM members WHERE group_id = ?`, [groupId], (err, members) => {
                        if (err) {
                            console.error('Error fetching group members:', err);
                            return;
                        }
                        members.forEach(member => {
                            const memberWs = clients.get(member.username);
                            if (memberWs && memberWs.readyState === WebSocket.OPEN) {
                                memberWs.send(JSON.stringify({ type: 'group-message', groupId, sender: user, message: messageText }));
                            }
                        });
                    });
                });
            });
        }

        else if (data.type === 'register') {
            const { username, password } = data;

            if (!username || !password) {
                return ws.send(JSON.stringify({ type: 'error', message: 'Username and password are required' }));
            }

            bcrypt.hash(password, 10, (err, hash) => {
                if (err) {
                    console.error('Error hashing password:', err);
                    return ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
                }

                db.run(`INSERT INTO users (username, password, is_whitelisted) VALUES (?, ?, 1)`, [username, hash], function(err) {
                    if (err) {
                        console.error('Error inserting user:', err);
                        return ws.send(JSON.stringify({ type: 'error', message: 'Username may already be taken' }));
                    }
                    const Id = this.lastID; // Use the last inserted ID
                    console.log('User account created with ID:', Id);
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
                            id = row.id;
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

            db.get(`SELECT * FROM users WHERE id = ?`, [token], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid token or user not found.' }));
                } else if (row.is_banned) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are banned.' }));
                } else if (whitelistEnabled && row.is_whitelisted !== 1) {
                    ws.send(JSON.stringify({ type: 'error', message: 'You are not whitelisted.' }));
                } else {
                    user = row.username;
                    isAdmin = row.is_admin === 1;
                    isOwner = row.is_owner === 1;
                    isMuted = row.is_muted === 1;
                    clients.set(user, ws);
                    ws.send(JSON.stringify({ type: 'login-success', id: token, isAdmin, isOwner }));
                    broadcastUserList();
                }
            });
        }

        else if (data.type === 'get-profile') {
            if (!user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
            }
            const requestedUsername = data.username || user;
            db.get(`SELECT username, bio, avatar_url FROM users WHERE username = ?`, [requestedUsername], (err, row) => {
                if (err) {
                    console.error('Error fetching profile:', err);
                    ws.send(JSON.stringify({ type: 'error', message: 'Internal server error' }));
                } else if (!row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Profile not found' }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile-data', profile: row }));
                }
            });
        }

        else if (data.type === 'update-profile') {
            if (!user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
                return;
            }
            const { bio, avatar_url } = data;
            db.run(`UPDATE users SET bio = ?, avatar_url = ? WHERE username = ?`, [bio || '', avatar_url || '', user], function(err) {
                if (err) {
                    console.error('Error updating profile:', err);
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to update profile' }));
                } else {
                    ws.send(JSON.stringify({ type: 'update-profile-success', message: 'Profile updated successfully' }));
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
                db.get(`SELECT id, avatar_url FROM users WHERE username = ?`, [user], (err, row) => {
                    if (err || !row) {
                        console.error('Error fetching user info:', err);
                        return;
                    }
                    db.run(`INSERT INTO messages (type, sender, message) VALUES (?, ?, ?)`, ['chat', user, data.message]);

                    // Broadcast to WebSocket clients
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'chat', username: user, message: data.message, avatarurl: row.avatar_url}));
                        }
                    });
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
    }); // Ensure proper closure of the WebSocket message handler
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

app.use(express.urlencoded({ extended: true }));

app.get('/invite', (req, res) => {
    const inviteToken = req.query.invite;
    if (!inviteToken) {
        return res.status(400).send('<h1>Error: Invite token is required</h1>');
    }

    // Check if invite token exists and get group ID
    groupDataDb.get(`SELECT id, name FROM groups WHERE invite_token = ?`, [inviteToken], (err, group) => {
        if (err) {
            console.error('Error fetching group by invite token:', err);
            return res.status(500).send('<h1>Internal Server Error</h1>');
        }
        if (!group) {
            return res.status(404).send('<h1>Invalid or expired invite link</h1>');
        }

        // Serve login form for invite
        return res.send(`
            <h1>Login to Join Group "${group.name}"</h1>
            <form method="POST" action="/invite?invite=${inviteToken}">
                <input type="text" name="username" placeholder="Username" required /><br/>
                <input type="password" name="password" placeholder="Password" required /><br/>
                <button type="submit">Login and Join</button>
            </form>
        `);
    });
});

app.post('/invite', (req, res) => {
    const inviteToken = req.query.invite;
    if (!inviteToken) {
        return res.status(400).send('<h1>Error: Invite token is required</h1>');
    }
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('<h1>Username and password are required</h1>');
    }

    // Authenticate user
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, row) => {
        if (err || !row) {
            return res.status(401).send('<h1>Invalid username or password</h1>');
        }
        bcrypt.compare(password, row.password, (err, result) => {
            if (result) {
                // Add user to group members if not already a member
                groupDataDb.get(`SELECT id, name FROM groups WHERE invite_token = ?`, [inviteToken], (err, group) => {
                    if (err || !group) {
                        return res.status(400).send('<h1>Invalid or expired invite token</h1>');
                    }
                    groupDataDb.get(`SELECT * FROM members WHERE username = ? AND group_id = ?`, [username, group.id], (err, member) => {
                        if (err) {
                            console.error('Error checking group membership:', err);
                            return res.status(500).send('<h1>Internal Server Error</h1>');
                        }
                        if (member) {
                            return res.send(`<h1>You are already a member of group "${group.name}"</h1>`);
                        }
                        groupDataDb.run(`INSERT INTO members (username, group_id) VALUES (?, ?)`, [username, group.id], (err) => {
                            if (err) {
                                console.error('Error adding user to group:', err);
                                return res.status(500).send('<h1>Internal Server Error</h1>');
                            }
                            res.send(`<h1>Successfully joined group "${group.name}"</h1>`);
                        });
                    });
                });
            } else {
                res.status(401).send('<h1>Invalid username or password</h1>');
            }
        });
    });
});

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
                    <p>https://${url}/users?profile=${profileId}</p>
                </div>
            </body>
            </html>
        `);
    });
});

// Serve static files from the current directory
app.use(express.static(__dirname));

server.listen(3000, () => console.log('Server running on port 3000'));

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('Port 3000 is already in use. Please free the port and try again.');
    } else {
        console.error('Server error:', err);
    }
});

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
        // case 'block':
        //     const blockTarget = args[0];
        //     if (!blockTarget) {
        //         ws.send(JSON.stringify({ type: 'error', message: 'Please specify a user to block.' }));
        //         return;
        //     }
        //     db.run(`INSERT OR IGNORE INTO blocks (blocker, blocked) VALUES (?, ?)`, [user, blockTarget], (err) => {
        //         if (err) {
        //             ws.send(JSON.stringify({ type: 'error', message: 'Failed to block user.' }));
        //         } else {
        //             ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `You have blocked ${blockTarget}.` }));
        //         }
        //     });
        //     break;
        // case 'unblock':
        //     const unblockTarget = args[0];
        //     if (!unblockTarget) {
        //         ws.send(JSON.stringify({ type: 'error', message: 'Please specify a user to unblock.' }));
        //         return;
        //     }
        //     db.run(`DELETE FROM blocks WHERE blocker = ? AND blocked = ?`, [user, unblockTarget], (err) => {
        //         if (err) {
        //             ws.send(JSON.stringify({ type: 'error', message: 'Failed to unblock user.' }));
        //         } else {
        //             ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `You have unblocked ${unblockTarget}.` }));
        //         }
        //     });
        //     break;
        //case 'profile-access':
        //    db.get(`SELECT is_user_able_to_access_profiles FROM users WHERE username = ?`, [user], (err, row) => {
        //        if (err || !row) {
        //            ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch profile access status.' }));
        //        } else {
        //            const newValue = row.is_user_able_to_access_profiles === 1 ? 0 : 1;
        //            db.run(`UPDATE users SET is_user_able_to_access_profiles = ? WHERE username = ?`, [newValue, user], (err) => {
        //                if (err) {
        //                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to update profile access.' }));
        //                } else {
        //                    ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `Your profile access is now set to ${newValue ? 'on' : 'off'}.` }));
        //                }
        //            });
        //        }
        //    });
        //    break;
        case 'profile':
            const pfusername = args[0];
            if (!pfusername) {
                ws.send(JSON.stringify({ type: 'error', message: 'Please specify a user.' }));
                return;
            }
            db.get(`SELECT id FROM users WHERE username = ?`, [pfusername], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch profile or user may not exist.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `http://${url}/users?profile=${row.id}` }));
                    ws.send(JSON.stringify({ type: 'chat', username: 'System', message: `use "/profile-view ${pfusername}" to view the profile in the popup` }));
                }
            });
            break;
        case 'profile-view':
            const pfusername2 = args[0];
            if (!pfusername2) {
                ws.send(JSON.stringify({ type: 'error', message: 'Please specify a user.' }));
                return;
            }
            db.get(`SELECT id FROM users WHERE username = ?`, [pfusername2], (err, row) => {
                if (err || !row) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch profile or user may not exist.' }));
                } else {
                    ws.send(JSON.stringify({ type: 'profile-request', profileUrl: `/users?profile=${row.id}` }));
                }
            });
            break;
        default:
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown command. Type /help for a list of commands.' }));
    }
}
