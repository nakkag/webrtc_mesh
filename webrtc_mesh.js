let localVideo;
let localId, roomId;
let sc;
let peers = new Map();

const sslPort = 8443;
const peerConnectionConfig = {
	iceServers: [
		// GoogleのパブリックSTUNサーバーを指定しているが自前のSTUNサーバーがあれば変更する
		{urls: 'stun:stun.l.google.com:19302'},
		{urls: 'stun:stun1.l.google.com:19302'},
		{urls: 'stun:stun2.l.google.com:19302'},
		// TURNサーバーがあれば指定する
		//{urls: 'turn:turn_server', username:'', credential:''}
	]
};

window.onload = function() {
	localVideo = document.getElementById('localVideo');
	localId = Math.random().toString(36).slice(-4) + '_' + new Date().getTime();
	while (!roomId) {
		roomId = window.prompt('Room ID', '');
	}
	startVideo(roomId, localId);
}

function startVideo(roomId, localId) {
	if (navigator.mediaDevices.getUserMedia) {
		if (window.stream) {
			// 既存のストリームを破棄
			try {
				window.stream.getTracks().forEach(track => {
					track.stop();
				});
			} catch(error) {
				console.error(error);
			}
			window.stream = null;
		}
		// カメラとマイクの開始
		const constraints = {
			audio: true,
			video: true
		};
		navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
			window.stream = stream;
			localVideo.srcObject = stream;
			startServerConnection(roomId, localId);
		}).catch(e => {
			alert('Camera start error.\n\n' + error);
		});
	} else {
		alert('Your browser does not support getUserMedia API');
	}
}

function startServerConnection(roomId, localId) {
	if (sc) {
		sc.close();
	}
	// サーバー接続の開始
	sc = new WebSocket('wss://' + location.hostname + ':' + sslPort + '/');
	sc.onmessage = gotMessageFromServer;
	sc.onopen = function(event) {
		// サーバーに接続情報を通知
		this.send(JSON.stringify({join: {room: roomId, id: localId}}));
	};
	sc.onclose = function(event) {
		clearInterval(this._pingTimer);
		setTimeout(function(conn) {
			if (sc === conn) {
				// 一定時間経過後にサーバーへ再接続
				startServerConnection(roomId, localId);
			}
		}, 5000, this);
	}
	sc._pingTimer = setInterval(function() {
		// 接続確認
		sc.send(JSON.stringify({ping: 1}));
	}, 30000);
}

function startPeerConnection(id) {
	if (peers.has(id)) {
		peers.get(id)._stopPeerConnection();
	}
	let pc = new RTCPeerConnection(peerConnectionConfig);
	// VIDEOタグの追加
	document.getElementById('remote').insertAdjacentHTML('beforeend', '<video id="' + id + '" playsinline autoplay></video>');
	pc._remoteVideo = document.getElementById(id);
	pc._queue = new Array();
	pc._setDescription = function(description) {
		if (pc) {
			pc.setLocalDescription(description).then(function() {
				// SDP送信
				sc.send(JSON.stringify({sdp: pc.localDescription, room: roomId, src: localId, dest: id}));
			}).catch(errorHandler);
		}
	}
	pc.onicecandidate = function(event) {
		if (event.candidate) {
			// ICE送信
			sc.send(JSON.stringify({ice: event.candidate, room: roomId, src: localId, dest: id}));
		}
	};
	if (window.stream) {
		// Local側のストリームを設定
		window.stream.getTracks().forEach(track => pc.addTrack(track, window.stream));
	}
	pc.ontrack = function(event) {
		if (pc) {
			// Remote側のストリームを設定
			if (event.streams && event.streams[0]) {
				pc._remoteVideo.srcObject = event.streams[0];
			} else {
				pc._remoteVideo.srcObject = new MediaStream(event.track);
			}
		}
	};
	pc._stopPeerConnection = function() {
		if (!pc) {
			return;
		}
		if (pc._remoteVideo && pc._remoteVideo.srcObject) {
			try {
				pc._remoteVideo.srcObject.getTracks().forEach(track => {
					track.stop();
				});
			} catch(error) {
				console.error(error);
			}
			pc._remoteVideo.srcObject = null;
		}
		if (pc._remoteVideo) {
			// VIDEOタグの削除
			pc._remoteVideo.remove();
		}
		pc.close();
		pc = null;
		peers.delete(id);
	};
	peers.set(id, pc);
	setTimeout(function() {
		if (pc && !pc.remoteDescription) {
			// Offerの作成
			pc.createOffer().then(pc._setDescription).catch(errorHandler);
		}
	}, Math.floor(Math.random() * 1000));
}

function gotMessageFromServer(message) {
	const signal = JSON.parse(message.data);
	if (signal.start) {
		// すべてのPeerとの接続を開始する
		signal.start.forEach((data) => startPeerConnection(data.id));
		return;
	}
	if (signal.join) {
		// 新規参加
		startPeerConnection(signal.join);
		return;
	}
	if (signal.ping) {
		sc.send(JSON.stringify({pong: 1}));
		return;
	}
	const pc = peers.get(signal.src);
	if (!pc) {
		return;
	}
	if (signal.part) {
		// 接続先の退出通知
		pc._stopPeerConnection();
		return;
	}
	// 以降はWebRTCのシグナリング処理
	if (signal.sdp) {
		// SDP受信
		if (pc.remoteDescription) {
			startPeerConnection(signal.src);
			return;
		}
		if (signal.sdp.type === 'offer') {
			pc.setRemoteDescription(signal.sdp).then(function() {
				// Answerの作成
				pc.createAnswer().then(pc._setDescription).catch(errorHandler);
			}).catch(errorHandler);
		} else if (signal.sdp.type === 'answer') {
			pc.setRemoteDescription(signal.sdp).catch(errorHandler);
		}
	}
	if (signal.ice) {
		// ICE受信
		if (pc.remoteDescription) {
			pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
		} else {
			// SDPが未処理のためキューに貯める
			pc._queue.push(message);
			return;
		}
	}
	if (pc._queue.length > 0 && pc.remoteDescription) {
		// キューのメッセージを再処理
		gotMessageFromServer(pc._queue.shift());
	}
}

function errorHandler(error) {
	alert('Signaling error.\n\n' + error);
}