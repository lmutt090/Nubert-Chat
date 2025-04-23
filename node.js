// server.js
const WebSocket = require('ws');
const http = require('http');
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const clients = new Map(); // username => ws

function usernameToNumbers(username) {
    return username.split('').map(char => char.charCodeAt(0)).join('');
}

wss.on('connection', (ws) => {
    let user = null;

    ws.on('message', (message) => {
        let data = JSON.parse(message);

        if (data.type === 'join') {
            user = data.username;
            clients.set(user, ws);
            const id = `Nubert-${usernameToNumbers(user)}-nuberT`;
            ws.send(JSON.stringify({ type: 'id', id }));
            broadcastUserList();
        }

        else if (data.type === 'chat') {
            // Public chat
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'chat', username: user, message: data.message }));
                }
            });
        }

        else if (data.type === 'dm') {
            const target = clients.get(data.to);
            if (target && target.readyState === WebSocket.OPEN) {
                target.send(JSON.stringify({ type: 'dm', from: user, message: data.message }));
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

server.listen(3000, () => console.log('Server running on port 3000'));
