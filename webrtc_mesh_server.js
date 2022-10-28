const path = require('path');
const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');

const sslPort = 8443;
const serverConfig = {
	// SSL証明書、環境に合わせてパスを変更する
	key: fs.readFileSync('privkey.pem'),
	cert: fs.readFileSync('fullchain.pem')
};

// 接続リスト
let connections = [];

// WebSocket処理
const socketProc = function(ws, req) {
	ws._pingTimer = setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) {
			// 接続確認
			ws.send(JSON.stringify({ping: 1}));
		}
	}, 180000);

	ws.on('message', function(message) {
		const json = JSON.parse(message);
		if (json.join) {
			console.log(ws._socket.remoteAddress + ': join room=' + json.join.room + ', id=' + json.join.id);
			// 同一IDが存在するときは古い方を削除
			connections = connections.filter(data => !(data.room === json.join.room && data.id === json.join.id));
			// 接続情報を保存
			connections.push({room: json.join.room, id: json.join.id, ws: ws});
			// Roomメンバーの一覧を返す
			const member = [];
			connections.forEach(data => {
				if (data.room === json.join.room && data.id !== json.join.id && data.ws.readyState === WebSocket.OPEN) {
					member.push({id: data.id});
					// 新規参加者を通知
					data.ws.send(JSON.stringify({join: json.join.id}));
				}
			});
			ws.send(JSON.stringify({start: member}));
			return;
		}
		if (json.pong) {
			return;
		}
		if (json.ping) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({pong: 1}));
			}
			return;
		}
		// Peerを検索
		connections.some(data => {
			if (data.room === json.room && data.id === json.dest && data.ws.readyState === WebSocket.OPEN) {
				// メッセージの転送
				data.ws.send(JSON.stringify(json));
				return true;
			}
		});
	});

	ws.on('close', function () {
		closeConnection(ws);
	});

	ws.on('error', function(error) {
		closeConnection(ws);
		console.error(ws._socket.remoteAddress + ': error=' + error);
	});

	function closeConnection(conn) {
		connections = connections.filter(data => {
			if (data.ws !== conn) {
				return true;
			}
			console.log(ws._socket.remoteAddress + ': part room=' + data.room + ', id=' + data.id);
			connections.forEach(roomData => {
				if (data.room === roomData.room && data.id !== roomData.id && roomData.ws.readyState === WebSocket.OPEN) {
					// 退出を通知
					roomData.ws.send(JSON.stringify({part: 1, src: data.id}));
				}
			});
			data.ws = null;
			return false;
		});
		if (conn._pingTimer) {
			clearInterval(conn._pingTimer);
			conn._pingTimer = null;
		}
	}
};

// 静的ファイル処理
const service = function(req, res) {
	const url = req.url.replace(/\?.+$/, '');
	const file = path.join(process.cwd(), url);
	fs.stat(file, (err, stat) => {
		if (err) {
			res.writeHead(404);
			res.end();
			return;
		}
		if (stat.isDirectory()) {
			service({url: url.replace(/\/$/, '') + '/index.html'}, res);
		} else if (stat.isFile()) {
			const stream = fs.createReadStream(file);
			stream.pipe(res);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
};

// HTTPSサーバの開始
const httpsServer = https.createServer(serverConfig, service);
httpsServer.listen(sslPort, '0.0.0.0');
// WebSocketの開始
const wss = new WebSocket.Server({server: httpsServer});
wss.on('connection', socketProc);
console.log('Server running.');
