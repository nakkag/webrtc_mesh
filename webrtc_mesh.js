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
		navigator.mediaDevices.getUserMedia(constraints).then(stream => {
			window.stream = stream;
			localVideo.srcObject = stream;
			startServerConnection(roomId, localId);
		}).catch(e => {
			alert('Camera start error.\n\n' + e.name + ': ' + e.message);
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
		setTimeout(conn => {
			if (sc === conn) {
				// 一定時間経過後にサーバーへ再接続
				startServerConnection(roomId, localId);
			}
		}, 5000, this);
	}
	sc._pingTimer = setInterval(() => {
		// 接続確認
		sc.send(JSON.stringify({ping: 1}));
	}, 30000);
}

function startPeerConnection(id, sdpType) {
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
			pc.setLocalDescription(description).then(() => {
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
	if (sdpType === 'offer') {
		// Offerの作成
		pc.createOffer().then(pc._setDescription).catch(errorHandler);
	}
}

function gotMessageFromServer(message) {
	const signal = JSON.parse(message.data);
	if (signal.start) {
		// 同じ部屋のすべてのPeerとの接続を開始する(Offer側)
		signal.start.forEach(data => startPeerConnection(data.id, 'offer'));
		return;
	}
	if (signal.join) {
		// 新規参加者通知(Answer側)
		startPeerConnection(signal.join, 'answer');
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
		// 退出通知
		pc._stopPeerConnection();
		return;
	}
	// 以降はWebRTCのシグナリング処理
	if (signal.sdp) {
		// SDP受信
		if (signal.sdp.type === 'offer') {
			pc.setRemoteDescription(signal.sdp).then(() => {
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
			pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(e => {
				pc._queue = new Array();
				errorHandler(e);
			});
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
	alert('Signaling error.\n\n' + error.name + ': ' + error.message);
}
